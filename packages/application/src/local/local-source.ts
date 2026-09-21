import type { CancellationSignal } from '../cancellation.ts';
import {
  localTrackRef,
  LOCAL_PROVIDER,
  type LocalFile,
  type LocalSource,
  type Recording,
  type SourceRef,
} from '../domain.ts';
import { appError, err, ok, type Result } from '../errors.ts';
import { createSha256 } from '../downloads/sha256.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { LogPort } from '../ports/log.ts';
import type { OperationContext } from '../cancellation.ts';
import type { StoragePort } from '../ports/storage.ts';
import type { FileFingerprint, LocalTags, TagReaderPort } from '../ports/tag-reader.ts';

export type ScanReport = {
  readonly sourceId: string;
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  /** Entries whose fingerprint read failed — row kept, not fatal. */
  readonly unreadable: number;
};

export type LocalFileSourceDeps = {
  readonly storage: StoragePort;
  readonly tagReader: TagReaderPort;
  readonly ids: IdPort;
  readonly clock: ClockPort;
  readonly log: LogPort;
};

const ctx = (
  ids: IdPort,
  clock: ClockPort,
  signal: CancellationSignal,
): OperationContext => ({
  requestId: ids.next('local'),
  deadlineMs: clock.nowMs() + 30_000,
  signal,
});

const cancelled = () => appError('cancelled', 'scan cancelled');

function titleFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.trim().length > 0 ? base.trim() : name;
}

/**
 * `fileId` = fingerprint + owning source: identical content in two
 * folders is two rows (per data.md); the fingerprint alone stays the
 * move-detection key inside one source. Identical bytes appearing
 * twice in ONE source collide on `sourceId|fingerprint` — the caller
 * disambiguates by docId (the document identity), so a duplicate's id
 * is still stable across rescans. Inputs are ASCII ids/hex —
 * byte loop, no TextEncoder (lib: ES2023 only).
 */
function fileIdFor(
  fingerprint: string,
  sourceId: string,
  docId?: string,
): string {
  const input =
    docId === undefined
      ? `${sourceId}|${fingerprint}`
      : `${sourceId}|${fingerprint}|${docId}`;
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    bytes[i] = input.charCodeAt(i) & 0x7f;
  }
  const h = createSha256();
  h.update(bytes);
  return `lf-${h.digest()}`;
}

/**
 * The local-files index (slice 3): persists folder grants, scans SAF
 * trees into `local_files` + `recordings` (provenance 'local'), and
 * answers the session's `localPlaybackFor` hook with playable
 * document URIs. Storage sections commit as full replacement arrays,
 * so the source keeps the authoritative in-memory copy; a scan's
 * adds/removes land in one atomic commit.
 *
 * Scan is incremental: docId+size match skips fingerprinting; a moved
 * file (same fingerprint, new docId) keeps its `fileId`; a vanished
 * docId drops its row and strips the recording's `local` sourceRef —
 * the recording itself persists as owned data.
 */
export class LocalFileSource {
  readonly #storage: StoragePort;
  readonly #tagReader: TagReaderPort;
  readonly #ids: IdPort;
  readonly #clock: ClockPort;
  readonly #log: LogPort;

