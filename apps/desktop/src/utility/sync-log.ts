import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  truncate,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  appError,
  err,
  fromUnknown,
  isChangeEntry,
  isDivergenceEntry,
  isPeerMarks,
  isSyncCursor,
  ok,
} from '@auqw/application';
import type {
  ChangeEntry,
  DivergenceEntry,
  OperationContext,
  Result,
  SyncCursor,
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
/** Entries/divergence chunk size when a checkpoint rewrites the file. */
const REWRITE_CHUNK_BYTES = 1_048_576;
/** Temp sibling a checkpoint materializes before its atomic rename. */
const REWRITE_SUFFIX = '.rewrite';

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
      key !== 'dropDivergenceBefore' &&
      key !== 'dropEntries' &&
      key !== 'divergenceReplayOffset' &&
      key !== 'divergenceDroppedEmissions' &&
      key !== 'peerMarks'
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
  if (
    value['dropEntries'] !== undefined &&
    !(
      Array.isArray(value['dropEntries']) &&
      value['dropEntries'].every(
        (drop) =>
          isRecord(drop) &&
          typeof drop['deviceId'] === 'string' &&
          typeof drop['seq'] === 'number' &&
          Number.isSafeInteger(drop['seq']) &&
          drop['seq'] >= 0,
      )
    )
  ) {
    return false;
  }
  if (
    value['divergenceReplayOffset'] !== undefined &&
    !(
      typeof value['divergenceReplayOffset'] === 'number' &&
      Number.isSafeInteger(value['divergenceReplayOffset']) &&
      value['divergenceReplayOffset'] >= 0
    )
  ) {
    return false;
  }
  if (
    value['divergenceDroppedEmissions'] !== undefined &&
    !(
      Array.isArray(value['divergenceDroppedEmissions']) &&
      value['divergenceDroppedEmissions'].every(
        (emission) =>
          typeof emission === 'number' &&
          Number.isSafeInteger(emission) &&
          emission >= 1,
      )
    )
  ) {
    return false;
  }
  if (
    value['peerMarks'] !== undefined &&
    !isPeerMarks(value['peerMarks'])
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
  let entries: ChangeEntry[] = [];
  const divergence: DivergenceEntry[] = [];
  const watermarks: Record<string, number> = {};
  // A Map — not a plain record — so a sender literally named
  // `__proto__` folds as data, not a prototype write.
  const peerMarks = new Map<string, SyncCursor>();
  let floor = 0;
  let replayOffset = 0;
  const droppedEmissions = new Set<number>();
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
    // A writer commits `line + '\n'` before fsync — a non-empty FINAL
    // line is a torn write whose terminator never landed. It parses,
    // but treating it as durable would admit a write the fsync never
    // covered. (A lone first line drops to 'foreign' — repair renames
    // it aside rather than truncating to an empty, headerless file.)
    if (i === lines.length - 1) {
      return { ok: false, truncateAt: i === 0 ? -1 : lineStart };
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
    if (write.dropEntries !== undefined && write.dropEntries.length > 0) {
      // Compaction drops apply in write order — a seq dropped here
      // may legitimately re-append on a later line (a redelivery),
      // so the fold cannot defer this filter to the end.
      const dropped = new Set(
        write.dropEntries.map((drop) => `${drop.deviceId} ${drop.seq}`),
      );
      entries = entries.filter(
        (entry) => !dropped.has(`${entry.deviceId} ${entry.seq}`),
      );
    }
    if (write.divergenceReplayOffset !== undefined) {
      replayOffset = Math.max(replayOffset, write.divergenceReplayOffset);
    }
    for (const emission of write.divergenceDroppedEmissions ?? []) {
      droppedEmissions.add(emission);
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
    for (const [sender, marks] of Object.entries(write.peerMarks ?? {})) {
      // Per-sender row replace — the write carries the whole folded
      // row, so a regressed claim clears what was stored wholesale.
      peerMarks.set(sender, marks);
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
      ...(replayOffset > 0 ? { divergenceReplayOffset: replayOffset } : {}),
      ...(droppedEmissions.size > 0
        ? {
          divergenceDroppedEmissions: [...droppedEmissions].sort(
            (a, b) => a - b,
          ),
        }
        : {}),
      ...(peerMarks.size > 0
        ? { peerMarks: Object.fromEntries(peerMarks) }
        : {}),
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
 * Serialize a folded snapshot back into commit-order lines — header,
 * then entries/divergence in chunks sized well under MAX_LINE_BYTES,
 * then a metadata line carrying watermarks and both cumulative
 * scalars (`dropDivergenceBefore`, `divergenceReplayOffset`). Fold
 * order makes this safe: entries concatenate, marks max-fold, the
 * dropped-emission set union-folds, and the floor applies globally
 * regardless of which line carries it.
 */
function serializeSnapshot(
  deviceId: string,
  snapshot: SyncLogSnapshot,
): string {
  const lines: string[] = [JSON.stringify({ v: HEADER_VERSION, deviceId })];
  const chunk = <T>(
    items: readonly T[],
    key: 'entries' | 'divergence' | 'divergenceDroppedEmissions',
  ) => {
    let pending: T[] = [];
    let bytes = 0;
    const flush = () => {
      if (pending.length > 0) {
        lines.push(JSON.stringify({ [key]: pending }));
        pending = [];
        bytes = 0;
      }
    };
    for (const item of items) {
      const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (bytes + size > REWRITE_CHUNK_BYTES) {
        flush();
      }
      pending.push(item);
      bytes += size;
    }
    flush();
  };
  chunk(snapshot.entries, 'entries');
  chunk(snapshot.divergence, 'divergence');
  chunk(snapshot.divergenceDroppedEmissions ?? [], 'divergenceDroppedEmissions');
  lines.push(
    JSON.stringify({
      watermarks: snapshot.watermarks,
      ...(snapshot.divergenceFloor !== undefined &&
        snapshot.divergenceFloor > 0
          ? { dropDivergenceBefore: snapshot.divergenceFloor }
          : {}),
      ...(snapshot.divergenceReplayOffset !== undefined &&
        snapshot.divergenceReplayOffset > 0
          ? { divergenceReplayOffset: snapshot.divergenceReplayOffset }
          : {}),
    }),
  );
  // Peer-mark rows serialize one sender per line: the load fold is
  // per-sender replace, so split lines carry identical state while
  // each stays far under MAX_LINE_BYTES — the aggregated table is the
  // one field sized senders x sources, which a single line could push
  // past the reader's bound and get truncated as corruption on reopen.
  for (const [sender, marks] of Object.entries(snapshot.peerMarks ?? {})) {
    lines.push(JSON.stringify({ peerMarks: { [sender]: marks } }));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Crash-safe compaction of the file itself: fold the just-appended
 * log and swap in a rewritten copy holding only live state. Write the
 * temp sibling, fsync, atomic rename, then best-effort dir fsync. A
 * crash before the rename leaves the pre-compaction file — correct,
 * merely uncompacted — and a crash mid-rename is impossible (rename
 * is atomic); a leftover temp sibling is inert and cleaned on open.
 */
async function checkpoint(
  path: string,
  deviceId: string,
): Promise<Result<void>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (thrown) {
    return err(fromUnknown(thrown));
  }
  const parsed = parseFile(raw);
  if (!parsed.ok) {
    return err(appError('invalid-response', 'sync log failed to refold'));
  }
  const body = serializeSnapshot(deviceId, parsed.snapshot);
  for (const line of body.split('\n')) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      // An over-bound line would parse as corruption on reopen and
      // repair would truncate it — refuse the rewrite instead and
      // leave the uncompacted (still valid) file in place.
      return err(
        appError(
          'invalid-response',
          'sync log snapshot exceeds the durable line bound',
        ),
      );
    }
  }
  const tmp = `${path}${REWRITE_SUFFIX}`;
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (thrown) {
    return err(fromUnknown(thrown));
  }
  try {
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Directory fsync is best-effort durability — the rename is
    // already committed and the temp sibling is cleaned on open.
  }
  return ok(undefined);
}

/**
 * The live store: each append serializes one line through a promise
 * chain (the port sees a queue, never interleaved writes), appends,
 * then fsyncs before resolving — a torn tail is the only failure that
 * survives a crash, and `open` repairs it. `load` re-reads the file so
 * a repair in flight is observed by the next reader.
 *
 * A write carrying `dropEntries` additionally checkpoints: without a
 * rewrite the fold would only shrink the in-memory snapshot while the
 * file — and every reopen's parse — kept growing. The checkpoint runs
 * inside the same serialized turn, so it always observes this write.
 *
 * Serialization is per PATH, not per handle (`pathTails` below): two
 * stores opened on the same file share one queue, so a checkpoint's
 * read→rename can't run between another handle's append and its
 * fsync — every committed line is present in the fold a rename
 * installs. A second WRITER PROCESS would still need a lockfile;
 * plain appends already assume single-writer, so checkpoint does too.
 */
const pathTails = new Map<string, Promise<unknown>>();

function createStore(path: string, deviceId: string): SyncLogStore {
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
      const run = (pathTails.get(path) ?? Promise.resolve()).then(
        async (): Promise<Result<void>> => {
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
        if (write.dropEntries !== undefined && write.dropEntries.length > 0) {
          // The append already committed — a checkpoint failure leaves
          // a correct (uncompacted) file, so report success and let a
          // later compaction retry the rewrite.
          await checkpoint(path, deviceId);
        }
        return ok(undefined);
      });
      // The chain must absorb failures — a rejected tail would make
      // every later append reject too.
      pathTails.set(
        path,
        run.then(
          () => undefined,
          () => undefined,
        ),
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

  // A checkpoint that crashed before rename leaves an inert temp
  // sibling — remove it so the directory doesn't collect one per crash.
  await rm(`${path}${REWRITE_SUFFIX}`, { force: true }).catch(
    () => undefined,
  );

  if (!exists) {
    const deviceId = mintDeviceId();
    try {
      await writeHeader(path, deviceId);
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    return ok({ store: createStore(path, deviceId), deviceId, repaired: false });
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
      store: createStore(path, parsed.deviceId),
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
      return ok({ store: createStore(path, deviceId), deviceId, repaired: true });
    }
  }
  const deviceId = mintDeviceId();
  try {
    await rename(path, `${path}.corrupt-${Date.now()}`);
    await writeHeader(path, deviceId);
  } catch (thrown) {
    return err(fromUnknown(thrown));
  }
  return ok({ store: createStore(path, deviceId), deviceId, repaired: true });
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
