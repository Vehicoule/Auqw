import { CHANNELS } from '../shared/channels.ts';
import {
  isHostCancelArgs,
  isHostRequestArgs,
  isPrepareOutcomePayload,
  isPreparedStreamPayload,
  isRequestOutcomePayload,
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
  'invalid-argument': 'invalid-request',
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

/**
 * `napiError` for the handle-keyed stream ops (serve-url, open, read,
 * close, release, marks). Their only `not-found` source is the handle
 * lookup itself — the session is gone registry-side (reaped after the
 * detach TTL, superseded while detached, or already released) — which
 * is `released` semantics, not malformed args. Surfacing it as
 * `released` lets the session re-prepare instead of failing the item.
 */
function napiStreamError(thrown: unknown): ShellError {
  if (napiSlug(thrown) === 'not-found') {
    return shellError('released', 'host call failed: not-found');
  }
  return napiError(thrown);
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

    [CHANNELS.hostRequest]: async (args) => {
      const a = validated(isHostRequestArgs, 'host:request')(args);
      // Same lazy-load gate as prepare — the plugin directory must
      // be scanned before a capability can reach a guest.
      await deps.pluginsReady();
      const outcome = await deps
        .host()
        .startRequest(a.pluginId, a.capability, a.payloadJson, a.requestId)
        .catch((thrown: unknown) => {
          throw napiError(thrown);
        });
      return checked(isRequestOutcomePayload, 'host:request')(outcome);
    },

    [CHANNELS.hostCancel]: async (args) => {
      const a = validated(isHostCancelArgs, 'host:cancel')(args);
      try {
        deps.host().cancel(a.requestId);
        return undefined;
      } catch (thrown) {
        throw napiError(thrown);
      }
    },

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
        throw napiStreamError(thrown);
      }
    },

    [CHANNELS.streamOpen]: async (args) => {
      const a = validated(isStreamOpenArgs, 'stream:open')(args);
      try {
        return { remaining: deps.host().streamOpen(a.handle, a.position) };
      } catch (thrown) {
        throw napiStreamError(thrown);
      }
    },

    [CHANNELS.streamRead]: async (args) => {
      const a = validated(isStreamReadArgs, 'stream:read')(args);
      const data = await deps
        .host()
        .streamRead(a.handle, a.position, a.maxLen)
        .catch((thrown: unknown) => {
          throw napiStreamError(thrown);
        });
      return { data: data.toString('base64') };
    },

    [CHANNELS.streamClose]: async (args) => {
      const a = validated(isStreamHandleArgs, 'stream:close')(args);
      try {
        deps.host().streamClose(a.handle);
        return undefined;
      } catch (thrown) {
        throw napiStreamError(thrown);
      }
    },

    [CHANNELS.streamRelease]: async (args) => {
      const a = validated(isStreamHandleArgs, 'stream:release')(args);
      try {
        deps.host().streamRelease(a.handle);
        return undefined;
      } catch (thrown) {
        throw napiStreamError(thrown);
      }
    },

    [CHANNELS.streamMarks]: async (args) => {
      const a = validated(isStreamHandleArgs, 'stream:marks')(args);
      try {
        const marks = deps.host().streamPhaseMarks(a.handle);
        return checked(isStreamMarksResult, 'stream:marks')(marks);
      } catch (thrown) {
        throw napiStreamError(thrown);
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
