import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, hasOnlyKeys, isRecord } from '../shared/check.ts';
import { isShellError, shellError } from '../shared/errors.ts';
import type { SecureStore } from './secure-store.ts';
import { isSyncIdentity, type SyncIdentity } from '../utility/sync-crypto.ts';
import {
  isSyncDeviceRecord,
  isSyncKeysOp,
  MAX_SYNC_DEVICES,
  type SyncDeviceRecord,
  type SyncKeysOp,
} from '../utility/sync-keys.ts';

/**
 * The `sync:keys` service — the main-process half of the pairing key
 * custody channel. The utility process owns the listener and the
 * handshake but cannot reach Electron's `safeStorage`, so all key
 * material lives here as ONE SecureStore entry: `auqw.sync.store`
 * holds `{v, identity, devices[]}` as a single encrypted JSON blob.
 * Every decryptString on macOS can fire a Keychain ACL prompt, so
 * consolidating N+1 records into one bounds a boot to a single prompt;
 * the handler then serves every op from the decrypted in-memory state.
 *
 * Device records' public fields also mirror to plaintext
 * `auqw.sync.devices.json` so the armed-boot gate (and nothing else)
 * answers without decrypting — custody reads always come from the
 * sealed blob, since a plaintext-served registry would let a bare file
 * write implant a pairing. When safeStorage has no OS backend every op
 * fails `unavailable` — pairing never falls back to plaintext keys.
 */

const STORE_KEY = 'auqw.sync.store';
const MIRROR_FILE = 'auqw.sync.devices.json';
// Pre-consolidation layout — read once by the upgrade merge.
const IDENTITY_KEY = 'auqw.sync.identity';
const DEVICE_PREFIX = 'auqw.sync.device.';

/**
 * Paired-device records mark an install that actually synced — a
 * generated identity alone does not (the utility mints one the first
 * time sync starts, so it can't distinguish "paired" from "looked at
 * settings once"). main forks the utility with AUQW_SYNC_ARMED from
 * this so a never-paired install stays dormant — no listener bind,
 * no safeStorage/keychain touch — until an explicit sync action.
 *
 * The consolidated store's sealed blob can't be inspected without
 * decrypting, so the gate reads the plaintext mirror instead; a
 * missing mirror falls through to the pre-consolidation file scan, and
 * an unparseable one arms conservatively — wrongly dormant strands
 * pairings, wrongly armed only costs custody's typed error.
 */
