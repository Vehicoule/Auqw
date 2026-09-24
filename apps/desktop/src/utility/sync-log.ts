import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  truncate,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  appError,
  err,
  fromUnknown,
  isChangeEntry,
  isDivergenceEntry,
  isSyncCursor,
  ok,
} from '@auqw/application';
import type {
  ChangeEntry,
  DivergenceEntry,
  OperationContext,
  Result,
  SyncLogSnapshot,
  SyncLogStore,
  SyncLogWrite,
} from '@auqw/application';
import { isRecord } from '../shared/check.ts';

/**
 * The desktop's `SyncLogStore` backing — a JSONL file under userData.
 *
 * A domain-db table was the other candidate; it loses on two grounds.
 * The sync tables don't exist in the sqlite schema yet (a migration +
 * `KNOWN_TABLES` addition is its own leg), and boot order makes the
 * file unsafe anyway: the utility could create sync tables in a v0 db
 * before the renderer's storage layer ever migrates it, after which
 * SqliteStorage rejects its own file as foreign. A bounded append-only
 * file has neither problem and keeps the engine's durability contract
 * exactly: append, fsync, fold on load.
 *
 * Layout: line 1 is a header `{"v":1,"deviceId":"dsk-…"}` minted at
 * create; every later line is one serialized `SyncLogWrite`. `load`
 * re-scans and folds — entries and divergence concatenate, watermarks
 * take the per-device max, `dropDivergenceBefore` accumulates as the
 * cumulative floor. The device id lives in the header because its
 * durability horizon IS the log it stamps: a fresh log must never
 * attribute entries to a device that already lost them, so a new file
 * mints a new id rather than reusing a stale one from a second store.
 */

const HEADER_VERSION = 1;
const DEVICE_PREFIX = 'dsk-';
/** `dsk-` + 32 hex — fits isDeviceId's `{7,63}` and MAX_DEVICE_ID. */
const DEVICE_HEX = 32;
const MAX_DEVICE_ID = 128;
/**
 * The bound every serialized write line must fit, shared by writer and
 * reader so a successful append can never be truncated as corrupt on
 * the next open. Sizing: the `sync:localChanges` channel admits
 * 256 writes x 64 KiB field values (~17 MiB serialized once the engine
 * stamps entries), and a socket-applied delta is capped by
 * MAX_SYNC_DOC_BYTES (1 MiB). 20 MiB covers both producers with margin.
 */
const MAX_LINE_BYTES = 20 * 1_048_576;

export type OpenedSyncLog = {
  readonly store: SyncLogStore;
  /** The id this log minted or carries — the engine's deviceId. */
  readonly deviceId: string;
  /** True when open repaired the file (torn tail or foreign header). */
  readonly repaired: boolean;
};

function mintDeviceId(): string {
  return `${DEVICE_PREFIX}${randomBytes(DEVICE_HEX / 2).toString('hex')}`;
}

function isHeader(value: unknown): value is { v: number; deviceId: string } {
  return (
    isRecord(value) &&
    value['v'] === HEADER_VERSION &&
    typeof value['deviceId'] === 'string' &&
    value['deviceId'].startsWith(DEVICE_PREFIX) &&
    value['deviceId'].length >= DEVICE_PREFIX.length + 8 &&
    value['deviceId'].length <= MAX_DEVICE_ID
  );
}

/**
 * A stored write line must parse to the SyncLogWrite shape — every
 * field is optional in the port; a malformed one marks corruption.
 */
function isWriteDoc(value: unknown): value is SyncLogWrite {
  if (!isRecord(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== 'entries' &&
      key !== 'divergence' &&
      key !== 'watermarks' &&
      key !== 'dropDivergenceBefore'
    ) {
      return false;
    }
  }
  if (
    value['entries'] !== undefined &&
    (!Array.isArray(value['entries']) || !value['entries'].every(isChangeEntry))
  ) {
    return false;
  }
  if (
    value['divergence'] !== undefined &&
    (!Array.isArray(value['divergence']) ||
      !value['divergence'].every(isDivergenceEntry))
  ) {
    return false;
  }
  if (
    value['watermarks'] !== undefined &&
    !isSyncCursor(value['watermarks'])
  ) {
    return false;
  }
  if (
    value['dropDivergenceBefore'] !== undefined &&
    !(
      typeof value['dropDivergenceBefore'] === 'number' &&
      Number.isSafeInteger(value['dropDivergenceBefore']) &&
      value['dropDivergenceBefore'] >= 0
    )
  ) {
    return false;
  }
  return true;
}

type Parsed =
  | {
      readonly ok: true;
      readonly deviceId: string;
      readonly snapshot: SyncLogSnapshot;
    }
  | {
      readonly ok: false;
      /** Byte offset of the first bad line; -1 = bad header. */
      readonly truncateAt: number;
    };

/**
 * Split the file on '\n', carrying each line's byte offset so a repair
 * can truncate at the first invalid line — a torn tail then loses only
 * the uncommitted suffix, and mid-file corruption stops at the same
 * honest boundary rather than guessing.
 */
