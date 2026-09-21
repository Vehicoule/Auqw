import { CancellationSource } from '../cancellation.ts';
import type { CancellationSignal, OperationContext } from '../cancellation.ts';
import { ok, err, appError } from '../errors.ts';
import type { ErrorKind, Result } from '../errors.ts';
import type {
  DownloadRecord,
  QueueOccurrence,
  Recording,
  Settings,
  SourceRef,
} from '../domain.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import type { PersistedState } from '../ports/storage.ts';
import type { PlayableResource } from '../ports/provider.ts';
import {
  FakeClock,
  FakeConnectivity,
  FakeLog,
  FakeStorage,
  FakeTransfer,
  SequenceIds,
} from '../testing/fakes.ts';
import { assert, assertEqual, assertDeepEqual } from '../testing/assert.ts';
import { DownloadManager } from './download-manager.ts';
import { createSha256 } from './sha256.ts';
import type { RangeFetch, RangeFetchResponse } from './transfer-policy.ts';

function sha256hex(content: Uint8Array): string {
  const h = createSha256();
  h.update(content);
  return h.digest();
}

/**
 * DownloadManager FSM + scheduler — fake ports, real wire rules:
 * the scriptable fetch answers real Content-Range responses so the
 * manager's mint/resume path runs the policy end to end.
 */

const NEVER = { cancelled: false, subscribe: () => () => { } };

function bytes(n: number): Uint8Array {
  return new Uint8Array(Array.from({ length: n }, (_, i) => i % 251));
}

function ref(id: string): SourceRef {
  return { provider: 'ytm', kind: 'track', id };
}

function recording(id: string): Recording {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    durationMs: 300_000,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs: [ref(id)],
    mappings: [],
    provenance: 'provider',
  };
}

// Every recordingId the suite exercises — storage validates the merged
// document exactly like sqlite, so download/queue rows need parents.
const REC_IDS = ['rec-1', 'rec-2', 'rec-a', 'rec-b', 'rec-p', 'rec-r', 'rec-v'];

function settings(downloadMetered = false): Settings {
  return {
    catalogProvider: 'itunes',
    playbackProvider: 'ytm',
    storefront: null,
    qualityKbps: 160,
    theme: 'system',
    prefetch: true,
    downloadMetered,
  };
}

function queue(
  occurrences: readonly QueueOccurrence[],
  currentOccurrenceId: string | null = null,
): QueueSnapshot {
  return {
    revision: 0,
    occurrences,
    currentOccurrenceId,
    positionMs: 0,
    mode: 'stopped',
  };
}

function persisted(downloads: readonly DownloadRecord[]): PersistedState {
  return {
    recordings: REC_IDS.map(recording),
    likes: [],
    entities: [],
    entitySourceRefs: [],
    playlists: [],
    playlistEntries: [],
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    lyricsCache: [],
    artworkCache: [],
    downloads: [...downloads],
    localSources: [],
    localFiles: [],
    queue: { revision: 0, occurrences: [], currentOccurrenceId: null, positionMs: 0, mode: 'stopped' },
    settings: settings(),
  };
}

/** Microtask drain — every fake resolves through already-resolved promises. */
async function drain(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/** A content-serving range fetch; `stallAt` (request index) hangs on signal. */
function wire(content: Uint8Array) {
  const ranges: string[] = [];
  const fetch: RangeFetch = (url, init, signal) => {
    const header = init.headers['Range'] ?? '';
    ranges.push(header);
    const m = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (m === null) {
      return Promise.resolve(resp(400, new Uint8Array(0), null));
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), content.length - 1);
    if (start >= content.length) {
      return Promise.resolve(
        resp(416, new Uint8Array(0), `bytes */${content.length}`),
      );
    }
    const slice = content.slice(start, end + 1);
    const body = slice.slice().buffer;
    return Promise.resolve(
      resp(206, slice, `bytes ${start}-${end}/${content.length}`, body),
    );
  };
  return { fetch, ranges };
}