export function syncHasPairedDevices(dir: string): boolean {
  try {
    const path = join(dir, MIRROR_FILE);
    const stat = statSync(path);
    // The mirror is a bounded write (≤64 small records) — a giant or
    // non-regular file can't be ours to parse, and a sync read in main
    // must never stall on one. Arm and let custody answer typed.
    if (!stat.isFile() || stat.size > 256 * 1024) {
      return true;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const devices = isRecord(parsed) ? parsed['devices'] : undefined;
    if (!Array.isArray(devices) || devices.length > 0) {
      return true;
    }
    // Verifiably empty — but a legacy record orphaned mid-merge (or by
    // a refused Keychain prompt) still means "paired", so the scan
    // below gets the last word.
  } catch (thrown) {
    if (errorCode(thrown) !== 'ENOENT') {
      return true;
    }
  }
  try {
    return readdirSync(dir).some(
      (file) => file.startsWith(DEVICE_PREFIX) && file.endsWith('.b64'),
    );
  } catch {
    // Missing/unreadable dir means nothing to migrate or arm.
    return false;
  }
}

const SYNC_KEY_PREFIX = 'auqw.sync.';
/**
 * Marks a completed custody migration inside `sync-secure`. Without it
 * the pass re-runs every boot — and a renderer-minted `auqw.sync.*`
 * file planted through `secure:set` would be promoted into custody on
 * the next one. Written only after a pass completes so a failed boot
 * still retries; a missing sentinel on a dead-write just re-scans.
 */
const CUSTODY_MIGRATED = '.custody-migrated';

/**
 * One-time custody move: builds before the `sync-secure` dir existed
 * stored sync entries next to renderer-reachable keys. Relocating the
 * ciphertext files preserves pairings across the upgrade — nothing is
 * decrypted, so a plain rename carries each entry. Existing entries in
 * the destination win; a partially migrated earlier boot just
 * continues. A failed read of the old dir means a pre-split install
 * never paired — nothing to move.
 */
export async function migrateSyncCustody(
  fromDir: string,
  toDir: string,
): Promise<void> {
  // The custody dir is created lazily by the store's first set — on a
  // first-boot-after-upgrade nothing has made it yet, and a rename
  // into a missing dir would silently skip every eligible entry.
  await mkdir(toDir, { recursive: true });
  try {
    await access(join(toDir, CUSTODY_MIGRATED));
    return;
  } catch (thrown) {
    if (errorCode(thrown) !== 'ENOENT') {
      throw shellError('io-error', 'sync key migration failed');
    }
  }
  let files: string[];
  try {
    files = await readdir(fromDir);
  } catch (thrown) {
    if (errorCode(thrown) === 'ENOENT') {
      files = [];
    } else {
      throw shellError('io-error', 'legacy secure dir could not be listed');
    }
  }
  for (const file of files) {
    if (!file.startsWith(SYNC_KEY_PREFIX) || !file.endsWith('.b64')) {
      continue;
    }
    const dest = join(toDir, file);
    try {
      // Destination wins: rename would silently overwrite on POSIX, so
      // check first — a partially migrated earlier boot must not
      // clobber what the new custody dir already holds.
      await access(dest);
      continue;
    } catch (thrown) {
      if (errorCode(thrown) !== 'ENOENT') {
        throw shellError('io-error', 'sync key migration failed');
      }
    }
    try {
      await rename(join(fromDir, file), dest);
    } catch (thrown) {
      if (errorCode(thrown) !== 'ENOENT') {
        throw shellError('io-error', 'sync key migration failed');
      }
    }
  }
  // Mark only after the full pass — a dead write re-scans harmlessly
  // next boot; a marked failure would strand unmigrated pairings.
  await writeFile(join(toDir, CUSTODY_MIGRATED), '', 'utf8').catch(
    () => undefined,
  );
}

/** The sealed blob's plaintext shape — one record per install. */
type SyncStoreState = {
  identity: SyncIdentity | null;
  devices: SyncDeviceRecord[];
};

function isSyncStoreBlob(value: unknown): value is SyncStoreState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['v', 'identity', 'devices']) &&
    value['v'] === 1 &&
    (value['identity'] === null || isSyncIdentity(value['identity'])) &&
    Array.isArray(value['devices']) &&
    // An over-cap blob can never be served — the device-list result
    // validator bounds it — so the whole record fails validation
    // rather than wedging every list call.
    value['devices'].length <= MAX_SYNC_DEVICES &&
    value['devices'].every(isSyncDeviceRecord)
  );
}