function parseFile(raw: string): Parsed {
  const entries: ChangeEntry[] = [];
  const divergence: DivergenceEntry[] = [];
  const watermarks: Record<string, number> = {};
  let floor = 0;
  let offset = 0;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (line.length === 0) {
      // Only the trailing newline tail may be empty — a mid-file
      // blank is corruption, not layout.
      if (i !== lines.length - 1) {
        return { ok: false, truncateAt: lineStart };
      }
      break;
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return { ok: false, truncateAt: lineStart };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, truncateAt: lineStart };
    }
    if (i === 0) {
      if (!isHeader(parsed)) {
        return { ok: false, truncateAt: -1 };
      }
      continue;
    }
    if (!isWriteDoc(parsed)) {
      return { ok: false, truncateAt: lineStart };
    }
    const write = parsed;
    for (const entry of write.entries ?? []) {
      entries.push(entry);
    }
    if (write.dropDivergenceBefore !== undefined) {
      floor = Math.max(floor, write.dropDivergenceBefore);
    }
    for (const row of write.divergence ?? []) {
      divergence.push(row);
    }
    for (const [device, mark] of Object.entries(write.watermarks ?? {})) {
      watermarks[device] = Math.max(watermarks[device] ?? 0, mark);
    }
  }
  let deviceId: string;
  try {
    const header: unknown = JSON.parse(lines[0] ?? '');
    deviceId = isHeader(header) ? header.deviceId : '';
  } catch {
    deviceId = '';
  }
  const kept = divergence.filter((row) => row.seq >= floor);
  return {
    ok: true,
    deviceId,
    snapshot: {
      entries,
      divergence: kept,
      watermarks,
      ...(floor > 0 ? { divergenceFloor: floor } : {}),
    },
  };
}

async function writeHeader(path: string, deviceId: string): Promise<void> {
  const line = `${JSON.stringify({ v: HEADER_VERSION, deviceId })}\n`;
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The live store: each append serializes one line through a promise
 * chain (the port sees a queue, never interleaved writes), appends,
 * then fsyncs before resolving — a torn tail is the only failure that
 * survives a crash, and `open` repairs it. `load` re-reads the file so
 * a repair in flight is observed by the next reader.
 */
function createStore(path: string): SyncLogStore {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async load(
      _context: OperationContext,
    ): Promise<Result<SyncLogSnapshot>> {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (thrown) {
        return err(fromUnknown(thrown));
      }
      const parsed = parseFile(raw);
      if (!parsed.ok) {
        return err(
          appError(
            'invalid-response',
            'sync log unreadable — reopen to repair',
          ),
        );
      }
      return ok(parsed.snapshot);
    },
    append(
      write: SyncLogWrite,
      context: OperationContext,
    ): Promise<Result<void>> {
      if (context.signal.cancelled) {
        return Promise.resolve(err(appError('cancelled', 'cancelled')));
      }
      const line = `${JSON.stringify(write)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        // The reader rejects a line over this bound as corrupt — write
        // nothing it would truncate on next open.
        return Promise.resolve(
          err(
            appError(
              'invalid-response',
              'sync write exceeds the durable line bound',
            ),
          ),
        );
      }
      const run = tail.then(async (): Promise<Result<void>> => {
        // Recheck after acquiring the serialized turn — the engine can
        // resolve 'cancelled' while this append still queued behind a
        // sibling; a cancelled write must never become durable.
        if (context.signal.cancelled) {
          return err(appError('cancelled', 'cancelled'));
        }
        let handle;
        try {
          await appendFile(path, line, 'utf8');
          handle = await open(path, 'r');
          await handle.sync();
        } catch (thrown) {
          return err(fromUnknown(thrown));
        } finally {
          if (handle !== undefined) {
            await handle.close().catch(() => undefined);
          }
        }
        return ok(undefined);
      });
      // The chain must absorb failures — a rejected tail would make
      // every later append reject too.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/**
 * Open (or create) the JSONL sync log at `path`. Never throws — the
 * port's contract. A missing file is minted with a header; a readable
 * file is parsed and folded; a torn tail is truncated at the first
 * invalid line; a foreign file (unreadable header) is renamed aside
 * (`<name>.corrupt-<ms>`) and a fresh log minted — the new device id
 * is honest there since the old log's entries are gone anyway.
 */
export async function openSyncLogStore(
  path: string,
): Promise<Result<OpenedSyncLog>> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (thrown) {
    return err(fromUnknown(thrown));
  }
  let exists = true;
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    exists = false;
  }

  if (!exists) {
    const deviceId = mintDeviceId();
    try {
      await writeHeader(path, deviceId);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    return ok({ store: createStore(path), deviceId, repaired: false });
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (thrown) {
    return err(fromUnknown(thrown));
  }
  const parsed = parseFile(raw);
  if (parsed.ok) {
    return ok({
      store: createStore(path),
      deviceId: parsed.deviceId,
      repaired: false,
    });
  }
  // Repair: a foreign file (bad header) moves aside wholesale; a
  // truncatable tail is cut at the first bad line — both leave a
  // valid file behind.
  if (parsed.truncateAt >= 0) {
    const deviceId = headerDeviceId(raw);
    if (deviceId !== null) {
      try {
        await truncate(path, parsed.truncateAt);
      } catch (thrown) {
        return err(fromUnknown(thrown));
      }
      return ok({ store: createStore(path), deviceId, repaired: true });
    }
  }
  const deviceId = mintDeviceId();
  try {
    await rename(path, `${path}.corrupt-${Date.now()}`);
    await writeHeader(path, deviceId);
  } catch (thrown) {
    return err(fromUnknown(thrown));
  }
  return ok({ store: createStore(path), deviceId, repaired: true });
}

function headerDeviceId(raw: string): string | null {
  const first = raw.split('\n', 1)[0] ?? '';
  try {
    const parsed: unknown = JSON.parse(first);
    return isHeader(parsed) ? parsed.deviceId : null;
  } catch {
    return null;
  }
}