function resp(
  status: number,
  data: Uint8Array,
  contentRange: string | null,
  body?: ArrayBuffer,
): RangeFetchResponse {
  return {
    status,
    headers: {
      get: (name) => (name === 'content-range' ? contentRange : null),
    },
    arrayBuffer: async () => body ?? data.slice().buffer,
  };
}

type Rig = {
  manager: DownloadManager;
  transfer: FakeTransfer;
  storage: FakeStorage;
  connectivity: FakeConnectivity;
  clock: FakeClock;
  ids: SequenceIds;
  log: FakeLog;
  content: Uint8Array;
  wire: { fetch: RangeFetch; ranges: string[] };
  mints: { resumeOffset: number | null; pinItag: number | null }[];
  signal: CancellationSignal;
};

function rig(over: {
  downloads?: readonly DownloadRecord[];
  content?: Uint8Array;
  online?: boolean;
  metered?: boolean;
  meteredAllowed?: boolean;
  queue?: QueueSnapshot;
  mintError?: ErrorKind;
  wireFetch?: RangeFetch;
} = {}): Rig {
  const content = over.content ?? bytes(3 * 1024 * 1024 + 7);
  const wireImpl = over.wireFetch !== undefined
    ? { fetch: over.wireFetch, ranges: [] as string[] }
    : wire(content);
  const storage = new FakeStorage(persisted(over.downloads ?? []));
  const transfer = new FakeTransfer();
  const connectivity = new FakeConnectivity();
  connectivity.state = {
    online: over.online ?? true,
    metered: over.metered ?? false,
  };
  const clock = new FakeClock(1_000);
  const ids = new SequenceIds();
  const log = new FakeLog();
  const queueState = over.queue ?? queue([]);
  const mints: Rig['mints'] = [];
  const mintError = over.mintError;
  const resolvePlayback = (
    _r: SourceRef,
    input: { resumeOffset: number | null; pinItag: number | null },
    _ctx: OperationContext,
  ): Promise<Result<PlayableResource>> => {
    if (mintError !== undefined) {
      return Promise.resolve(err(appError(mintError, 'mint failed')));
    }
    mints.push(input);
    return Promise.resolve(
      ok({
        url: 'https://cdn.test/f',
        mime: 'audio/mp4',
        bitrateKbps: 160,
        expiresAtMs: clock.nowMs() + 60_000,
        contentLength: content.length,
        client: 'test',
        itag: 140,
      }),
    );
  };
  const manager = new DownloadManager({
    storage,
    transfer,
    connectivity,
    clock,
    ids,
    log,
    fetchImpl: wireImpl.fetch,
    resolvePlayback,
    queue: () => queueState,
    settings: () => settings(over.meteredAllowed),
  });
  return {
    manager,
    transfer,
    storage,
    connectivity,
    clock,
    ids,
    log,
    content,
    wire: wireImpl,
    mints,
    signal: NEVER,
  };
}

function row(
  partial: Partial<DownloadRecord> & { downloadId: string },
): DownloadRecord {
  return {
    recordingId: 'rec-1',
    provider: 'ytm',
    sourceRef: ref('t1'),
    filePath: `dl-${partial.downloadId}`,
    bytes: 0,
    state: 'requested',
    committedOffset: 0,
    checksum: null,
    mime: null,
    itag: null,
    expiresAtMs: null,
    error: null,
    priority: 2,
    requestedMs: 1,
    downloadedMs: null,
    ...partial,
  };
}

const oc = (occurrenceId: string, recordingId: string): QueueOccurrence => ({
  occurrenceId,
  recordingId,
  selectedRef: null,
});