export function createSyncKeysHandler(deps: {
  secure: SecureStore;
  /** The SecureStore directory — the plaintext mirror lives beside it. */
  dir: string;
}): (args: unknown) => Promise<unknown> {
  const { secure, dir } = deps;

  // Decrypted once per process: custody ops serve this snapshot and
  // mutations publish a fresh one only after the blob + mirror land.
  let current: SyncStoreState | null = null;
  let loading: Promise<SyncStoreState> | null = null;
  // Pre-consolidation files that failed to decrypt at load — reported
  // as `skipped`, kept on disk, retried on the next boot.
  let pendingLegacy = 0;
  let mirrorSeq = 0;
  // Set when a mirror write fails after the sealed blob is durable —
  // the next custody op retries the heal rather than reporting a
  // committed mutation as failed.
  let mirrorDirty = false;

  function mirrorContent(devices: readonly SyncDeviceRecord[]): string {
    return JSON.stringify({ v: 1, devices });
  }

  /**
   * The plaintext device mirror — tmp + rename publish, same as the
   * store's own staging. Written on every persist and healed on load
   * so the armed-boot gate can never drift from the sealed registry.
   */
  async function writeMirror(
    devices: readonly SyncDeviceRecord[],
  ): Promise<void> {
    const target = join(dir, MIRROR_FILE);
    mirrorSeq += 1;
    const staging = `${target}.${process.pid}.${mirrorSeq}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(staging, mirrorContent(devices), 'utf8');
      await rename(staging, target);
    } catch {
      await unlink(staging).catch(() => undefined);
      throw shellError(
        'io-error',
        'sync device mirror could not be written',
      );
    }
  }

  /**
   * Best-effort mirror maintenance: skip the write entirely when the
   * file on disk already matches the sealed registry, swallow a failed
   * write into `mirrorDirty` for the next op to retry. Custody reads
   * must never fail just because this derived file can't be written.
   */
  async function healMirror(
    devices: readonly SyncDeviceRecord[],
  ): Promise<void> {
    try {
      if (!mirrorDirty) {
        const onDisk = await readFile(join(dir, MIRROR_FILE), 'utf8').catch(
          () => null,
        );
        if (onDisk === mirrorContent(devices)) {
          return;
        }
      }
      await writeMirror(devices);
      mirrorDirty = false;
    } catch {
      mirrorDirty = true;
    }
  }

  /**
   * Commit a new registry state — sealed blob + plaintext mirror, then
   * publish to memory. Write order picks the harmless failure: gaining
   * the first device writes the mirror FIRST, so a dead blob write
   * arms one extra boot (the next load heals the mirror back) instead
   * of stranding a committed pairing behind a dormant gate; every
   * other transition writes the blob first, where a stale mirror at
   * worst does the same.
   */
  async function persist(
    prev: SyncStoreState,
    next: SyncStoreState,
  ): Promise<void> {
    const gaining =
      prev.devices.length === 0 && next.devices.length > 0;
    if (gaining) {
      await writeMirror(next.devices);
    }
    await secure.set(
      STORE_KEY,
      JSON.stringify({
        v: 1,
        identity: next.identity,
        devices: next.devices,
      }),
    );
    // The sealed registry is durable — publish before the mirror write
    // so a mirror failure can't leave memory disagreeing with disk.
    current = next;
    if (!gaining) {
      // The mutation is already committed — a failed mirror write is
      // marked dirty for the next op to heal, never reported as a
      // failed mutation.
      await healMirror(next.devices);
    }
  }

  /**
   * Fold pre-consolidation entries into the state: the identity under
   * `auqw.sync.identity`, one device record per `auqw.sync.device.<id>`
   * file. A record that fails to decrypt keeps its file and retries on
   * the next boot — a refused macOS Keychain prompt reads the same as
   * torn ciphertext, and neither may quietly drop a pairing. Records
   * that decrypt but don't validate are dead weight: consumed so they
   * stop re-prompting. The blob stays authoritative — a legacy entry
   * colliding with a sealed id/fp retires, never overwrites.
   * Returns the keys whose entries merged or were unusable; the caller
   * deletes them only after the state is durable.
   */
  async function mergeLegacy(state: SyncStoreState): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (thrown) {
      if (errorCode(thrown) === 'ENOENT') {
        return [];
      }
      throw shellError('io-error', 'secure dir could not be listed');
    }
    const consumed: string[] = [];
    pendingLegacy = 0;
    for (const file of files) {
      const isIdentity = file === `${IDENTITY_KEY}.b64`;
      const isDevice =
        file.startsWith(DEVICE_PREFIX) && file.endsWith('.b64');
      if (!isIdentity && !isDevice) {
        continue;
      }
      const key = file.slice(0, -'.b64'.length);
      let raw: string | null;
      try {
        raw = await secure.get(key);
      } catch (thrown) {
        // A dead encryption backend is systemic — surface it rather
        // than merge a partial registry over unreadable entries.
        if (isShellError(thrown) && thrown.kind === 'unavailable') {
          throw thrown;
        }
        pendingLegacy += 1;
        continue;
      }
      if (raw === null) {
        continue; // vanished between readdir and get — nothing to merge
      }
      let record: unknown = null;
      try {
        record = JSON.parse(raw);
      } catch {
        // falls to the unusable-record branch below
      }
      if (isIdentity) {
        if (isSyncIdentity(record) && state.identity === null) {
          state.identity = record;
        }
        consumed.push(key);
      } else if (isSyncDeviceRecord(record)) {
        if (
          state.devices.some((d) => d.id === record.id || d.fp === record.fp)
        ) {
          // Blob wins — a stale same-id/same-fp duplicate retires.
          consumed.push(key);
        } else if (state.devices.length >= MAX_SYNC_DEVICES) {
          // A full registry can't take it — keep the file for a boot
          // where there's room rather than seal an over-cap blob.
          pendingLegacy += 1;
        } else {
          state.devices.push(record);
          consumed.push(key);
        }
      } else {
        consumed.push(key);
      }
    }
    return consumed;
  }

  async function loadOnce(): Promise<SyncStoreState> {
    // The ONE decrypt an armed boot needs — every later custody op
    // serves the in-memory snapshot.
    const text = await secure.get(STORE_KEY);
    const prev: SyncStoreState = { identity: null, devices: [] };
    if (text !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw shellError('corrupt-state', 'sync store is not json');
      }
      if (!isSyncStoreBlob(parsed)) {
        throw shellError('corrupt-state', 'sync store failed validation');
      }
      prev.identity = parsed.identity;
      prev.devices = parsed.devices;
    }
    const state: SyncStoreState = {
      identity: prev.identity,
      devices: [...prev.devices],
    };
    const consumed = await mergeLegacy(state);
    const changed =
      consumed.length > 0 &&
      (state.identity !== prev.identity ||
        state.devices.length !== prev.devices.length);
    if (changed) {
      // Seal before consuming the legacy files — a crash between blob
      // write and cleanup just re-merges the same records (deduped).
      await persist(prev, state);
    } else {
      // Nothing merged — heal the mirror only if it's missing or
      // stale, so a pure read never needs the directory to be writable.
      await healMirror(state.devices);
    }
    for (const key of consumed) {
      await secure.delete(key).catch(() => undefined);
    }
    return state;
  }

  async function load(): Promise<SyncStoreState> {
    if (current === null) {
      // Failed loads aren't memoized — a recoverable failure (backend
      // hiccup, transient io) retries on the next op instead of being
      // sticky for the process's life.
      loading ??= loadOnce().then(
        (state) => {
          current = state;
          loading = null;
          return state;
        },
        (thrown: unknown) => {
          loading = null;
          throw thrown;
        },
      );
      await loading;
    }
    const state = current as SyncStoreState;
    await healMirror(state.devices);
    return state;
  }

  // Registry mutations serialize behind one promise chain: the
  // cap-check → fp-dedupe → persist sequence is a single logical
  // transaction, and two concurrent puts must not both observe room
  // for a 65th record or overwrite each other's committed state.
  let registryChain: Promise<void> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = registryChain.then(fn);
    registryChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return async (args: unknown) => {
    if (!isSyncKeysOp(args)) {
      throw shellError('invalid-request', 'sync:keys bad op');
    }
    const op: SyncKeysOp = args;
    switch (op.op) {
      case 'identity-get':
        return { identity: (await load()).identity };
      case 'identity-set':
        return serialized(async () => {
          const s = await load();
          if (s.identity !== null) {
            // Rotation orphans every pairing — refuse silently swapping.
            throw shellError(
              'invalid-request',
              'sync identity already installed',
            );
          }
          await persist(s, {
            identity: op.identity,
            devices: s.devices,
          });
          return null;
        });
      case 'identity-replace':
        return serialized(async () => {
          let s: SyncStoreState;
          try {
            s = await load();
          } catch (thrown) {
            // Recovery/rotation over a corrupt blob is exactly what
            // this op exists for — unwedge with an empty registry
            // rather than fail on the broken record it's replacing.
            // Leftover pre-consolidation files still merge on the next
            // load, so replaceable pairings aren't lost. A dead
            // backend stays fatal: the write would fail anyway.
            if (!isShellError(thrown) || thrown.kind !== 'corrupt-state') {
              throw thrown;
            }
            s = { identity: null, devices: [] };
          }
          // Device pairings hold the devices' own keys, so they survive
          // a desktop-identity rotation; a phone that pinned our old
          // fingerprint re-pairs.
          await persist(s, {
            identity: op.identity,
            devices: s.devices,
          });
          return null;
        });
      case 'device-list': {
        const s = await load();
        return { devices: [...s.devices], skipped: pendingLegacy };
      }
      case 'device-put':
        return serialized(async () => {
          const s = await load();
          const isNew = !s.devices.some((d) => d.id === op.record.id);
          const replacesFp = s.devices.some(
            (d) => d.fp === op.record.fp && d.id !== op.record.id,
          );
          if (isNew && !replacesFp && s.devices.length >= MAX_SYNC_DEVICES) {
            throw shellError(
              'unavailable',
              'paired device registry is full',
            );
          }
          // Dedupe-by-fp and replace-by-id collapse into the same
          // publish: the blob carries the whole registry at once, so
          // the cap can never be transiently exceeded on disk and a
          // failed write leaves the old registry fully intact.
          const devices = s.devices.filter(
            (d) => d.id !== op.record.id && d.fp !== op.record.fp,
          );
          devices.push(op.record);
          await persist(s, { identity: s.identity, devices });
          return null;
        });
      case 'device-touch':
        // Update iff the record still exists with the same fp —
        // check-and-write inside the serialized section is the atomic
        // guard against a concurrent unpair.
        return serialized(async () => {
          const s = await load();
          const existing = s.devices.find((d) => d.id === op.record.id);
          if (existing === undefined || existing.fp !== op.record.fp) {
            return { updated: false };
          }
          await persist(s, {
            identity: s.identity,
            devices: s.devices.map((d) =>
              d.id === op.record.id ? op.record : d,
            ),
          });
          return { updated: true };
        });
      case 'device-delete':
        return serialized(async () => {
          const s = await load();
          if (!s.devices.some((d) => d.id === op.id)) {
            return null;
          }
          await persist(s, {
            identity: s.identity,
            devices: s.devices.filter((d) => d.id !== op.id),
          });
          return null;
        });
    }
  };
}
