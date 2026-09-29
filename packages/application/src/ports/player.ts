import {
  hasExactKeys,
  hasKeys,
  isRecord,
  isSafeNonNegative,
  isString,
} from '../domain.ts';
import type { AppError, Result } from '../errors.ts';

export type PlaybackIdentity = {
  readonly attemptId: string;
  readonly queueRev: number;
};

export type PreparedStream = {
  readonly handle: string;
  readonly mime: string;
  readonly itag?: number;
  readonly contentLength?: number;
  readonly expiresAtMs?: number;
  readonly bitrateKbps?: number;
};

export type HttpTraceEntry = {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly bytes: number;
  readonly elapsedMs: number;
};

export type GuestLogEntry = {
  readonly level: string;
  readonly message: string;
};

/** Host diagnostics for one attempt. Contains no signed URL or body. */
export type AttemptTrace = {
  readonly requestId: string;
  readonly steps: number;
  readonly httpCalls: number;
  readonly bytes: number;
  readonly fuelUsed: number;
  readonly elapsedMs: number;
  readonly httpTrace: readonly HttpTraceEntry[];
  readonly guestLog: readonly GuestLogEntry[];
};

/**
 * The trace entry the host writes in place of a pot-provider URL — the
 * provider is an operator LAN address that must not reach diagnostics,
 * even redacted. Emitted verbatim by plugin-host's `perform_call`
 * (`collect_secrets` requests).
 */
export const POT_PROVIDER_TRACE_URL = '<pot-provider>';

/** Redacted trace URLs: scheme + host/path only, never query/fragment.
 * The pot-provider sentinel is allowed in place of a URL. */
function isTraceUrl(value: unknown): value is string {
  if (value === POT_PROVIDER_TRACE_URL) {
    return true;
  }
  return (
    isString(value, 2048) &&
    (value.startsWith('http://') || value.startsWith('https://')) &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

const TRACE_LEVELS: ReadonlySet<string> = new Set([
  'debug',
  'info',
  'warn',
  'error',
]);

function isHttpTraceEntry(value: unknown): value is HttpTraceEntry {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['method', 'url', 'bytes', 'elapsedMs'], ['status'])
  ) {
    return false;
  }
  return (
    isString(value['method'], 32) &&
    isTraceUrl(value['url']) &&
    (value['status'] === undefined ||
      isSafeNonNegative(value['status'])) &&
    isSafeNonNegative(value['bytes']) &&
    isSafeNonNegative(value['elapsedMs'])
  );
}

function isGuestLogEntry(value: unknown): value is GuestLogEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['level', 'message']) &&
    typeof value['level'] === 'string' &&
    TRACE_LEVELS.has(value['level']) &&
    typeof value['message'] === 'string' &&
    value['message'].length <= 4096
  );
}

/**
 * Validates a persisted/diagnostic attempt trace: exact keys, safe
 * counters, bounded arrays, redacted URLs, and no response bodies.
 */
export function isAttemptTrace(value: unknown): value is AttemptTrace {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'requestId',
      'steps',
      'httpCalls',
      'bytes',
      'fuelUsed',
      'elapsedMs',
      'httpTrace',
      'guestLog',
    ]) &&
    isString(value['requestId'], 128) &&
    isSafeNonNegative(value['steps']) &&
    isSafeNonNegative(value['httpCalls']) &&
    isSafeNonNegative(value['bytes']) &&
    isSafeNonNegative(value['fuelUsed']) &&
    isSafeNonNegative(value['elapsedMs']) &&
    Array.isArray(value['httpTrace']) &&
    value['httpTrace'].length <= 32 &&
    value['httpTrace'].every(isHttpTraceEntry) &&
    Array.isArray(value['guestLog']) &&
    value['guestLog'].length <= 128 &&
    value['guestLog'].every(isGuestLogEntry)
  );
}

export type RepeatMode = 'off' | 'all' | 'one';

export type QueueProjectionItem = {
  readonly occurrenceId: string;
  readonly provider: string | null;
  readonly sourceRef: string | null;
  readonly title: string;
  readonly artist: string | null;
  readonly artworkUrl: string | null;
  /**
   * The session marked this row failed — forward moves (ended,
   * remote-next, repeat=all wrap) step over it the way the engine's
   * next() does; backward moves still land on it the way previous()
   * does. Absent means unmarked.
   */
  readonly skipsForward?: boolean | undefined;
};

