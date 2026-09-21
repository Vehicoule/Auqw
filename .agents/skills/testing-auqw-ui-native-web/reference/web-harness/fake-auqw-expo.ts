// Fake `auqw-expo` module for the web harness. Satisfies the
// AuqwExpoLike surface (host + seam player + connectivity + TagReader +
// FGS driver). Runtime-only — Metro aliases it in; TS still typechecks
// against the real module so this file lives outside src/.
//
// Control surface (from the patched dist/index.html or DevTools):
//   window.__auqwConn.set(online, metered) — connectivity edges
//   window.__fgsCalls                      — downloadsActiveChanged log
//   window.__auqwMediaUrl                  — stream URL (https range
//     endpoint); must equal the bytes the https server serves, and
//     MEDIA_BYTES must equal its exact content length or
//     transfer-policy fails with "Content-Range total changed
//     mid-stream".

type Subscription = { remove(): void };
type Listener<E> = (e: E) => void;

function channel<E>() {
  const listeners = new Set<Listener<E>>();
  return {
    emit(e: E) {
      for (const l of [...listeners]) l(e);
    },
    add(l: Listener<E>): Subscription {
      listeners.add(l);
      return { remove: () => listeners.delete(l) };
    },
  };
}

const ATTEMPT = {
  requestId: '',
  steps: 1,
  httpCalls: 1,
  bytes: 0,
  fuelUsed: 5,
  elapsedMs: 12,
  httpTrace: [],
  guestLog: [],
};

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

// ---- connectivity — controllable via window.__auqwConn ----
const connChan = channel<{ online: boolean; metered: boolean }>();
const conn = {
  online: true,
  metered: false,
  watchers: 0,
  set(online: boolean, metered = false) {
    if (online === this.online && metered === this.metered) return;
    this.online = online;
    this.metered = metered;
    connChan.emit({ online, metered });
  },
};
(globalThis as any).__auqwConn = conn;
(globalThis as any).__fgsCalls = [] as number[];

export function connectivitySnapshot() {
  return Promise.resolve({ online: conn.online, metered: conn.metered });
}
export function connectivityWatch() {
  conn.watchers += 1;
  // Baseline edge on watch, like the Kotlin monitor.
  queueMicrotask(() => connChan.emit({ online: conn.online, metered: conn.metered }));
}
export function connectivityUnwatch() {
  conn.watchers -= 1;
}
export function addConnectivityChangedListener(l: Listener<{ online: boolean; metered: boolean }>) {
  return connChan.add(l);
}

// ---- plugin host — canned outcomes ----
const reqChan = channel<{ requestId: string; outcome: unknown }>();
const resolveChan = channel<{ requestId: string; outcome: unknown }>();
const prepChan = channel<{
  requestId: string;
  attemptId: string;
  queueRev: number;
  outcome: unknown;
}>();
const statusChan = channel<Record<string, unknown>>();
const markChan = channel<Record<string, unknown>>();
const transitionChan = channel<Record<string, unknown>>();

const MEDIA_URL = 'https://localhost:8088/media/track.wav';
// MUST equal the served file's exact byte count (64 KiB for the
// generated default in server.mjs).
const MEDIA_BYTES = 65536;

const CANNED_TRACK = {
  source_ref: { provider: 'youtube-music', kind: 'track', id: 'mock-1' },
  title: 'Harness Track',
  artist: 'Mock Artist',
  album: 'Mock Album',
  duration_ms: 64_000,
  release_year: 2024,
  artwork: null,
  explicit: null,
  genre: 'Test',
  storefront: 'US',
  artist_ref: null,
  album_ref: null,
  isrc: null,
};

// Canned capability results — the resultJson decoders reject on shape,
// so these track the ABI wire format (snake_case).
function cannedResult(capability: string): string {
  switch (capability) {
    case 'catalog.search':
      return JSON.stringify({ items: [CANNED_TRACK, { ...CANNED_TRACK, title: 'Second Track', source_ref: { provider: 'youtube-music', kind: 'track', id: 'mock-2' } }], storefront: 'US' });
    case 'playback.resolve':
      return JSON.stringify({
        url: MEDIA_URL,
        mime: 'audio/wav',
        bitrate_kbps: 1411,
        expires_at_ms: null,
        client: 'web-harness',
        content_length: MEDIA_BYTES,
      });
    case 'catalog.metadata':
      return JSON.stringify({ items: [CANNED_TRACK] });
    default:
      return JSON.stringify({ items: [] });
  }
}

export function createHost(): Promise<void> {
  return Promise.resolve();
}
export function setAuthToken(_token: string | null): void {}
export function loadPlugin(_wasm: string, manifestJson: string): Promise<string> {
  return Promise.resolve(`pl-${JSON.parse(manifestJson).id ?? 'x'}`);
}
export function runSpin(): Promise<unknown> {
  return Promise.resolve({ elapsedMs: 1, fuelUsed: 1, kind: 'ok' });
}

