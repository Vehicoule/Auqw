import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isRecord } from '@auqw/application';
import { shellError } from '../shared/errors.ts';

/**
 * The authoritative local-file grant store — utility-owned, never a
 * database row. `local_sources` is renderer-writable through the
 * `storage:*` tx channels, so a row in it can only mirror UI state; a
 * compromised renderer must not be able to mint a grant by writing
 * one. The store lives in its own file under userData (the storage
 * channels carry the domain db only) and is populated by exactly two
 * paths:
 *
 *   - `local:add` — the IPC surface that already validates the
 *     OS-picked path into a treeUri/label descriptor. Only this mints
 *     grants at runtime.
 *   - Bootstrap — the file's absence marks a pre-grant-store install:
 *     existing `local_sources` rows import ONCE so their picks keep
 *     working across the upgrade. The file's existence is the sentinel,
 *     so rows the renderer writes later never create grants.
 *
 * Removal rides the storage commit boundary: `storage.ts` diffs
 * `local_sources.tree_uri` across each committed tx and revokes the
 * treeUris that left the table — a renderer-side delete un-grants,
 * an insert never grants.
 */
export type LocalGrants = {
  /** Granted iff `treeUri` was minted by `local:add` (or bootstrapped). */
  readonly has: (treeUri: string) => boolean;
  /** Mint a grant — the `local:add` path only. */
  readonly grant: (treeUri: string) => void;
  /**
   * Drop grants — memory first, so a persist failure still denies in
   * this process; the dead write is reported on `log`, never thrown
   * into an already-committed storage tx.
   */
  readonly revoke: (treeUris: Iterable<string>) => void;
};

type LocalGrantsOptions = {
  /**
   * File path (`userData/local-grants.json`). Undefined degrades to an
   * in-memory store with no bootstrap import — a store that cannot
   * prove it ran its one-shot import must not import at all.
   */
  readonly path: string | undefined;
  /** Read accessor over the domain db — the bootstrap's row source. */
  readonly database: () => DatabaseSync | null;
  /** Warn-level lines only — treeUris never cross it. */
  readonly log?: ((line: string) => void) | undefined;
};

const STORE_VERSION = 1;
/** Persist-churn bound — a store past this stops being a pick list. */
const MAX_GRANTS = 1_024;

function isStoreBlob(value: unknown): value is { v: number; treeUris: string[] } {
  return (
    isRecord(value) &&
    value['v'] === STORE_VERSION &&
    Array.isArray(value['treeUris']) &&
    value['treeUris'].every(
      (entry) => typeof entry === 'string' && entry.length > 0,
    )
  );
}

function existingTreeUris(
  database: () => DatabaseSync | null,
  log?: (line: string) => void,
): string[] {
  try {
    const db = database();
    if (db === null) {
      return [];
    }
    const rows = db
      .prepare('SELECT tree_uri FROM local_sources')
      .all() as { tree_uri?: unknown }[];
    return rows
      .map((row) => row['tree_uri'])
      .filter((uri): uri is string => typeof uri === 'string');
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : '';
    if (message.includes('no such table')) {
      return [];
    }
    // A database that can't answer the bootstrap read can't hold rows
    // to import (no path configured, unreadable file) — deny-side
    // costs the user a re-pick, never a crashed child.
    log?.('local-grants: bootstrap import skipped — index db unreadable');
    return [];
  }
}

export function createLocalGrants(options: LocalGrantsOptions): LocalGrants {
  const granted = new Set<string>();
  let writeSeq = 0;

  if (options.path !== undefined) {
    if (existsSync(options.path)) {
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(options.path, 'utf8'),
        );
        if (isStoreBlob(parsed)) {
          for (const treeUri of parsed.treeUris.slice(0, MAX_GRANTS)) {
            granted.add(treeUri);
          }
        }
      } catch {
        // An unreadable store fails closed: nothing grants, and the
        // next grant() overwrites the corrupt file. Deny-side is the
        // safe side — a lost store only costs a re-pick.
        options.log?.('local-grants: store unreadable — starting empty');
      }
    } else {
      // One-shot import: the absent file means this store never ran,
      // so pre-existing `local_sources` rows (picked before the store
      // existed) keep their grants. Writing immediately — even empty —
      // consumes the bootstrap: a renderer row minted later must not
      // become a grant on the next boot. And the reverse holds too —
      // when the sentinel can't land on disk the import must not land
      // in memory: a store that can't prove its bootstrap ran behaves
      // as if it never did.
      try {
        persist();
        for (const treeUri of existingTreeUris(
          options.database,
          options.log,
        )) {
          granted.add(treeUri);
        }
        persist();
      } catch {
        granted.clear();
        options.log?.(
          'local-grants: store unwritable — bootstrap skipped, nothing granted',
        );
      }
    }
  }

  function persist(): void {
    if (options.path === undefined) {
      return;
    }
    const path = options.path;
    writeSeq += 1;
    const staging = `${path}.${process.pid}.${writeSeq}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        staging,
        JSON.stringify({
          v: STORE_VERSION,
          treeUris: [...granted].sort(),
        }),
        'utf8',
      );
      renameSync(staging, path);
    } catch (thrown) {
      try {
        rmSync(staging, { force: true });
      } catch {
        // staging cleanup is best-effort.
      }
      throw shellError(
        'io-error',
        'local-grants store could not be written',
      );
    }
  }

  return {
    has(treeUri) {
      return granted.has(treeUri);
    },
    grant(treeUri) {
      if (granted.has(treeUri)) {
        return;
      }
      if (granted.size >= MAX_GRANTS) {
        throw shellError(
          'invalid-request',
          'too many local grants registered',
        );
      }
      // Mint in memory only after the file lands — a grant that never
      // reached disk must not read as granted in-process either.
      const before = granted.size;
      granted.add(treeUri);
      try {
        persist();
      } catch (thrown) {
        if (granted.size !== before) {
          granted.delete(treeUri);
        }
        throw thrown;
      }
    },
    revoke(treeUris) {
      let changed = false;
      for (const treeUri of treeUris) {
        changed = granted.delete(treeUri) || changed;
      }
      if (!changed) {
        return;
      }
      try {
        persist();
      } catch {
        // The in-memory revoke already landed — the file lags at most
        // a boot (the next grant()/revoke() writes the full set).
        options.log?.(
          'local-grants: revoke persisted in memory only — store write failed',
        );
      }
    },
  };
}