export type QueueProjection = {
  readonly projectionId: string;
  readonly queueRev: number;
  readonly currentOccurrenceId: string | null;
  readonly positionMs: number;
  readonly mode: 'stopped' | 'paused' | 'playing';
  /**
   * The cursor's repeat rule: `all` wraps a tail move back to the head
   * (and a head `remote-previous` to the tail), `one` replays the
   * cursor item on `ended`. Manual moves never replay under `one`.
   */
  readonly repeat: RepeatMode;
  /**
   * The dealt walk order: a unique subsequence of `items` indices the
   * cursor steps through — the identity under shuffle=off. Failed rows
   * stay in the walk flagged `skipsForward` — forward moves (ended,
   * remote-next, wrap) must step over them while backward moves still
   * reach them; the current row always stays so the cursor can locate
   * itself. Canonical item order never changes; only the walk does
   * (decisions.md).
   */
  readonly order: readonly number[];
  readonly items: readonly QueueProjectionItem[];
};

export type QueueTransitionReason =
  | 'ended'
  | 'remote-next'
  | 'remote-previous';

export type PlayerEvent =
  | {
    readonly type: 'prepare';
    readonly requestId: string;
    readonly identity: PlaybackIdentity;
    readonly outcome:
    | {
      readonly type: 'prepared';
      readonly stream: PreparedStream;
      readonly attempt: AttemptTrace;
    }
    | {
      readonly type: 'failed';
      readonly error: AppError;
      readonly attempt: AttemptTrace;
    };
  }
  | {
    readonly type: 'status';
    readonly handle: string;
    readonly identity: PlaybackIdentity;
    readonly state:
    | 'idle'
    | 'buffering'
    | 'ready'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'failed';
    readonly positionMs: number;
    readonly durationMs?: number;
    readonly error?: AppError;
  }
  | {
    readonly type: 'phase';
    readonly handle: string;
    readonly identity: PlaybackIdentity;
    readonly name: string;
    readonly atMs: number;
    readonly sinceStartMs: number;
  }
  | {
    readonly type: 'queue-transition';
    readonly projectionId: string;
    readonly projectedQueueRev: number;
    readonly fromOccurrenceId: string | null;
    readonly toOccurrenceId: string | null;
    readonly reason: QueueTransitionReason;
    readonly positionMs: number;
    readonly identity: PlaybackIdentity | null;
    readonly handle: string | null;
  };

/**
 * Application methods carry playback identity even where the native
 * adapter enforces it before invoking the identity-less native calls.
 * Async methods never throw by contract.
 */
export interface PlayerPort {
  prepare(input: {
    provider: string;
    sourceRef: string;
    identity: PlaybackIdentity;
  }): Promise<Result<string>>;
  /**
   * Advisory resolve+prepare for a row the user may tap — identical
   * request/outcome contract to `prepare` (the terminal outcome still
   * arrives as a `prepare` event carrying `identity`), but carries no
   * playback intent: implementations must not touch the media element,
   * bump operation generations, or tear down attaches. The seam's own
   * policy bounds it — at most one unattached session lives at a time,
   * so a warm supersedes and is superseded exactly like a `prepare`,
   * and `cancelPrepare` abandons it while unattached. A later
   * `prepare`/`prewarm` for the same (provider, sourceRef) adopts the
   * still-live session instead of re-resolving.
   */
  prewarm(input: {
    provider: string;
    sourceRef: string;
    identity: PlaybackIdentity;
  }): Promise<Result<string>>;
  play(input: {
    handle: string;
    identity: PlaybackIdentity;
    positionMs?: number;
  }): Promise<Result<void>>;
  pause(identity: PlaybackIdentity): Promise<Result<void>>;
  seekTo(input: {
    positionMs: number;
    identity: PlaybackIdentity;
  }): Promise<Result<void>>;
  stop(identity: PlaybackIdentity): Promise<Result<void>>;
  cancelPrepare(input: {
    requestId: string;
    identity: PlaybackIdentity;
  }): Promise<Result<void>>;
  release(input: {
    handle: string;
    identity: PlaybackIdentity;
  }): Promise<Result<void>>;
  /**
   * Installs one immutable identified queue revision for background
   * execution. The service moves only a cursor inside it — it may
   * freshly resolve/attach a projected ref, never reorder/add/remove —
   * and reports `queue-transition` events for reconciliation.
   */
  setQueueProjection(projection: QueueProjection): Promise<Result<void>>;
  subscribe(listener: (event: PlayerEvent) => void): () => void;
}