  #sources: LocalSource[];
  #files: LocalFile[];
  #recordings: Recording[];
  /** Serializes scans: at most one per source at a time. */
  readonly #scans = new Map<string, Promise<unknown>>();
  /** Serializes every write to the owned sections — a commit merges
   * over live state inside the tail, never over a stale snapshot. */
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    deps: LocalFileSourceDeps,
    state: {
      readonly localSources: readonly LocalSource[];
      readonly localFiles: readonly LocalFile[];
      readonly recordings: readonly Recording[];
    },
  ) {
    this.#storage = deps.storage;
    this.#tagReader = deps.tagReader;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#sources = [...state.localSources];
    this.#files = [...state.localFiles];
    this.#recordings = [...state.recordings];
  }

  /**
   * Recordings exposed for merge: scan keeps this array current.
   * Only `provenance === 'local'` rows are ours — the wider array is
   * refreshed from storage at every commit, never written back stale.
   */
  recordings(): readonly Recording[] {
    return this.#recordings.filter((r) => r.provenance === 'local');
  }

  list(): readonly LocalSource[] {
    return this.#sources;
  }

  filesFor(sourceId: string): readonly LocalFile[] {
    return this.#files.filter((f) => f.sourceId === sourceId);
  }

  /**
   * Playable URI for the session's `localPlaybackFor` hook — null when
   * no live file row serves the recording (offline-fail path).
   */
  uriFor(recordingId: string): string | null {
    const row = this.#files.find((f) => f.recordingId === recordingId);
    if (row === undefined) {
      return null;
    }
    const source = this.#sources.find((s) => s.sourceId === row.sourceId);
    if (source === undefined) {
      return null;
    }
    return this.#tagReader.docUri(source.treeUri, row.docId);
  }

  /**
   * Folder pick → grant persist → initial scan. A cancelled picker is
   * `no-result`, not an error the caller must paper over.
   */
  async addFolder(
    signal: CancellationSignal,
  ): Promise<Result<LocalSource>> {
    if (signal.cancelled) {
      return err(cancelled());
    }
    const picked = await this.#tagReader.pickFolder(signal);
    if (!picked.ok) {
      return err(picked.error);
    }
    const source: LocalSource = {
      sourceId: this.#ids.next('localsrc'),
      treeUri: picked.value.treeUri,
      label: picked.value.label,
      addedMs: this.#clock.nowMs(),
      lastScanMs: null,
    };
    const committed = await this.#commitSections(
      ({ sources, files }) => ({
        sources: [...sources, source],
        files,
        recordings: (current) => [...current],
      }),
      signal,
    );
    if (!committed.ok) {
      return err(committed.error);
    }
    const scanned = await this.rescan(source.sourceId, signal);
    if (!scanned.ok) {
      void this.#log.write({
        level: 'warn',
        message: `local: initial scan failed for source ${source.sourceId}: ${scanned.error.kind}`,
        atMs: this.#clock.nowMs(),
      });
    }
    return ok(source);
  }

  /**
   * Incremental rescan of one source (or all when omitted). Serializes
   * per-source: a second request waits for the in-flight scan, then
   * runs — the caller asked for fresh truth.
   */
  async rescan(
    sourceId: string | undefined,
    signal: CancellationSignal,
  ): Promise<Result<readonly ScanReport[]>> {
    const targets =
      sourceId === undefined
        ? this.#sources.map((s) => s.sourceId)
        : this.#sources.some((s) => s.sourceId === sourceId)
          ? [sourceId]
          : null;
    if (targets === null) {
      return err(appError('not-found', 'unknown local source'));
    }
    const reports: ScanReport[] = [];
    for (const id of targets) {
      const scanned = await this.#scanSerialized(id, signal);
      if (!scanned.ok) {
        return err(scanned.error);
      }
      reports.push(scanned.value);
    }
    return ok(reports);
  }

  /** Drop a folder grant: its file rows go, recordings persist. */
  async removeSource(
    sourceId: string,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    if (signal.cancelled) {
      return err(cancelled());
    }
    // An in-flight scan commits after removal would resurrect the
    // source's rows — let it land first (its own commit is valid).
    const running = this.#scans.get(sourceId);
    if (running !== undefined) {
      await running.catch(() => undefined);
      if (signal.cancelled) {
        return err(cancelled());
      }
    }
    if (!this.#sources.some((s) => s.sourceId === sourceId)) {
      return err(appError('not-found', 'unknown local source'));
    }
    const committed = await this.#commitSections(
      ({ sources, files }) => {
        if (!sources.some((s) => s.sourceId === sourceId)) {
          return null; // a queued op already dropped the grant
        }
        const removed = files.filter((f) => f.sourceId === sourceId);
        return {
          sources: sources.filter((s) => s.sourceId !== sourceId),
          files: files.filter((f) => f.sourceId !== sourceId),
          recordings: (current) => stripLocalRefs(removed, current),
        };
      },
      signal,
    );
    if (!committed.ok) {
      return committed;
    }
    return ok(undefined);
  }

  /**
   * The `recordings` section is shared with the session — commit it
   * by merging our delta over a fresh storage read, never the boot
   * snapshot: session mutations between scans (provider refreshes,
   * added catalog rows, mapping edits) must survive a rescan.
   * `localSources`/`localFiles` are owned exclusively by this class —
   * every write runs on the write tail and computes its next arrays
   * from the live state, so overlapping ops (scans of different
   * sources, folder add/remove) can't lose each other's rows. A
   * `null` merge result no-ops the commit: the op's precondition
   * vanished while it queued.
   */
  async #commitSections(
    merge: (current: { sources: LocalSource[]; files: LocalFile[] }) => {
      sources: LocalSource[];
      files: LocalFile[];
      recordings: (current: readonly Recording[]) => Recording[];
    } | null,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    const run = async (): Promise<Result<void>> => {
      if (signal.cancelled) {
        return err(cancelled());
      }
      const next = merge({ sources: this.#sources, files: this.#files });
      if (next === null) {
        return ok(undefined);
      }
      const fresh = await this.#storage.load(
        ctx(this.#ids, this.#clock, signal),
      );
      if (!fresh.ok) {
        return err(fresh.error);
      }
      const merged = next.recordings(fresh.value.recordings);
      const committed = await this.#storage.commit(
        {
          localSources: next.sources,
          localFiles: next.files,
          recordings: merged,
        },
        ctx(this.#ids, this.#clock, signal),
      );
      if (!committed.ok) {
        return err(committed.error);
      }
      this.#sources = next.sources;
      this.#files = next.files;
      this.#recordings = merged;
      return ok(undefined);
    };
    // A throwing op must not poison the tail — the next queued write
    // still runs on live state.
    const tail = this.#writeTail.then(async () => {
      try {
        return await run();
      } catch (thrown) {
        return err(
          appError(
            'internal',
            thrown instanceof Error ? thrown.message : 'commit failed',
          ),
        );
      }
    });
    this.#writeTail = tail;
    return tail;
  }

  async #scanSerialized(
    sourceId: string,
    signal: CancellationSignal,
  ): Promise<Result<ScanReport>> {
    // Queued waiters re-check the map after each settle — two waiters
    // must not both start when the running scan lands.
    for (;;) {
      const running = this.#scans.get(sourceId);
      if (running === undefined) {
        break;
      }
      await running.catch(() => undefined);
      if (signal.cancelled) {
        return err(cancelled());
      }
    }
    const work = this.#scan(sourceId, signal);
    this.#scans.set(sourceId, work);
    try {
      return await work;
    } finally {
      if (this.#scans.get(sourceId) === work) {
        this.#scans.delete(sourceId);
      }
    }
  }

  async #scan(
    sourceId: string,
    signal: CancellationSignal,
  ): Promise<Result<ScanReport>> {
    const source = this.#sources.find((s) => s.sourceId === sourceId);
    if (source === undefined) {
      return err(appError('not-found', 'unknown local source'));
    }
    const listed = await this.#tagReader.enumerate(source.treeUri, signal);
    if (!listed.ok) {
      return err(listed.error);
    }
    const entries = listed.value;
    const entryByDoc = new Map(entries.map((e) => [e.docId, e] as const));
    const prior = this.#files.filter((f) => f.sourceId === sourceId);
    const byDocId = new Map(prior.map((f) => [f.docId, f] as const));

    // Fingerprint only entries whose (docId, size) isn't already known.
    const needFp = entries.filter((e) => {
      const row = byDocId.get(e.docId);
      return row === undefined || row.size !== e.size;
    });
    const fp =
      needFp.length === 0
        ? ok<readonly (FileFingerprint | null)[]>([])
        : await this.#tagReader.fingerprint(
            source.treeUri,
            needFp.map((e) => e.docId),
            signal,
          );
    if (!fp.ok) {
      return err(fp.error);
    }
    const fpByDoc = new Map<string, string>();
    const unreadableDocs = new Set<string>();
    for (let i = 0; i < needFp.length; i++) {
      const got = fp.value[i] ?? null;
      const docId = needFp[i]!.docId;
      if (got === null) {
        unreadableDocs.add(docId);
      } else {
        fpByDoc.set(docId, got.fingerprint);
      }
    }

    // Move detection matches prior rows by fingerprint; a queue per
    // fingerprint so identical-bytes duplicates each claim their own
    // row instead of racing one. A row kept via docId is consumed
    // here too — it must not also satisfy a later same-fp entry.
    const rowsByFp = new Map<string, LocalFile[]>();
    for (const f of prior) {
      const queue = rowsByFp.get(f.fingerprint);
      if (queue === undefined) {
        rowsByFp.set(f.fingerprint, [f]);
      } else {
        queue.push(f);
      }
    }
    const consumeFp = (row: LocalFile): void => {
      const queue = rowsByFp.get(row.fingerprint);
      if (queue === undefined) {
        return;
      }
      const idx = queue.indexOf(row);
      if (idx >= 0) {
        queue.splice(idx, 1);
      }
      if (queue.length === 0) {
        rowsByFp.delete(row.fingerprint);
      }
    };
    const takeByFp = (fingerprint: string): LocalFile | undefined => {
      const queue = rowsByFp.get(fingerprint);
      const row = queue?.shift();
      if (queue !== undefined && queue.length === 0) {
        rowsByFp.delete(fingerprint);
      }
      return row;
    };
    // Rows this scan produces for `sourceId` — committed over live
    // state in the write tail so a concurrent scan's files survive.
    const scanned: LocalFile[] = [];
    // fileIds claimed this scan — a second copy of identical bytes
    // disambiguates by docId so the commit's PK uniqueness holds.
    const claimed = new Set<string>();
    let added = 0;
    let updated = 0;

    // New-content rows that still need tags before recording upsert.
    const tagDocs: string[] = [];
    const pendingRows: LocalFile[] = [];

    for (const entry of entries) {
      const known = byDocId.get(entry.docId);
      if (known !== undefined && known.size === entry.size) {
        // Unchanged — keep the row untouched and consume its queue
        // slot so a same-fingerprint entry can't re-claim it.
        scanned.push(known);
        claimed.add(known.fileId);
        consumeFp(known);
        continue;
      }
      const fingerprint = fpByDoc.get(entry.docId);
      if (fingerprint === undefined) {
        // Unreadable: keep the prior row (transient read failure must
        // not evict a working file), but don't pretend it's fresh.
        if (known !== undefined) {
          scanned.push(known);
          claimed.add(known.fileId);
          consumeFp(known);
        }
        continue;
      }
      const moved = takeByFp(fingerprint);
      if (moved !== undefined) {
        const refreshed: LocalFile = {
          ...moved,
          docId: entry.docId,
          size: entry.size,
        };
        scanned.push(refreshed);
        claimed.add(refreshed.fileId);
        if (moved.docId !== entry.docId || moved.size !== entry.size) {
          updated += 1;
        }
        continue;
      }
      const fileId = claimed.has(fileIdFor(fingerprint, sourceId))
        ? fileIdFor(fingerprint, sourceId, entry.docId)
        : fileIdFor(fingerprint, sourceId);
      const row: LocalFile = {
        fileId,
        sourceId,
        docId: entry.docId,
        size: entry.size,
        fingerprint,
        title: null,
        artist: null,
        album: null,
        durationMs: null,
        genre: null,
        recordingId: '', // set after the batched tag read
      };
      claimed.add(fileId);
      tagDocs.push(entry.docId);
      pendingRows.push(row);
    }

    const tags =
      tagDocs.length === 0
        ? ok<readonly (LocalTags | null)[]>([])
        : await this.#tagReader.readTags(source.treeUri, tagDocs, signal);
    if (!tags.ok) {
      return err(tags.error);
    }
    if (signal.cancelled) {
      return err(cancelled());
    }

    // Same content under a second folder joins the existing recording.
    const recordingByFp = new Map<string, string>();
    for (const f of this.#files) {
      if (!recordingByFp.has(f.fingerprint)) {
        recordingByFp.set(f.fingerprint, f.recordingId);
      }
    }
    // `fp:` tombstone refs kept on recordings whose file rows vanished:
    // the same content returning — same source or a re-added folder —
    // re-links to its old recording (likes/playlists survive) instead
    // of allocating a fresh identity. Live `local` refs index by fileId
    // too: an imported recording still carries the fileId this scan
    // recomputes, so a post-import rescan rejoins it instead of
    // duplicating the track.
    const recordingByRetainedFp = new Map<string, string>();
    const recordingByFileId = new Map<string, string>();
    for (const r of this.#recordings) {
      for (const s of r.sourceRefs) {
        if (s.provider !== LOCAL_PROVIDER) {
          continue;
        }
        if (s.id.startsWith('fp:')) {
          const fp = s.id.slice(3);
          if (!recordingByRetainedFp.has(fp)) {
            recordingByRetainedFp.set(fp, r.id);
          }
        } else if (!recordingByFileId.has(s.id)) {
          recordingByFileId.set(s.id, r.id);
        }
      }
    }

    // Recording upserts are deferred into the commit's fresh-read
    // merge — a recording created or edited by the session since boot
    // must not be clobbered by our stale copy (or vice versa).
    const pendingRecordings: {
      recordingId: string;
      fileId: string;
      fingerprint: string;
      title: string;
      artist: string | null;
      album: string | null;
      durationMs: number | null;
      genre: string | null;
    }[] = [];

    for (let i = 0; i < pendingRows.length; i++) {
      const row = pendingRows[i]!;
      const entry = entryByDoc.get(row.docId)!;
      const tag = tags.value[i] ?? null;
      const title = tag?.title ?? titleFromName(entry.name);
      // Same docId, new bytes → keep the recording identity; an
      // imported row carrying this exact fileId rejoins it; same
      // fingerprint in another folder → join that recording; else new.
      const known = byDocId.get(row.docId);
      const existing =
        known?.recordingId ??
        recordingByFileId.get(row.fileId) ??
        recordingByFp.get(row.fingerprint) ??
        recordingByRetainedFp.get(row.fingerprint);
      const recordingId = existing ?? this.#ids.next('rec');
      recordingByFp.set(row.fingerprint, recordingId);
      scanned.push({
        ...row,
        recordingId,
        title,
        artist: tag?.artist ?? null,
        album: tag?.album ?? null,
        durationMs: tag?.durationMs ?? null,
        genre: tag?.genre ?? null,
      });
      added += 1;
      pendingRecordings.push({
        recordingId,
        fileId: row.fileId,
        fingerprint: row.fingerprint,
        title,
        artist: tag?.artist ?? null,
        album: tag?.album ?? null,
        durationMs: tag?.durationMs ?? null,
        genre: tag?.genre ?? null,
      });
    }

    // File rows whose fileId didn't survive — vanished docIds AND
    // changed content (same docId, new fingerprint → new fileId):
    // drop the rows, strip the dead `provider:'local'` refs. The
    // recording persists as owned data.
    const live = new Set(scanned.map((f) => f.fileId));
    const vanished = prior.filter((f) => !live.has(f.fileId));

    const nextSource: LocalSource = {
      ...source,
      lastScanMs: this.#clock.nowMs(),
    };

    const mergeRecordings = (current: readonly Recording[]): Recording[] => {
      // Upserts first, strip second: a changed-content file replaces
      // its own dead ref, and the strip's ≥1-ref guard only applies
      // to recordings that gained no replacement.
      const merged = [...current];
      const byId = new Map(merged.map((r, i) => [r.id, i] as const));
      const upsert = (r: Recording): void => {
        const idx = byId.get(r.id);
        if (idx === undefined) {
          byId.set(r.id, merged.length);
          merged.push(r);
        } else {
          merged[idx] = r;
        }
      };
      for (const p of pendingRecordings) {
        const rec = byId.get(p.recordingId);
        const ref = localTrackRef(p.fileId);
        const existing = rec === undefined ? undefined : merged[rec];
        if (existing === undefined) {
          upsert({
            id: p.recordingId,
            title: p.title,
            artist: p.artist,
            album: p.album,
            durationMs: p.durationMs,
            releaseYear: null,
            artwork: [],
            explicit: null,
            genre: p.genre,
            isrc: null,
            versionLabels: [],
            sourceRefs: [ref],
            mappings: [],
            provenance: 'local',
          });
        } else if (
          !existing.sourceRefs.some(
            (s) =>
              s.provider === LOCAL_PROVIDER &&
              s.kind === 'track' &&
              s.id === p.fileId,
          )
        ) {
          // Restoring a live ref retires its `fp:` tombstone — the
          // row's local identity is the file again, not the marker.
          upsert({
            ...existing,
            sourceRefs: [
              ...existing.sourceRefs.filter(
                (s) =>
                  !(
                    s.provider === LOCAL_PROVIDER &&
                    s.id === `fp:${p.fingerprint}`
                  ),
              ),
              ref,
            ],
          });
        }
      }
      return stripLocalRefs(vanished, merged);
    };

    const committed = await this.#commitSections(
      ({ sources, files }) => {
        // The grant may have been dropped while this scan read tags —
        // its rows must not resurrect under a removed source.
        if (!sources.some((s) => s.sourceId === sourceId)) {
          return null;
        }
        return {
          sources: sources.map((s) =>
            s.sourceId === sourceId ? nextSource : s,
          ),
          files: [
            ...files.filter((f) => f.sourceId !== sourceId),
            ...scanned,
          ],
          recordings: mergeRecordings,
        };
      },
      signal,
    );
    if (!committed.ok) {
      return err(committed.error);
    }
    void this.#log.write({
      level: 'info',
      message: `local: scan ${sourceId} entries=${entries.length} added=${added} removed=${vanished.length} unreadable=${unreadableDocs.size}`,
      atMs: this.#clock.nowMs(),
    });
    return ok({
      sourceId,
      added,
      updated,
      removed: vanished.length,
      unreadable: unreadableDocs.size,
    });
  }
}

