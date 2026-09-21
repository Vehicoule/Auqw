import { CancellationSource } from '../cancellation.ts';
import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import type {
  DownloadProgress,
  DownloadRecord,
  DownloadState,
  Settings,
  SourceRef,
} from '../domain.ts';
import type { ConnectivityPort } from '../ports/connectivity.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import type { MediaTransferPort } from '../ports/media-transfer.ts';
import type { PlayableResource } from '../ports/provider.ts';
import type { IdPort } from '../ports/runtime.ts';
import type { StoragePort } from '../ports/storage.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import { createSha256 } from './sha256.ts';
import type { ChunkHasher, RangeFetch } from './transfer-policy.ts';
import { runTransfer } from './transfer-policy.ts';

/**
 * DownloadManager — the offline byte owner. The FSM is
 * `requested → transferring → available | failed_with_retry | removing`;
 * `available` is the durable terminal — owned files never expire and
 * are never evicted. One active transfer at a time (a second slot is
 * pointless on a phone radio); the pending queue orders by the three
 * priority bands — now-playing (0) → rest-of-queue (1) → explicit (2) —
 * then `requestedMs`. `updatePriorities` re-bands pending rows when
 * the playback queue changes.
 *
 * Dedupe: `recording_id` is UNIQUE — a request for a recording with a
 * live/available download of the SAME mapping no-ops (a failed row of
 * the same mapping retries in place, keeping its resume offset); a
 * different mapping replaces the row and its file. Playlist
 * download-all snapshots its rows at call time — later queue edits do
 * not retro-add.
 *
 * Gating: transfers start only when `connectivity` reports online and
 * (unmetered, or `settings.downloadMetered`). Connectivity edges and
 * explicit retries re-run the pump; mint expiry is handled by
 * re-resolving at transfer start and per 403/416 — `available` rows
 * ignore `expiresAtMs` entirely.
 *
 * `filePath` is the port's managed bare name (`dl-<id>`), NOT an OS
 * path — the port owns the directory; playback resolves it through
 * the `provider:'local'` URI convention at the session layer.
 */

/** The queue-derived band a download sorts into; lower runs first. */
export const BAND_NOW_PLAYING = 0;
export const BAND_IN_QUEUE = 1;
export const BAND_EXPLICIT = 2;

const MAX_ACTIVE = 1;
const RESOLVE_DEADLINE_MS = 30_000;
/** Persist the resume offset every N committed bytes, not per chunk. */
const OFFSET_CHECKPOINT_BYTES = 4 * 1024 * 1024;

export type DownloadRequest = {
  readonly recordingId: string;
  readonly sourceRef: SourceRef;
};

export type DownloadManagerDeps = {
  readonly storage: StoragePort;
  readonly transfer: MediaTransferPort;
  readonly connectivity: ConnectivityPort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly log: LogPort;
  readonly fetchImpl: RangeFetch;
  readonly hasher?: () => ChunkHasher;
  /**
   * Mint + re-mint hook — resolvePlayback through the routed playback
   * provider, with `resumeOffset`/`pinItag` so the provider can serve
   * the same encoding at the durable offset.
   */
  readonly resolvePlayback: (
    ref: SourceRef,
    input: { resumeOffset: number | null; pinItag: number | null },
    context: OperationContext,
  ) => Promise<Result<PlayableResource>>;
  /** Live queue snapshot — drives the priority bands. */
  readonly queue: () => QueueSnapshot;
  /** Live settings — `downloadMetered`, `qualityKbps`. */
  readonly settings: () => Settings;
};

export class DownloadManager {
  readonly #deps: DownloadManagerDeps;
  readonly #rows = new Map<string, DownloadRecord>();
  /** downloadId → cancel handle for the in-flight transfer. */
  readonly #active = new Map<string, CancellationSource>();
  /** downloadId → the runner's settle promise — remove() awaits real
   * teardown (fetch aborted, sink closed), never a microtask drain. */
  readonly #runners = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(progress: DownloadProgress) => void>();
  /** Last offset the ledger durably persisted, per row. */
  readonly #persistedOffset = new Map<string, number>();
  #pumping = false;
  /** stop() latches this so a settling runner can't re-pump a demoted row. */
  #stopped = false;
  /** recordingId → in-flight removal — a concurrent request waits on it
   * so two same-recording rows never land in one commit. */
  readonly #removals = new Map<string, Promise<unknown>>();
  /** Serializes ledger writes — commits carry the full section. */
  #persistTail: Promise<Result<void>> = Promise.resolve(ok(undefined));
  #unsubConnectivity: (() => void) | null = null;

