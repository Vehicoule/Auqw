import { CHANNELS } from '../shared/channels.ts';
import {
  isApprovePairResult,
  isHostApprovePairArgs,
  isHostCancelArgs,
  isHostRequestArgs,
  isHostReviewPairArgs,
  isPrepareOutcomePayload,
  isPreparedStreamPayload,
  isRequestOutcomePayload,
  isStreamCancelArgs,
  isStreamDevPrepareArgs,
  isStreamHandleArgs,
  isStreamMarksResult,
  isStreamOpenArgs,
  isStreamPrepareArgs,
  isStreamProbeArgs,
  isStreamReadArgs,
  isUserPairReviewResult,
} from '../shared/contract.ts';
import { isRecord } from '../shared/check.ts';
import {
  shellError,
  type ShellError,
  type ShellErrorKind,
} from '../shared/errors.ts';
import type { PluginHostLike } from './host.ts';
import type { UtilityHandler } from './router.ts';

/**
 * The napi side carries the typed error in `err.cause.message` as a
 * JSON blob `{"code": <slug>, ...}`; `err.code` is the coarse napi
 * status. Slugs with a same-named shell kind ride through verbatim —
 * relabeling `transient`/`rate-limit`/`auth-required` laundered a
 * provider wall into `internal`/`unavailable` app-side and dropped
 * rate-limit's retryability. Anything unrecognised is `internal` —
 * a raw napi throw never crosses the IPC boundary.
 */
const SLUG_KIND: Readonly<Record<string, ShellErrorKind>> = {
  'invalid-argument': 'invalid-request',
  'not-found': 'not-found',
  'invalid-response': 'invalid-response',
  released: 'released',
  evicted: 'evicted',
  expired: 'expired',
  superseded: 'superseded',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
  'streams-capped': 'streams-capped',
  'rate-limit': 'rate-limit',
  transient: 'transient',
  'auth-required': 'auth-required',
  'provider-wall': 'provider-wall',
  internal: 'internal',
};

export function napiSlug(thrown: unknown): string | null {
  // napi-rs typed errors land as `err.cause.message` = JSON blob.
  const cause =
    isRecord(thrown) && isRecord(thrown['cause'])
      ? thrown['cause']
      : null;
  const text =
    cause !== null && typeof cause['message'] === 'string'
      ? cause['message']
      : thrown instanceof Error
        ? thrown.message
        : null;
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed['code'] === 'string') {
      return parsed['code'];
    }
  } catch {
    // Not JSON — fall through to the untyped message.
  }
  return null;
}

/** Wrap a napi rejection into a typed ShellError for the envelope.
 * The slug is taxonomy-safe; the native message is not (it can carry
 * paths and provider text), so it never reaches the message field. */
export function napiError(thrown: unknown): ShellError {
  const slug = napiSlug(thrown);
  if (slug !== null) {
    return shellError(
      SLUG_KIND[slug] ?? 'internal',
      `host call failed: ${slug}`,
    );
  }
  return shellError('internal', 'host call failed');
}

function validated<A>(
  isArgs: (value: unknown) => value is A,
  label: string,
): (args: unknown) => A {
  return (args) => {
    if (!isArgs(args)) {
      throw shellError('invalid-request', `${label}: bad args`);
    }
    return args;
  };
}

function checked<T>(
  isResult: (value: unknown) => value is T,
  label: string,
): (value: unknown) => T {
  return (value) => {
    if (!isResult(value)) {
      throw shellError(
        'invalid-response',
        `${label}: host returned malformed payload`,
      );
    }
    return value;
  };
}

/**
 * `stream:*` and `host:plugins` handlers over the lazy plugin host.
 * Every napi rejection is remapped through `napiError`; every outbound
 * payload is re-validated before it crosses back to main.
 */