/**
 * Drop `provider:'local'` refs whose fileId is gone from `recordings`
 * — the recording row persists; dead refs must not survive export.
 * A local-only recording would strip to zero refs, which violates
 * the ≥1-ref record invariant (sqlite's commit rejects the batch):
 * its stale fingerprint ref stays — inert (no file row, so uriFor
 * never resolves it) and re-links if the same file is re-added.
 */
function stripLocalRefs(
  removed: readonly LocalFile[],
  recordings: readonly Recording[],
): Recording[] {
  if (removed.length === 0) {
    return [...recordings];
  }
  const dead = new Set(removed.map((f) => f.fileId));
  const fpByFileId = new Map(removed.map((f) => [f.fileId, f.fingerprint]));
  return recordings.map((r) => {
    if (
      !r.sourceRefs.some(
        (s) => s.provider === LOCAL_PROVIDER && dead.has(s.id),
      )
    ) {
      return r;
    }
    const kept = r.sourceRefs.filter(
      (s) => !(s.provider === LOCAL_PROVIDER && dead.has(s.id)),
    );
    // Every dead local ref becomes an `fp:` tombstone — inert to
    // uriFor, keyed by raw fingerprint so a returning file re-links
    // to this recording even under a fresh sourceId (re-added folder).
    // On rows with surviving refs they preserve local identity; on
    // zero-kept rows they also satisfy the ≥1-ref invariant.
    const tombstones = new Map<string, SourceRef>();
    for (const s of r.sourceRefs) {
      const fp =
        s.provider === LOCAL_PROVIDER ? fpByFileId.get(s.id) : undefined;
      if (fp !== undefined) {
        tombstones.set(fp, { ...s, id: `fp:${fp}` });
      }
    }
    const seen = new Set(kept.map((s) => `${s.provider}|${s.kind}|${s.id}`));
    const merged = [
      ...kept,
      ...[...tombstones.values()].filter(
        (t) => !seen.has(`${t.provider}|${t.kind}|${t.id}`),
      ),
    ];
    return { ...r, sourceRefs: merged };
  });
}
