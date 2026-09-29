import type { ErrorKind } from '@auqw/application';
import { appError, appErrorKind } from '@auqw/application';
import type { AppError } from '@auqw/application';
import type * as AuqwExpo from 'auqw-expo';

/**
 * The injected surface of the `auqw-expo` native module — a workspace
 * member whose `src/index.ts` is the single source of truth for the
 * wire shapes, so the payload/event types below are aliases of its
 * exports rather than hand-mirrored declarations. Adapters keep
 * taking these structural interfaces (never the module value itself)
 * so tests can inject fakes.
 */

type Module = typeof import('auqw-expo');

export type AuqwExpoSubscription = { remove(): void };

export type AuqwExpoRequestOutcome = AuqwExpo.RequestOutcome;

export type AuqwExpoRequestOutcomeEvent = AuqwExpo.RequestOutcomeEvent;

export type AuqwExpoPrepareOutcomeEvent = AuqwExpo.PrepareOutcomeEvent;

export type AuqwExpoPlaybackStatusEvent = AuqwExpo.PlaybackStatusEvent;

export type AuqwExpoPhaseMarkEvent = AuqwExpo.PhaseMarkEvent;

export type AuqwExpoQueueTransitionEvent = AuqwExpo.QueueTransitionEvent;

/** Generic capability requests (the plugin-host side of the module). */
export type AuqwExpoHostLike = Pick<
  Module,
  'startRequest' | 'cancel' | 'addRequestOutcomeListener'
>;

/** The transport side of the module (the streaming seam). */
export type AuqwExpoPlayerLike = Pick<
  Module,
  | 'prepare'
  /**
   * provider:'local' attach — registers an `lf-*` handle for a
   * device-owned file path or content URI. No stream session:
   * release/cancel are bookkeeping no-ops.
   */
  | 'prepareLocal'
  | 'play'
  | 'pause'
  | 'seekTo'
  | 'stop'
  | 'cancelPrepare'
  | 'releaseStream'
  | 'setQueueProjection'
  | 'addPrepareOutcomeListener'
  | 'addPlaybackStatusListener'
  | 'addPhaseMarkListener'
  | 'addQueueTransitionListener'
>;

/** The waveform-peaks extractor surface — Android only; the methods
 *  are absent on iOS so adapters gate on their presence. */
export type AuqwPeaksNative = {
  /**
   * Decode the stream's own bytes into raw per-window RMS magnitudes —
   * resolves with `count` flat `[up, down]` pairs (the `PeakWindow`
   * shape before JS-side normalization). Rejects with coded errors in
   * the application taxonomy (`unavailable`/`released`/
   * `budget-exceeded`/`not-applicable`/`invalid-response`/`cancelled`).
   */
  waveformPeaks?(
    requestId: string,
    handle: string,
    count: number,
    maxBytes: number,
    provisionalCap: boolean,
  ): Promise<readonly number[]>;
  waveformPeaksCancel?(requestId: string): void;
};

/** The whole module: host + player + lifecycle. */
export type AuqwExpoLike = AuqwExpoHostLike &
  AuqwExpoPlayerLike &
  AuqwPeaksNative &
  Pick<
    Module,
    | 'createHost'
    | 'setAuthToken'
    /**
     * Live PO-token provider update — resolves read the host's slot
     * at invocation spawn, so a pairing or unpairing that lands after
     * `createHost` applies without recreating the host. `null`
     * restores the anonymous resolve ladder.
     */
    | 'setPotProvider'
    | 'loadPlugin'
  >;

/**
 * The host half plus lifecycle — satisfied by the `auqw-expo` module
 * (which absorbed the retired slice-0 `auqw-plugin-host-expo` surface).
 */
export type AuqwExpoHostModuleLike = AuqwExpoHostLike &
  Pick<
    Module,
    'createHost' | 'setAuthToken' | 'setPotProvider' | 'loadPlugin'
  >;

/**
 * Conformance gate for the module's hand-declared `ErrorKind` union:
 * `auqw-expo` cannot depend on @auqw/application, so parity with the
 * canonical taxonomy is asserted here — the one package that sees
 * both sides — at typecheck time. A missing or extra member collapses
 * the check to a `false` constraint violation.
 */
type AssertTrue<Check extends true> = Check;
export type AuqwExpoErrorKindParity = AssertTrue<
  Record<AuqwExpo.ErrorKind, true> extends Record<ErrorKind, true>
    ? Record<ErrorKind, true> extends Record<AuqwExpo.ErrorKind, true>
      ? true
      : false
    : false
>;