async function happyPath(): Promise<void> {
  const r = rig();
  // The fake sink reports this digest as the finalized file's hash —
  // pin it to the real content sha so the ledger checksum is the true one.
  r.transfer.enqueueSink({ digest: sha256hex(r.content) });
  await r.manager.init([], r.signal);
  const req = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  assert(req.ok, 'request ok');
  assertEqual(req.value.state, 'requested', 'starts requested');
  await drain(200);
  const rec = r.manager.recordFor('rec-1');
  assert(rec !== null && rec.state === 'available', 'reaches available');
  assertEqual(rec?.bytes, r.content.length, 'bytes = content length');
  assertEqual(rec?.committedOffset, r.content.length, 'committed');
  assert(rec?.checksum !== null && rec.checksum.length === 64, 'sha256 set');
  assert(r.transfer.sinks.length === 1, 'one sink');
  assertEqual(r.transfer.sinks[0]?.finalizedWith, rec?.checksum, 'digest cross-check');
  const last = r.storage.commits[r.storage.commits.length - 1];
  assertEqual(last?.batch.downloads?.[0]?.state, 'available', 'ledger persisted');
}

async function dedupeSameMapping(): Promise<void> {
  const r = rig();
  await r.manager.init([], r.signal);
  const a = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  const b = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  assert(b.ok && a.ok, 'both ok');
  assertEqual(b.value.downloadId, a.ok ? a.value.downloadId : '', 'same row');
  await drain(200);
  assertEqual(r.transfer.sinks.length, 1, 'one transfer only');
}

async function replacesMapping(): Promise<void> {
  const r = rig();
  await r.manager.init([], r.signal);
  const a = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  assert(a.ok);
  await drain(200);
  const b = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t2') }, r.signal);
  assert(b.ok && b.value.downloadId !== a.value.downloadId, 'new row id');
  assertDeepEqual(r.transfer.removedFiles, [a.value.filePath], 'old file removed');
}

async function failedRetryInPlace(): Promise<void> {
  const r = rig();
  r.transfer.enqueueSink({
    writeError: appError('storage-full', 'no space'),
    failWritesAfter: 0,
  });
  await r.manager.init([], r.signal);
  const a = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  assert(a.ok);
  await drain(200);
  const failed = r.manager.recordFor('rec-1');
  assertEqual(failed?.state, 'failed_with_retry', 'typed failure');
  assertEqual(failed?.error?.kind, 'storage-full', 'storage-full typed');
  // Same mapping re-request retries the row in place — same id, same file.
  const b = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  assert(b.ok && b.value.downloadId === a.value.downloadId, 'retries in place');
  await drain(200);
  const done = r.manager.recordFor('rec-1');
  assertEqual(done?.state, 'available', 'second attempt completes');
  assertEqual(r.transfer.sinks.length, 2, 'second sink consumed');
}

async function oneAtATime(): Promise<void> {
  const r = rig();
  await r.manager.init([], r.signal);
  await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  await r.manager.request({ recordingId: 'rec-2', sourceRef: ref('t2') }, r.signal);
  await drain(200);
  assertEqual(r.transfer.sinks.length, 2, 'both eventually ran');
  assertEqual(r.manager.recordFor('rec-1')?.state, 'available');
  assertEqual(r.manager.recordFor('rec-2')?.state, 'available');
}

async function priorityBands(): Promise<void> {
  const r = rig({
    online: false,
    queue: queue(
      [oc('occ-a', 'rec-a'), oc('occ-b', 'rec-b')],
      'occ-b',
    ),
  });
  await r.manager.init([], r.signal);
  // Queue both behind the offline gate so the band sort decides the
  // order — rec-1 is explicit (band 2), rec-b is now-playing (band 0).
  await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('x1') }, r.signal);
  await r.manager.request({ recordingId: 'rec-b', sourceRef: ref('xb') }, r.signal);
  r.connectivity.set({ online: true, metered: false });
  await drain(300);
  const firstId = r.transfer.beginCalls[0]?.destPath;
  assertEqual(firstId, r.manager.recordFor('rec-b')?.filePath, 'now-playing first');
  const ordered = r.manager.list().map((p) => p.recordingId);
  assertDeepEqual(ordered, ['rec-b', 'rec-1'], 'list sorted band-major');
}

