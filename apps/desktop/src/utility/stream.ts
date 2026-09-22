import { CHANNELS } from '../shared/channels.ts';
import {
  isPrepareOutcomePayload,
  isPreparedStreamPayload,
  isStreamCancelArgs,
  isStreamDevPrepareArgs,
  isStreamHandleArgs,
  isStreamMarksResult,
  isStreamOpenArgs,
  isStreamPrepareArgs,
  isStreamReadArgs,
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
 * status. Stream slugs map onto shell kinds; anything unrecognised is
 * `internal` — a raw napi throw never crosses the IPC boundary.
 */
const SLUG_KIND: Readonly<Record<string, ShellErrorKind>> = {
  'invalid-arg': 'invalid-request',
  'not-found': 'invalid-request',
  'invalid-response': 'invalid-response',
  released: 'released',
  evicted: 'released',
  expired: 'released',
  superseded: 'released',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
  'streams-capped': 'unavailable',
  'rate-limit': 'unavailable',
  transient: 'io-error',
  'auth-required': 'io-error',
  internal: 'internal',
};

function napiSlug(thrown: unknown): string | null {
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

/** Wrap a napi rejection into a typed ShellError for the envelope. */
export function napiError(thrown: unknown): ShellError {
  const slug = napiSlug(thrown);
  const detail =
    thrown instanceof Error && thrown.message.length <= 512
      ? thrown.message
      : 'host call failed';
  if (slug !== null) {
    return shellError(SLUG_KIND[slug] ?? 'internal', `${slug}: ${detail}`);
  }
  return shellError('internal', detail);
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
  devGateEnabled?: boolean;
}): Readonly<Record<string, UtilityHandler>> {
  return {
    [CHANNELS.hostPlugins]: () => deps.status(),

    [CHANNELS.streamPrepare]: async (args) => {
      const a = validated(isStreamPrepareArgs, 'stream:prepare')(args);
      // startPrepare needs the plugin directory loaded, not just the
      // bindings — pluginsReady memoizes, so a concurrent first prepare
      // shares the one directory scan.
      await deps.pluginsReady();
      const outcome = await deps
        .host()
        .startPrepare(a.pluginId, a.sourceRef, a.requestId)
        .catch((thrown: unknown) => {
          throw napiError(thrown);
        });
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
      try {
        const stream = deps
          .host()
          .devPrepareUrl(a.url, a.mime, a.contentLength, a.remintable ?? false);
        return checked(isPreparedStreamPayload, 'stream:dev-prepare')(stream);
      } catch (thrown) {
        throw napiError(thrown);
      }
    },

    [CHANNELS.streamServeUrl]: async (args) => {
      const a = validated(isStreamHandleArgs, 'stream:serve-url')(args);
      try {
        return { url: deps.host().streamServeUrl(a.handle) };
      } catch (thrown) {
        throw napiError(thrown);
      }
    },

    [CHANNELS.streamOpen]: async (args) => {
      const a = validated(isStreamOpenArgs, 'stream:open')(args);
      try {
        return { remaining: deps.host().streamOpen(a.handle, a.position) };
      } catch (thrown) {
        throw napiError(thrown);
      }
    },

    [CHANNELS.streamRead]: async (args) => {
      const a = validated(isStreamReadArgs, 'stream:read')(args);
      const data = await deps
        .host()
        .streamRead(a.handle, a.position, a.maxLen)
        .catch((thrown: unknown) => {
          throw napiError(thrown);
        });
      return { data: data.toString('base64') };
    },

    [CHANNELS.streamClose]: async (args) => {
      const a = validated(isStreamHandleArgs, 'stream:close')(args);
      try {
        deps.host().streamClose(a.handle);
        return undefined;
      } catch (thrown) {
        throw napiError(thrown);
      }
    },

    [CHANNELS.streamRelease]: async (args) => {
      const a = validated(isStreamHandleArgs, 'stream:release')(args);
      try {
        deps.host().streamRelease(a.handle);
        return undefined;
      } catch (thrown) {
        throw napiError(thrown);
      }
    },

    [CHANNELS.streamMarks]: async (args) => {
      const a = validated(isStreamHandleArgs, 'stream:marks')(args);
      try {
        const marks = deps.host().streamPhaseMarks(a.handle);
        return checked(isStreamMarksResult, 'stream:marks')(marks);
      } catch (thrown) {
        throw napiError(thrown);
      }
    },

    [CHANNELS.streamCancel]: async (args) => {
      const a = validated(isStreamCancelArgs, 'stream:cancel')(args);
      try {
        deps.host().cancel(a.requestId);
        return undefined;
      } catch (thrown) {
        throw napiError(thrown);
      }
    },
  };
}