/**
 * Seam/ABI `kind` strings → the application taxonomy. The canonical
 * slug map lives in @auqw/application (`ERROR_KIND_BY_SLUG`,
 * {@link appErrorKind}); a kind outside it degrades to `internal`
 * rather than leaking an untyped string across the port.
 */
export { appErrorKind };

/**
 * Maps a value thrown by a native call to a typed AppError. Expo
 * rejections are `Error`s; a `kind`/`code` string property (the
 * module's coded-error convention) picks the taxonomy kind, anything
 * else is `internal`. The message crosses because the seam contract
 * already carries human-readable failure text — it never carries
 * signed URLs.
 */
export function nativeError(thrown: unknown): AppError {
  let kind: ErrorKind = 'internal';
  if (typeof thrown === 'object' && thrown !== null) {
    const coded = thrown as { kind?: unknown; code?: unknown };
    const raw =
      typeof coded.kind === 'string'
        ? coded.kind
        : typeof coded.code === 'string'
          ? coded.code
          : null;
    if (raw !== null) {
      kind = appErrorKind(raw);
    }
  }
  const message =
    thrown instanceof Error && thrown.message.length > 0
      ? thrown.message
      : 'native call failed';
  return appError(kind, message);
}

// ---------------------------------------------------------------------------
// Connectivity monitor — the auqw-expo `connectivity*` surface.
// ---------------------------------------------------------------------------

export type AuqwConnectivityEvent = AuqwExpo.ConnectivityChangedEvent;

export type AuqwConnectivityNative = Pick<
  Module,
  | 'connectivitySnapshot'
  | 'connectivityWatch'
  | 'connectivityUnwatch'
  | 'addConnectivityChangedListener'
>;

// ---------------------------------------------------------------------------
// Sync socket — the auqw-expo `sync*` surface (slice 4).
// ---------------------------------------------------------------------------

export type AuqwSyncNative = Pick<
  Module,
  | 'syncConnect'
  | 'syncSend'
  | 'syncClose'
  | 'syncDestroy'
  | 'syncRandomBytes'
  | 'addSyncSocketDataListener'
  | 'addSyncSocketClosedListener'
> & {
  // Pairing/discovery members exist on the native module but carry no
  // JS wrapper in `auqw-expo` yet, so they stay hand-declared and
  // optional — adapters gate on `=== undefined` for older builds.
  /**
   * The user-visible device name the sync hello announces (paired
   * lists show it verbatim). Optional: seam builds predating it fall
   * back to a device-id-derived label in the adapter.
   */
  syncDeviceName?(): string;
  /**
   * Pairing listener (symmetric pairing): bind an ephemeral TCP port;
   * accepted sockets mint `accept-<n>` ids that the send/close/destroy
   * calls and data/closed events all apply to. Resolves with the port.
   */
  syncListen?(): Promise<{ port: number }>;
  syncListenStop?(): Promise<void>;
  /** IPv4 addresses the listener is reachable on (QR fallbacks). */
  syncLocalHosts?(): Promise<{ hosts: string[] }>;
  /** mDNS advertise `_auqw._tcp` — TXT `dev` carries the identity fp. */
  syncAdvertise?(name: string, port: number, fp: string): Promise<void>;
  syncAdvertiseStop?(): Promise<void>;
  /** mDNS browse `_auqw._tcp` — `{type,name,host?,hosts?,port?,fp?}`
   * events; 'lost' carries the record's last-resolved port/fp when
   * known (null otherwise). */
  syncBrowse?(): Promise<void>;
  syncBrowseStop?(): Promise<void>;
  addSyncSocketAcceptedListener?(
    listener: (event: {
      socketId: string;
      remoteAddress: string;
    }) => void,
  ): AuqwExpoSubscription;
  addSyncDiscoveryListener?(
    listener: (event: {
      type: string;
      name: string;
      host?: string | null;
      /** Every resolved advert address — the JS side picks the
       * dialable one (LAN gate + ranking live in `@auqw/application`,
       * not in Kotlin). Absent on older native builds. */
      hosts?: string[];
      port?: number | null;
      fp?: string | null;
    }) => void,
  ): AuqwExpoSubscription;
};

// ---------------------------------------------------------------------------
// TagReader — the auqw-expo `tag*`/`docUri` surface (slice 3).
// ---------------------------------------------------------------------------

export type AuqwDownloadsNative = Pick<Module, 'downloadsActiveChanged'>;

export type AuqwTagReaderNative = Pick<
  Module,
  'tagPickFolder' | 'tagEnumerate' | 'tagFingerprint' | 'tagRead' | 'docUri'
>;