async function offlineWaits(): Promise<void> {
  const r = rig({ online: false });
  await r.manager.init([], r.signal);
  await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  await drain(200);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'requested', 'stays requested');
  assertEqual(r.transfer.sinks.length, 0, 'no transfer while offline');
  r.connectivity.set({ online: true, metered: false });
  await drain(200);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'available', 'edge resumes');
}

async function meteredGate(): Promise<void> {
  const r = rig({ metered: true });
  await r.manager.init([], r.signal);
  await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  await drain(200);
  assertEqual(r.transfer.sinks.length, 0, 'metered waits');
  r.connectivity.set({ online: true, metered: false });
  await drain(200);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'available', 'unmetered runs');
}

async function meteredAllowed(): Promise<void> {
  const r = rig({ metered: true, meteredAllowed: true });
  await r.manager.init([], r.signal);
  await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  await drain(200);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'available', 'opt-in runs on metered');
}

async function cancelRequested(): Promise<void> {
  const r = rig({ online: false });
  await r.manager.init([], r.signal);
  await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  await drain(50);
  const rec = r.manager.recordFor('rec-1');
  assert(rec !== null);
  const cancelled = await r.manager.cancel(rec.downloadId, r.signal);
  assert(cancelled.ok);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'failed_with_retry');
  assertEqual(r.manager.recordFor('rec-1')?.error?.kind, 'cancelled');
}

async function removeDeletes(): Promise<void> {
  const r = rig();
  await r.manager.init([], r.signal);
  const req = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  assert(req.ok);
  await drain(200);
  const removed = await r.manager.remove(req.value.downloadId, r.signal);
  assert(removed.ok);
  assertEqual(r.manager.recordFor('rec-1'), null, 'row dropped');
  assert(r.transfer.removedFiles.includes(req.value.filePath), 'file removed');
  assert(
    (r.storage.commits[r.storage.commits.length - 1]?.batch.downloads?.length ?? -1) === 0,
    'ledger cleared',
  );
}

async function requestAllSnapshots(): Promise<void> {
  const r = rig();
  await r.manager.init([], r.signal);
  const all = await r.manager.requestAll(
    [
      { recordingId: 'rec-1', sourceRef: ref('t1') },
      { recordingId: 'rec-2', sourceRef: ref('t2') },
    ],
    r.signal,
  );
  assert(all.ok);
  await drain(300);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'available');
  assertEqual(r.manager.recordFor('rec-2')?.state, 'available');
}

async function initIntegrity(): Promise<void> {
  const partial = row({
    downloadId: 'dl-p1',
    recordingId: 'rec-p',
    filePath: 'dl-p1',
    state: 'transferring',
    committedOffset: 1024 * 1024,
    bytes: 3 * 1024 * 1024 + 7,
    itag: 140,
    expiresAtMs: 5_000,
  });
  const vanished = row({
    downloadId: 'dl-v1',
    recordingId: 'rec-v',
    filePath: 'dl-v1',
    state: 'available',
    bytes: 10,
    committedOffset: 10,
    downloadedMs: 1,
  });
  const removing = row({
    downloadId: 'dl-r1',
    recordingId: 'rec-r',
    filePath: 'dl-r1',
    state: 'removing',
    bytes: 10,
    committedOffset: 10,
  });
  const r = rig({ downloads: [partial, vanished, removing] });
  r.transfer.statResults.set('dl-v1', { exists: false, bytes: null });
  await r.manager.init([partial, vanished, removing], r.signal);
  await drain(300);
  // removing finished its delete
  assert(r.transfer.removedFiles.includes('dl-r1'), 'removing finished');
  assertEqual(r.manager.recordFor('rec-r'), null, 'removed row gone');
  // vanished available row degraded — dropped, degrades to streaming
  assertEqual(r.manager.recordFor('rec-v'), null, 'vanished dropped');
  // interrupted transfer resumed from the durable offset
  const resumed = r.manager.recordFor('rec-p');
  assertEqual(resumed?.state, 'available', 'resumed to available');
  assertEqual(
    r.transfer.beginCalls[0]?.resumeAtBytes,
    1024 * 1024,
    'resumed at committed offset',
  );
  assert(r.mints[0]?.resumeOffset === 1024 * 1024, 'mint pinned offset');
  assert(r.mints[0]?.pinItag === 140, 'mint pinned itag');
  // sweep kept only the live row's .part
  assertDeepEqual(
    r.transfer.sweepCalls[0]?.sort(),
    ['dl-p1.part'],
    'sweep keeps owned partials',
  );
}