  constructor(deps: DownloadManagerDeps) {
    this.#deps = deps;
  }

  // ---- lifecycle ---------------------------------------------------

  /**
   * Startup integrity over the loaded ledger: sweep `.part` files
   * with no owning row, drop `available` rows whose file vanished
   * (degrade to streaming), finish `removing` rows, and re-pump
   * interrupted `transferring`/`requested` rows from their durable
   * `committedOffset`. `downloads` comes from the boot-time
   * `PersistedState` the caller already loaded.
   */
  async init(
    downloads: readonly DownloadRecord[],
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    this.#unsubConnectivity?.();
    this.#stopped = false;
    // Stage the loaded rows in a private map: the integrity checks
    // below mutate it, and it publishes to #rows only after every
    // check and the fixup persist succeed. A failed init leaves an
    // honest empty ledger — unchecked rows must never be readable
    // through fileFor/recordFor while a caller decides to proceed.
    const dropped = [...this.#rows.values()];
    this.#rows.clear();
    this.#persistedOffset.clear();
    const staged = new Map<string, DownloadRecord>();
    for (const row of downloads) {
      staged.set(row.downloadId, row);
    }
    const failed = <T>(result: Result<T>): Result<T> => {
      // One emit per dropped row refreshes any UI holding them.
      for (const row of dropped) {
        this.#emit({ ...row, state: 'removing' });
      }
      return result;
    };

    // Keep .part files for rows that own resumable bytes — including
    // failed_with_retry, whose explicit retry resumes the prefix.
    const keep = new Set<string>();
    for (const row of staged.values()) {
      if (
        row.state === 'requested' ||
        row.state === 'transferring' ||
        row.state === 'failed_with_retry'
      ) {
        keep.add(`${row.filePath}.part`);
      }
    }
    const swept = await this.#deps.transfer.sweepPartials([...keep], signal);
    if (!swept.ok) {
      return failed(swept);
    }
    if (swept.value > 0) {
      this.#log('info', `downloads: swept ${swept.value} stale .part files`);
    }

    let dirty = false;
    for (const row of [...staged.values()]) {
      if (signal.cancelled) {
        return failed(err(appError('cancelled', 'cancelled')));
      }
      if (row.state === 'available') {
        const st = await this.#deps.transfer.stat(row.filePath, signal);
        if (!st.ok) {
          return failed(st);
        }
        // Vanished file — or a size the ledger never recorded
        // (truncated/replaced media must not play as offline content).
        // bytes:null means the adapter can't read the size — keep the
        // row: existence is the only honest signal there.
        if (
          !st.value.exists ||
          (st.value.bytes !== null && st.value.bytes !== row.bytes)
        ) {
          const removed = await this.#deps.transfer.removeFile(
            row.filePath,
            signal,
          );
          if (!removed.ok) {
            return failed(removed);
          }
          staged.delete(row.downloadId);
          dirty = true;
          this.#log(
            'warn',
            `downloads: ${row.downloadId} file ${st.value.exists ? 'size-mismatch' : 'vanished'} — degrading to streaming`,
          );
        }
      } else if (row.state === 'removing') {
        const removed = await this.#deps.transfer.removeFile(
          row.filePath,
          signal,
        );
        if (!removed.ok) {
          return failed(removed);
        }
        staged.delete(row.downloadId);
        dirty = true;
      } else if (row.state === 'transferring') {
        // Interrupted mid-transfer — resume from the durable offset.
        staged.set(row.downloadId, { ...row, state: 'requested' });
        dirty = true;
      }
    }
    if (dirty) {
      const persisted = await this.#persist([...staged.values()]);
      if (!persisted.ok) {
        return failed(persisted);
      }
    }
    // Verified — publish the staged ledger.
    for (const row of staged.values()) {
      this.#rows.set(row.downloadId, row);
      this.#persistedOffset.set(row.downloadId, row.committedOffset);
    }

    // Connectivity edges re-run the scheduler (offline → online, or
    // metered → unmetered unblocks waiting rows). An edge that makes
    // the network ineligible pauses the ACTIVE transfer too — the
    // metered opt-out must protect the whole remaining transfer, not
    // just the next row selection.
    this.#unsubConnectivity = this.#deps.connectivity.subscribe((snap) => {
      const meteredAllowed =
        this.#deps.settings().downloadMetered ?? false;
      if (!snap.online || (snap.metered && !meteredAllowed)) {
        void this.#demoteActive().then((demoted) => {
          if (!demoted.ok) {
            this.#log(
              'warn',
              `downloads: connectivity-edge pause failed: ${demoted.error.kind}`,
            );
          }
        });
        return;
      }
      void this.#pump();
    });
    void this.#pump();
    return ok(undefined);
  }

  /**
   * Demote every in-flight transfer to `requested` (persisted) BEFORE
   * its cancel edge lands, so the settle path leaves the row resumable
   * at its committed offset instead of writing `failed_with_retry`.
   * Shared by stop() and the connectivity-ineligible pause.
   */
  async #demoteActive(
    signal: CancellationSignal = new CancellationSource().signal,
  ): Promise<Result<void>> {
    for (const [id, source] of this.#active) {
      const row = this.#rows.get(id);
      if (row !== undefined && row.state === 'transferring') {
        const demoted = await this.#setRow(
          row,
          { state: 'requested' },
          signal,
        );
        if (!demoted.ok) {
          return err(demoted.error);
        }
      }
      source.cancel();
    }
    return ok(undefined);
  }

  /**
   * Orderly stop: in-flight transfers demote to `requested` (persisted)
   * BEFORE their cancel edge lands, so the settle path leaves them
   * resumable instead of writing `failed_with_retry`.
   */
  async stop(signal: CancellationSignal): Promise<Result<void>> {
    this.#stopped = true;
    this.#unsubConnectivity?.();
    this.#unsubConnectivity = null;
    const demoted = await this.#demoteActive(signal);
    if (!demoted.ok) {
      return demoted;
    }
    // Wait for real teardown — the runner owns its sink until settle,
    // so a caller that deletes the files right after stop (library
    // import) must not race an open handle. allSettled: a runner's
    // own failure is already recorded on its row.
    await Promise.allSettled([...this.#runners.values()]);
    return ok(undefined);
  }

  // ---- reads ---------------------------------------------------------

  /** Live progress rows for the downloads collection. */
  list(): readonly DownloadProgress[] {
    return [...this.#rows.values()]
      .sort((a, b) => a.priority - b.priority || a.requestedMs - b.requestedMs)
      .map((row) => this.#progressOf(row));
  }

  recordFor(recordingId: string): DownloadRecord | null {
    for (const row of this.#rows.values()) {
      if (row.recordingId === recordingId && row.state !== 'removing') {
        return row;
      }
    }
    return null;
  }

  /**
   * Ledger snapshot: the persisted rows themselves (with `filePath`),
   * for callers that replace the storage sections and must clean up
   * the files a swap orphaned.
   */
  records(): readonly DownloadRecord[] {
    return [...this.#rows.values()].filter((row) => row.state !== 'removing');
  }

  /** The `available` file name for playback resolution, if any. */
  fileFor(recordingId: string): string | null {
    const row = this.recordFor(recordingId);
    return row !== null && row.state === 'available' ? row.filePath : null;
  }

  subscribe(listener: (progress: DownloadProgress) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // ---- commands ------------------------------------------------------

  /**
   * Queue a download for one recording. Same-mapping live/available
   * rows no-op; a same-mapping `failed_with_retry` row retries in
   * place (resume offset kept); a different mapping replaces the row
   * and its file.
   */
  async request(
    input: DownloadRequest,
    signal: CancellationSignal,
  ): Promise<Result<DownloadRecord>> {
    const existing = this.recordFor(input.recordingId);
    if (existing !== null) {
      const sameMapping =
        existing.sourceRef.provider === input.sourceRef.provider &&
        existing.sourceRef.kind === input.sourceRef.kind &&
        existing.sourceRef.id === input.sourceRef.id;
      if (sameMapping) {
        if (existing.state === 'failed_with_retry') {
          const retried = await this.retry(existing.downloadId, signal);
          if (!retried.ok) {
            return retried;
          }
          const row = this.#rows.get(existing.downloadId);
          return row === undefined
            ? err(appError('internal', 'retry dropped the row'))
            : ok(row);
        }
        return ok(existing);
      }
      // Different mapping → replace row + file (recording_id UNIQUE).
      const removed = await this.#removeRow(existing, signal);
      if (!removed.ok) {
        return removed;
      }
    }
    // Wait out an in-flight removal for this recording — otherwise a
    // [removing + new-requested] commit pair trips UNIQUE(recording_id).
    const pending = this.#removals.get(input.recordingId);
    if (pending !== undefined) {
      await pending;
      const afterRemove = this.recordFor(input.recordingId);
      if (afterRemove !== null) {
        // A row materialized while we waited — fall back to dedupe.
        return ok(afterRemove);
      }
    }
    const downloadId = this.#deps.ids.next('dl');
    const record: DownloadRecord = {
      downloadId,
      recordingId: input.recordingId,
      provider: input.sourceRef.provider,
      sourceRef: input.sourceRef,
      filePath: `dl-${downloadId}`,
      bytes: 0,
      state: 'requested',
      committedOffset: 0,
      checksum: null,
      mime: null,
      itag: null,
      expiresAtMs: null,
      error: null,
      priority: this.#bandFor(input.recordingId),
      requestedMs: this.#deps.clock.nowMs(),
      downloadedMs: null,
    };
    this.#rows.set(record.downloadId, record);
    this.#persistedOffset.set(record.downloadId, 0);
    const persisted = await this.#persist();
    if (!persisted.ok) {
      this.#rows.delete(record.downloadId);
      return persisted;
    }
    this.#emit(record);
    void this.#pump();
    return ok(record);
  }

  /**
   * Playlist download-all — snapshots the rows at call time; later
   * queue edits never retro-add.
   */
  async requestAll(
    items: readonly DownloadRequest[],
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    for (const item of items) {
      if (signal.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const requested = await this.request(item, signal);
      if (!requested.ok) {
        return err(requested.error);
      }
    }
    return ok(undefined);
  }

  /** Stop a transfer, keeping the `.part` for a later retry. */
  async cancel(
    downloadId: string,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    const row = this.#rows.get(downloadId);
    if (row === undefined) {
      return err(appError('not-found', 'no such download'));
    }
    const running = this.#active.get(downloadId);
    if (running !== undefined) {
      running.cancel(); // settles as failed_with_retry('cancelled')
      return ok(undefined);
    }
    if (row.state === 'requested') {
      return this.#fail(row, 'cancelled', 'cancelled', signal);
    }
    return ok(undefined); // terminal/removing rows: nothing to stop
  }

  /** failed_with_retry → requested (same mapping, resume offset kept). */
  async retry(
    downloadId: string,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    const row = this.#rows.get(downloadId);
    if (row === undefined) {
      return err(appError('not-found', 'no such download'));
    }
    if (row.state === 'requested') {
      return ok(undefined);
    }
    if (row.state !== 'failed_with_retry') {
      return err(
        appError('not-applicable', `cannot retry a ${row.state} download`),
      );
    }
    const next: DownloadRecord = {
      ...row,
      state: 'requested',
      error: null,
      priority: this.#bandFor(row.recordingId),
    };
    this.#rows.set(downloadId, next);
    const persisted = await this.#persist();
    if (!persisted.ok) {
      this.#rows.set(downloadId, row); // restore — no false 'requested'
      return persisted;
    }
    this.#emit(next);
    void this.#pump();
    return ok(undefined);
  }

  /** removing → file delete → row drop. */
  async remove(
    downloadId: string,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    const row = this.#rows.get(downloadId);
    if (row === undefined) {
      return err(appError('not-found', 'no such download'));
    }
    return this.#removeRow(row, signal);
  }

  /** Settings delete-all: every row through `removing`. */
  async removeAll(signal: CancellationSignal): Promise<Result<void>> {
    for (const row of [...this.#rows.values()]) {
      if (signal.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const removed = await this.#removeRow(row, signal);
      if (!removed.ok) {
        return removed;
      }
    }
    return ok(undefined);
  }

  /** Settings surface: managed bytes + free space. */
  async usage(
    signal: CancellationSignal,
  ): Promise<Result<{ bytes: number; free: number }>> {
    const used = await this.#deps.transfer.usage(signal);
    if (!used.ok) {
      return used;
    }
    const free = await this.#deps.transfer.freeBytes(signal);
    if (!free.ok) {
      return free;
    }
    return ok({ bytes: used.value, free: free.value });
  }

  /** Settings toggle (e.g. metered opt-in) — re-run the scheduler. */
  kick(): void {
    void this.#pump();
  }

  /**
   * Re-band all pending rows against the live queue. Session calls
   * this when the queue changes so a now-playing download jumps the
   * line.
   */
  async updatePriorities(signal: CancellationSignal): Promise<Result<void>> {
    let changed = false;
    for (const [id, row] of this.#rows) {
      if (row.state !== 'requested' && row.state !== 'failed_with_retry') {
        continue;
      }
      const band = this.#bandFor(row.recordingId);
      if (band !== row.priority) {
        const next = { ...row, priority: band };
        this.#rows.set(id, next);
        this.#emit(next);
        changed = true;
      }
    }
    if (changed) {
      const persisted = await this.#persist();
      if (!persisted.ok) {
        return persisted;
      }
    }
    return ok(undefined);
  }

  // ---- internals -------------------------------------------------------

  #ctx(label: string, signal: CancellationSignal): OperationContext {
    return {
      requestId: `${label}-${this.#deps.ids.next('op')}`,
      deadlineMs: this.#deps.clock.nowMs() + RESOLVE_DEADLINE_MS,
      signal,
    };
  }

  #bandFor(recordingId: string): number {
    const queue = this.#deps.queue();
    const current = queue.occurrences.find(
      (o) => o.occurrenceId === queue.currentOccurrenceId,
    );
    if (current !== undefined && current.recordingId === recordingId) {
      return BAND_NOW_PLAYING;
    }
    if (queue.occurrences.some((o) => o.recordingId === recordingId)) {
      return BAND_IN_QUEUE;
    }
    return BAND_EXPLICIT;
  }

  #progressOf(row: DownloadRecord): DownloadProgress {
    return {
      downloadId: row.downloadId,
      recordingId: row.recordingId,
      state: row.state,
      transferredBytes: row.committedOffset,
      totalBytes: row.bytes > 0 ? row.bytes : null,
    };
  }

  #emit(row: DownloadRecord): void {
    const progress = this.#progressOf(row);
    for (const listener of this.#listeners) {
      try {
        listener(progress);
      } catch {
        // A throwing listener must not break fan-out.
      }
    }
  }

  /**
   * Serialized section replace — every commit writes the whole
   * `downloads` array from live memory, so queued writes are
   * idempotent (a later commit just repeats the newest data).
   */
  #persist(snapshot?: readonly DownloadRecord[]): Promise<Result<void>> {
    const run = (): Promise<Result<void>> =>
      this.#deps.storage.commit(
        // Callers that pass a snapshot (init staging) commit exactly
        // that set; the default reads the live map at run time, so a
        // queued commit carries the newest rows.
        { downloads: snapshot !== undefined ? [...snapshot] : [...this.#rows.values()] },
        {
          requestId: 'persist',
          deadlineMs: this.#deps.clock.nowMs() + RESOLVE_DEADLINE_MS,
          signal: NEVER_CANCEL,
        },
      );
    // A throwing commit must not poison the chain — the next persist
    // still runs and carries the newest rows.
    const tail = this.#persistTail.then(async () => {
      try {
        return await run();
      } catch (thrown) {
        const message =
          thrown instanceof Error ? thrown.message : 'persist failed';
        return err(appError('internal', message));
      }
    });
    this.#persistTail = tail;
    return tail;
  }

  #log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    void this.#deps.log.write({
      level,
      message,
      atMs: this.#deps.clock.nowMs(),
    });
  }

  async #setRow(
    row: DownloadRecord,
    patch: Partial<DownloadRecord>,
    _signal: CancellationSignal,
  ): Promise<Result<DownloadRecord>> {
    // No signal gate here: internal transitions must still land after
    // a transfer's own cancel edge (e.g. failed_with_retry on cancel).
    const next: DownloadRecord = { ...row, ...patch };
    this.#rows.set(row.downloadId, next);
    const persisted = await this.#persist();
    if (!persisted.ok) {
      this.#rows.set(row.downloadId, row);
      return persisted;
    }
    this.#emit(next);
    return ok(next);
  }

  async #fail(
    row: DownloadRecord,
    kind: string,
    message: string,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    const set = await this.#setRow(
      row,
      {
        state: 'failed_with_retry' as DownloadState,
        error: { kind, message },
      },
      signal,
    );
    return set.ok ? ok(undefined) : set;
  }

  async #removeRow(
    row: DownloadRecord,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    // Serialize per recording: a concurrent request() awaits this
    // promise instead of colliding on UNIQUE(recording_id).
    const key = row.recordingId;
    const pending = this.#removals.get(key);
    if (pending !== undefined) {
      await pending;
    }
    const operation = this.#removeRowInner(row, signal);
    this.#removals.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#removals.get(key) === operation) {
        this.#removals.delete(key);
      }
    }
  }

  async #removeRowInner(
    row: DownloadRecord,
    signal: CancellationSignal,
  ): Promise<Result<void>> {
    const running = this.#active.get(row.downloadId);
    const marked = await this.#setRow(row, { state: 'removing' }, signal);
    if (!marked.ok) {
      return marked;
    }
    if (running !== undefined) {
      // The settle path sees `removing` and returns without writing.
      running.cancel();
      // Wait on the runner's own completion: abort and sink teardown
      // settle on real tasks, and the .part must be closed before the
      // delete below touches it.
      await this.#runners.get(row.downloadId);
    }
    const removed = await this.#deps.transfer.removeFile(row.filePath, signal);
    if (!removed.ok) {
      return removed;
    }
    this.#rows.delete(row.downloadId);
    this.#persistedOffset.delete(row.downloadId);
    // Emit the row's final state post-delete — listeners re-read
    // list() and see the row gone; without this the last event they
    // saw (`removing`) still contained it.
    this.#emit(marked.value);
    const persisted = await this.#persist();
    if (!persisted.ok) {
      return persisted;
    }
    return ok(undefined);
  }

  /**
   * Eligibility gate for a `requested` row: online + (unmetered or
   * `downloadMetered`). Fetches the snapshot once per pump iteration.
   */
  async #pump(): Promise<void> {
    if (this.#pumping || this.#stopped) {
      return;
    }
    this.#pumping = true;
    try {
      for (;;) {
        if (this.#active.size >= MAX_ACTIVE) {
          return;
        }
        const pending = [...this.#rows.values()]
          .filter((row) => row.state === 'requested')
          .sort(
            (a, b) =>
              a.priority - b.priority || a.requestedMs - b.requestedMs,
          );
        const next = pending[0];
        if (next === undefined) {
          return;
        }
        const net = await this.#deps.connectivity.snapshot();
        if (!net.ok) {
          return;
        }
        if (!net.value.online) {
          return; // honest wait — stay 'requested'
        }
        const meteredAllowed = this.#deps.settings().downloadMetered ?? false;
        if (net.value.metered && !meteredAllowed) {
          return; // metered gate — waits for unmetered or the setting
        }
        // Claim it synchronously before the next await so a re-entrant
        // pump can't double-start the same row.
        const source = new CancellationSource();
        this.#active.set(next.downloadId, source);
        const done = this.#run(next, source)
          .catch((thrown) => {
            this.#log(
              'error',
              `downloads: runner ${next.downloadId} threw: ${thrown instanceof Error ? thrown.message : 'unknown'}`,
            );
          })
          .finally(() => {
            this.#active.delete(next.downloadId);
            this.#runners.delete(next.downloadId);
            void this.#pump();
          });
        this.#runners.set(next.downloadId, done);
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #run(
    row: DownloadRecord,
    source: CancellationSource,
  ): Promise<void> {
    const signal = source.signal;
    const ctx = this.#ctx('transfer', signal);

    // Claim `transferring` BEFORE the mint — the resolve is part of
    // the transfer, and a concurrent stop()/remove() must see the row
    // as owned by this runner so it can demote/take over correctly.
    const claimed = await this.#setRow(
      row,
      { state: 'transferring' as DownloadState },
      signal,
    );
    if (!claimed.ok) {
      return;
    }
    let live = claimed.value;

    // ---- mint --------------------------------------------------------
    // Re-resolve at transfer start — a stale mint lands a fresh
    // resource transparently; a partial resume pins the itag.
    const minted = await this.#deps.resolvePlayback(
      row.sourceRef,
      {
        resumeOffset: row.committedOffset > 0 ? row.committedOffset : null,
        pinItag: row.itag,
      },
      ctx,
    );
    if (!minted.ok) {
      const latest = this.#rows.get(row.downloadId);
      if (
        latest === undefined ||
        latest.state === 'removing' ||
        latest.state === 'requested'
      ) {
        // Removed mid-mint, or an orderly demotion (stop / ineligible
        // connectivity edge) already returned the row to 'requested' —
        // don't overwrite the intent. A user cancel() on a row still
        // 'requested' (pre-claim window) writes the cancelled fail on
        // the cancel path itself, not here.
        return;
      }
      await this.#fail(
        latest,
        minted.error.kind,
        minted.error.message,
        signal,
      );
      return;
    }
    const first = minted.value;

    // A stop() that landed during the mint demoted the row —
    // re-reading guards against resurrecting 'transferring' over it
    // (the live `row` handle is stale by construction).
    const fresh = this.#rows.get(row.downloadId);
    if (
      fresh === undefined ||
      fresh.state === 'removing' ||
      fresh.state === 'requested'
    ) {
      // A demotion that landed during the mint (stop / connectivity
      // edge) is honoured — never resurrect 'transferring' over it.
      return;
    }

    const mintedRow = await this.#setRow(
      fresh,
      {
        expiresAtMs: first.expiresAtMs,
        itag: first.itag ?? live.itag,
        mime: first.mime ?? live.mime,
      },
      signal,
    );
    if (!mintedRow.ok) {
      return;
    }
    live = mintedRow.value;

    // ---- transfer ------------------------------------------------------
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await runTransfer({
        destName: live.filePath,
        first,
        // Fresh context per remint — the transfer ctx's deadline
        // (mint-time) may already be past on a long transfer.
        remint: (resumeOffset, itag) =>
          this.#deps.resolvePlayback(
            live.sourceRef,
            { resumeOffset, pinItag: itag },
            this.#ctx('remint', signal),
          ),
        transfer: this.#deps.transfer,
        fetchImpl: this.#deps.fetchImpl,
        clock: this.#deps.clock,
        signal,
        resumeAtBytes: live.committedOffset,
        hasher: this.#deps.hasher ?? createSha256,
        onProgress: ({ committed, total }) => {
          const current = this.#rows.get(live.downloadId);
          if (current === undefined) {
            return;
          }
          const next: DownloadRecord = {
            ...current,
            committedOffset: committed,
            bytes: total ?? current.bytes,
          };
          this.#rows.set(live.downloadId, next);
          this.#emit(next);
          const last = this.#persistedOffset.get(live.downloadId) ?? 0;
          if (committed - last >= OFFSET_CHECKPOINT_BYTES) {
            this.#persistedOffset.set(live.downloadId, committed);
            void this.#persist();
          }
        },
      });

      const after = this.#rows.get(live.downloadId);
      if (after === undefined || after.state === 'removing') {
        return; // the remove path owns the file now
      }
      if (after.state === 'requested') {
        // An orderly demotion (stop / ineligible connectivity edge)
        // already reset the row — leave it resumable at its offset.
        return;
      }
      if (!outcome.ok) {
        // A begin-time resume mismatch (ledger offset > .part size —
        // e.g. a lost checkpoint after a crash) retries once from 0.
        if (
          attempt === 0 &&
          live.committedOffset > 0 &&
          outcome.error.kind === 'invalid-response'
        ) {
          const reset = await this.#setRow(
            after,
            { committedOffset: 0 },
            signal,
          );
          if (!reset.ok) {
            return;
          }
          live = reset.value;
          continue;
        }
        await this.#fail(
          after,
          outcome.error.kind,
          outcome.error.message,
          signal,
        );
        return;
      }
      const finalized = await this.#setRow(
        after,
        {
          state: 'available',
          bytes: outcome.value.bytes,
          committedOffset: outcome.value.bytes,
          checksum: outcome.value.checksum,
          mime: outcome.value.mime,
          itag: outcome.value.itag,
          expiresAtMs: outcome.value.expiresAtMs,
          error: null,
          downloadedMs: this.#deps.clock.nowMs(),
        },
        signal,
      );
      if (!finalized.ok) {
        // The bytes landed (finalize renamed the .part) but the ledger
        // write failed — surface the failure honestly instead of
        // logging success over a stranded 'transferring' row. The row
        // stays resumable at its last durable offset; next init's
        // begin-mismatch path restarts it from 0.
        await this.#fail(
          after,
          finalized.error.kind,
          finalized.error.message,
          signal,
        );
        return;
      }
      this.#persistedOffset.set(live.downloadId, outcome.value.bytes);
      this.#log(
        'info',
        `downloads: ${after.downloadId} available (${outcome.value.bytes} bytes)`,
      );
      return;
    }
  }
}

/** A signal that never fires — internal persistence is unbounded by op. */
const NEVER_CANCEL: CancellationSignal = {
  cancelled: false,
  subscribe: () => () => { },
};