export function createStreamHandlers(deps: {
  host(): PluginHostLike;
  pluginsReady(): Promise<readonly string[]>;
  status(): Promise<unknown>;
  /** User-pair consent review surface (`host:reviewPair`). */
  reviewUserPair(path: string): unknown;
  /** User-pair approval persistence (`host:approvePair`). */
  approveUserPair(path: string): boolean;
  devGateEnabled?: boolean;
}): Readonly<Record<string, UtilityHandler>> {
  /** The mapped region: run()'s throw/rejection becomes mapErr(). */
  const napiRun = async <R>(
    mapErr: (thrown: unknown) => ShellError,
    run: () => R | Promise<R>,
  ): Promise<R> => {
    try {
      return await run();
    } catch (thrown) {
      throw mapErr(thrown);
    }
  };

  /** validate + mapped host call — the plain `stream:*` shape. */
  const napiCall = <A>(
    isArgs: (value: unknown) => value is A,
    label: string,
    mapErr: (thrown: unknown) => ShellError,
    run: (host: PluginHostLike, args: A) => unknown | Promise<unknown>,
  ): UtilityHandler =>
    async (args) => {
      const a = validated(isArgs, label)(args);
      return napiRun(mapErr, () => run(deps.host(), a));
    };

  return {
    [CHANNELS.hostPlugins]: () => deps.status(),
    [CHANNELS.hostReviewPair]: async (args) => {
      const a = validated(isHostReviewPairArgs, 'host:reviewPair')(args);
      return checked(isUserPairReviewResult, 'host:reviewPair')(
        deps.reviewUserPair(a.path),
      );
    },
    [CHANNELS.hostApprovePair]: async (args) => {
      const a = validated(isHostApprovePairArgs, 'host:approvePair')(args);
      return checked(isApprovePairResult, 'host:approvePair')(
        deps.approveUserPair(a.path),
      );
    },

    [CHANNELS.hostRequest]: async (args) => {
      const a = validated(isHostRequestArgs, 'host:request')(args);
      // Same lazy-load gate as prepare — the plugin directory must
      // be scanned before a capability can reach a guest.
      await deps.pluginsReady();
      const outcome = await napiRun(napiError, () =>
        deps
          .host()
          .startRequest(a.pluginId, a.capability, a.payloadJson, a.requestId),
      );
      return checked(isRequestOutcomePayload, 'host:request')(outcome);
    },

    [CHANNELS.hostCancel]: napiCall(isHostCancelArgs, 'host:cancel', napiError,
      (h, a) => void h.cancel(a.requestId)),

    [CHANNELS.streamPrepare]: async (args) => {
      const a = validated(isStreamPrepareArgs, 'stream:prepare')(args);
      // startPrepare needs the plugin directory loaded, not just the
      // bindings — pluginsReady memoizes, so a concurrent first prepare
      // shares the one directory scan.
      await deps.pluginsReady();
      const outcome = await napiRun(napiError, () =>
        deps.host().startPrepare(a.pluginId, a.sourceRef, a.requestId),
      );
      return checked(isPrepareOutcomePayload, 'stream:prepare')(outcome);
    },

    [CHANNELS.streamDevPrepare]: async (args) => {
      const a = validated(isStreamDevPrepareArgs, 'stream:dev-prepare')(args);
      if (deps.devGateEnabled !== true) {
        throw shellError(
          'unavailable',
          'stream:dev-prepare is a dev-gate — packaged builds refuse it',
        );
      }
      return napiRun(napiError, () =>
        checked(isPreparedStreamPayload, 'stream:dev-prepare')(
          deps
            .host()
            .devPrepareUrl(a.url, a.mime, a.contentLength, a.remintable ?? false),
        ),
      );
    },

    [CHANNELS.streamServeUrl]: napiCall(isStreamHandleArgs, 'stream:serve-url',
      napiError, (h, a) => ({ url: h.streamServeUrl(a.handle) })),

    [CHANNELS.streamOpen]: napiCall(isStreamOpenArgs, 'stream:open',
      napiError, (h, a) => ({ remaining: h.streamOpen(a.handle, a.position) })),

    [CHANNELS.streamRead]: napiCall(isStreamReadArgs, 'stream:read',
      napiError, async (h, a) => ({
        data: (await h.streamRead(a.handle, a.position, a.maxLen)).toString(
          'base64',
        ),
      })),

    [CHANNELS.streamProbe]: napiCall(isStreamProbeArgs, 'stream:probe',
      napiError, async (h, a) => {
        const r = await h.streamProbe(
          a.handle,
          a.position,
          a.maxLen,
          a.fetch ?? true,
        );
        return { data: r.data.toString('base64'), total: r.total, eof: r.eof };
      }),

    [CHANNELS.streamClose]: napiCall(isStreamHandleArgs, 'stream:close',
      napiError, (h, a) => void h.streamClose(a.handle)),

    [CHANNELS.streamRelease]: napiCall(isStreamHandleArgs, 'stream:release',
      napiError, (h, a) => void h.streamRelease(a.handle)),

    [CHANNELS.streamMarks]: napiCall(isStreamHandleArgs, 'stream:marks',
      napiError, (h, a) =>
        checked(isStreamMarksResult, 'stream:marks')(h.streamPhaseMarks(a.handle))),

    [CHANNELS.streamCancel]: napiCall(isStreamCancelArgs, 'stream:cancel', napiError,
      (h, a) => void h.cancel(a.requestId)),
  };
}