/**
 * Mid-flight cancel: chunk 1 stalls on the signal so the cancel edge
 * lands while the transfer is in the loop — row lands
 * failed_with_retry('cancelled'), the .part is kept for resume.
 */
async function cancelInFlight(): Promise<void> {
  const content = bytes(3 * 1024 * 1024);
  let calls = 0;
  const stallingFetch: RangeFetch = (_url, init, signal) => {
    const header = init.headers['Range'] ?? '';
    const m = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (m === null) {
      return Promise.resolve(resp(400, new Uint8Array(0), null));
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), content.length - 1);
    calls += 1;
    if (calls === 1) {
      const slice = content.slice(start, end + 1);
      return Promise.resolve(
        resp(206, slice, `bytes ${start}-${end}/${content.length}`, slice.slice().buffer),
      );
    }
    return new Promise((_res, rej) => {
      signal.subscribe(() => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        rej(error);
      });
    });
  };
  const r = rig({ content, wireFetch: stallingFetch });
  await r.manager.init([], r.signal);
  const req = await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  assert(req.ok);
  await drain(100);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'transferring', 'in flight');
  const done = await r.manager.cancel(req.value.downloadId, r.signal);
  assert(done.ok, 'cancel ok');
  await drain(100);
  const rec = r.manager.recordFor('rec-1');
  assertEqual(rec?.state, 'failed_with_retry', 'lands failed');
  assertEqual(rec?.error?.kind, 'cancelled', 'typed cancelled');
  assertEqual(rec?.committedOffset, 1024 * 1024, 'partial offset kept');
  assertEqual(r.transfer.sinks[0]?.abortedKeep, true, '.part kept');
}

/**
 * remove() must wait for the runner's real teardown — a slow abort
 * (fsync'd .part close, scale of a real task) can't be outrun by a
 * microtask drain before the file delete lands.
 */
async function removeWaitsForRunner(): Promise<void> {
  const content = bytes(2 * 1024 * 1024);
  let calls = 0;
  const stallingFetch: RangeFetch = (_url, init, signal) => {
    const header = init.headers['Range'] ?? '';
    const m = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (m === null) {
      return Promise.resolve(resp(400, new Uint8Array(0), null));
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), content.length - 1);
    calls += 1;
    if (calls === 1) {
      const slice = content.slice(start, end + 1);
      return Promise.resolve(
        resp(206, slice, `bytes ${start}-${end}/${content.length}`, slice.slice().buffer),
      );
    }
    return new Promise((_res, rej) => {
      signal.subscribe(() => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        rej(error);
      });
    });
  };
  const r = rig({ content, wireFetch: stallingFetch });
  // abort() resolves on a caller-held latch — teardown stays pending
  // well past any bounded drain until the test releases it.
  let releaseAbort: () => void = () => {};
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const innerBegin = r.transfer.begin.bind(r.transfer);
  r.transfer.begin = async (input, signal) => {
    const got = await innerBegin(input, signal);
    if (!got.ok) {
      return got;
    }
    const inner = got.value;
    return ok({
      write: (b: Uint8Array) => inner.write(b),
      commit: () => inner.commit(),
      finalize: (d: string | null) => inner.finalize(d),
      abort: async (keep: boolean) => {
        await abortGate;
        return inner.abort(keep);
      },
    });
  };
  await r.manager.init([], r.signal);
  const req = await r.manager.request(
    { recordingId: 'rec-1', sourceRef: ref('t1') },
    r.signal,
  );
  assert(req.ok);
  await drain(100);
  assertEqual(r.manager.recordFor('rec-1')?.state, 'transferring', 'in flight');
  let settled = false;
  const removal = r.manager
    .remove(req.value.downloadId, r.signal)
    .then((res) => {
      settled = true;
      return res;
    });
  // Far past the bounded drain the old code relied on — removal still
  // must not land while the runner's abort is outstanding.
  await drain(400);
  assert(!settled, 'remove waits on runner teardown');
  releaseAbort();
  const done = await removal;
  assert(done.ok, 'remove resolves after teardown');
  assert(
    r.transfer.removedFiles.includes(req.value.filePath),
    'file removed after close',
  );
  assertEqual(r.manager.recordFor('rec-1'), null, 'row dropped');
}