export function startRequest(
  _pluginId: string,
  capability: string,
  _payload: Record<string, unknown>,
): Promise<string> {
  const requestId = nextId('req');
  queueMicrotask(() =>
    reqChan.emit({
      requestId,
      outcome: {
        type: 'succeeded',
        resultJson: cannedResult(capability),
        attempt: { ...ATTEMPT, requestId },
      },
    }),
  );
  return Promise.resolve(requestId);
}
export function startResolve(_pluginId: string, _sourceRef: string): Promise<string> {
  const requestId = nextId('res');
  queueMicrotask(() =>
    resolveChan.emit({
      requestId,
      outcome: {
        type: 'resolved',
        resource: {
          url: MEDIA_URL,
          mime: 'audio/wav',
          bitrateKbps: 1411,
          client: 'web-harness',
          contentLength: MEDIA_BYTES,
        },
        attempt: { ...ATTEMPT, requestId },
      },
    }),
  );
  return Promise.resolve(requestId);
}
export function cancel(_requestId: string): void {}

export function addRequestOutcomeListener(l: Listener<unknown>) {
  return reqChan.add(l);
}
export function addResolveOutcomeListener(l: Listener<unknown>) {
  return resolveChan.add(l);
}
export function addPrepareOutcomeListener(l: Listener<unknown>) {
  return prepChan.add(l);
}
export function addPlaybackStatusListener(l: Listener<Record<string, unknown>>) {
  return statusChan.add(l);
}
export function addPhaseMarkListener(l: Listener<Record<string, unknown>>) {
  return markChan.add(l);
}
export function addQueueTransitionListener(l: Listener<Record<string, unknown>>) {
  return transitionChan.add(l);
}

// ---- seam player — emits a prepared outcome then 'playing' status ----
export function prepare(
  _provider: string,
  _sourceRef: string,
  attemptId: string,
  queueRev: number,
): Promise<string> {
  const requestId = nextId('prep');
  const handle = nextId('h');
  queueMicrotask(() =>
    prepChan.emit({
      requestId,
      attemptId,
      queueRev,
      outcome: {
        type: 'prepared',
        stream: { handle, mime: 'audio/wav', contentLength: MEDIA_BYTES },
        attempt: { ...ATTEMPT, requestId },
      },
    }),
  );
  return Promise.resolve(requestId);
}
export function prepareLocal(_path: string, mime?: string | null): Promise<string> {
  return Promise.resolve(`lf-${++seq}:${mime ?? 'audio/*'}`);
}
export function play(handle: string, attemptId: string, queueRev: number): Promise<void> {
  queueMicrotask(() =>
    statusChan.emit({
      handle,
      attemptId,
      queueRev,
      state: 'playing',
      positionMs: 0,
      durationMs: 64_000,
    }),
  );
  return Promise.resolve();
}
export function pause(): Promise<void> {
  return Promise.resolve();
}
export function seekTo(_positionMs: number): Promise<void> {
  return Promise.resolve();
}
export function stop(): Promise<void> {
  return Promise.resolve();
}
export function cancelPrepare(_requestId: string): Promise<void> {
  return Promise.resolve();
}
export function releaseStream(_handle: string): Promise<void> {
  return Promise.resolve();
}
export function phaseMarks(_handle: string): Promise<unknown> {
  return Promise.resolve({ marks: [] });
}
// MUST resolve a Result-like value the caller accepts — the real
// signature is Promise<void>; returning undefined resolves fine. A
// bare throwing stub wedges the queue and sets session
// persistenceError.
export function setQueueProjection(_p: unknown): Promise<void> {
  return Promise.resolve();
}
export function downloadsActiveChanged(active: number): Promise<void> {
  (globalThis as any).__fgsCalls.push(active);
  return Promise.resolve();
}
export function devAttachFile(path: string): Promise<string> {
  return Promise.resolve(`dev-${path}`);
}
export function devPrepareUrl(): Promise<string> {
  return Promise.resolve('dev-h');
}

// ---- TagReader — SAF picker is untestable on web; honest no-result ----
export function tagPickFolder(): Promise<never> {
  return Promise.reject(Object.assign(new Error('SAF picker unavailable on web'), { kind: 'no-result' }));
}
export function tagEnumerate(_treeUri: string): Promise<readonly unknown[]> {
  return Promise.resolve([]);
}
export function tagFingerprint(_treeUri: string, docIds: readonly string[]): Promise<readonly null[]> {
  return Promise.resolve(docIds.map(() => null));
}
export function tagRead(_treeUri: string, docIds: readonly string[]): Promise<readonly null[]> {
  return Promise.resolve(docIds.map(() => null));
}
export function docUri(_treeUri: string, docId: string): string {
  return `file:///harness/${docId}`;
}