async function mintFailureTyped(): Promise<void> {
  const r = rig({ mintError: 'expired' });
  await r.manager.init([], r.signal);
  await r.manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, r.signal);
  await drain(100);
  const rec = r.manager.recordFor('rec-1');
  assertEqual(rec?.state, 'failed_with_retry');
  assertEqual(rec?.error?.kind, 'expired', 'expired mint typed');
  assertEqual(r.transfer.sinks.length, 0, 'no sink opened');
}

async function usageReports(): Promise<void> {
  const r = rig();
  r.transfer.usageBytes = 12_345;
  r.transfer.free = 999;
  await r.manager.init([], r.signal);
  const u = await r.manager.usage(r.signal);
  assert(u.ok);
  assertEqual(u.value.bytes, 12_345);
  assertEqual(u.value.free, 999);
}

async function rebandsOnQueueChange(): Promise<void> {
  let q = queue([]);
  const r = rig({ queue: queue([]) });
  // Recreate manager with live queue reference.
  const manager = new DownloadManager({
    storage: r.storage,
    transfer: r.transfer,
    connectivity: r.connectivity,
    clock: r.clock,
    ids: r.ids,
    log: r.log,
    fetchImpl: r.wire.fetch,
    resolvePlayback: () =>
      Promise.resolve(
        ok({
          url: 'https://cdn.test/f',
          mime: 'audio/mp4',
          bitrateKbps: 160,
          expiresAtMs: r.clock.nowMs() + 60_000,
          contentLength: r.content.length,
          client: 'test',
          itag: 140,
        }),
      ),
    queue: () => q,
    settings: () => settings(),
  });
  r.connectivity.state = { online: false, metered: false };
  await manager.init([], NEVER);
  const req = await manager.request({ recordingId: 'rec-1', sourceRef: ref('t1') }, NEVER);
  assert(req.ok);
  assertEqual(req.value.priority, 2, 'explicit band');
  q = queue([oc('occ-1', 'rec-1')], 'occ-1');
  const rebanded = await manager.updatePriorities(NEVER);
  assert(rebanded.ok);
  const rec = manager.recordFor('rec-1');
  assertEqual(rec?.priority, 0, 'rebands to now-playing');
}

export async function run(): Promise<void> {
  await happyPath();
  await dedupeSameMapping();
  await replacesMapping();
  await failedRetryInPlace();
  await oneAtATime();
  await priorityBands();
  await offlineWaits();
  await meteredGate();
  await meteredAllowed();
  await cancelRequested();
  await cancelInFlight();
  await removeWaitsForRunner();
  await removeDeletes();
  await requestAllSnapshots();
  await initIntegrity();
  await mintFailureTyped();
  await usageReports();
  await rebandsOnQueueChange();
}
