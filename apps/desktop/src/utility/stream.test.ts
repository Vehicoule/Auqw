import { assert, assertEqual } from '@auqw/application/testing';
import { isRecord } from '../shared/check.ts';
import type { PluginHostLike } from './host.ts';
import { createStreamHandlers, napiError } from './stream.ts';

function fakeHost(overrides: Partial<PluginHostLike> = {}): PluginHostLike {
  return {
    async loadPlugin() {
      return 'id';
    },
    async startPrepare() {
      return {
        type: 'prepared',
        stream: { handle: 'h1', mime: 'audio/mp4' },
      };
    },
    cancel() {},
    devPrepareUrl() {
      return { handle: 'h2', mime: 'audio/webm' };
    },
    streamServeUrl() {
      return 'http://127.0.0.1:43210/s/deadbeef';
    },
    streamOpen() {
      return 512;
    },
    async streamRead() {
      return Buffer.from('chunk');
    },
    streamClose() {},
    streamRelease() {},
    streamPhaseMarks() {
      return { mintMs: 12, attachMs: 30 };
    },
    ...overrides,
  };
}

function fakeRuntime(host: PluginHostLike) {
  const calls: string[] = [];
  return {
    calls,
    handlers: createStreamHandlers({
      host: () => {
        calls.push('host');
        return host;
      },
      pluginsReady: () => Promise.resolve(['a', 'b']),
      status: () =>
        Promise.resolve({ bindings: 'loaded', plugins: ['a', 'b'] }),
    }),
  };
}

export async function run(): Promise<void> {
  // napiError maps typed slugs onto shell kinds.
  const slugError = new Error('napi rejection');
  (slugError as { cause?: unknown }).cause = {
    message: '{"code":"released"}',
  };
  assertEqual(napiError(slugError).kind, 'released');
  const untyped = napiError(new Error('plain'));
  assertEqual(untyped.kind, 'internal');

  const runtime = fakeRuntime(fakeHost());
  const handlers = runtime.handlers;

  // host:plugins surfaces the runtime status without touching the host.
  const plugins = await handlers['host:plugins']?.(undefined);
  assert(
    isRecord(plugins) && plugins['bindings'] === 'loaded',
    'host:plugins reports status',
  );
  assertEqual(runtime.calls.length, 0, 'status does not force a load');

  // stream:prepare validates args, forwards, re-validates the outcome.
  const prepared = await handlers['stream:prepare']?.({
    pluginId: 'deezer',
    sourceRef: 'track:1',
    requestId: 'req-1',
  });
  assert(
    isRecord(prepared) &&
      prepared['type'] === 'prepared' &&
      isRecord(prepared['stream']) &&
      prepared['stream']['handle'] === 'h1',
    'prepare outcome passes through',
  );
  try {
    await handlers['stream:prepare']?.({ pluginId: 1 });
    assert(false, 'bad prepare args must reject');
  } catch (thrown) {
    assert(
      isRecord(thrown) && thrown['kind'] === 'invalid-request',
      'bad args → invalid-request',
    );
  }

  // serveUrl wraps the URL; open/read/close/release/cancel forward.
  const url = await handlers['stream:serve-url']?.({ handle: 'h1' });
  assertEqual(isRecord(url) ? url['url'] : null, 'http://127.0.0.1:43210/s/deadbeef');
  const opened = await handlers['stream:open']?.({ handle: 'h1', position: 0 });
  assertEqual(isRecord(opened) ? opened['remaining'] : null, 512);
  const chunk = await handlers['stream:read']?.({
    handle: 'h1',
    position: 0,
    maxLen: 64,
  });
  assert(
    isRecord(chunk) &&
      Buffer.from(String(chunk['data']), 'base64').toString() === 'chunk',
    'read bytes ride base64',
  );
  const marks = await handlers['stream:marks']?.({ handle: 'h1' });
  assert(
    isRecord(marks) && marks['mintMs'] === 12,
    'marks payload passes through',
  );
  await handlers['stream:close']?.({ handle: 'h1' });
  await handlers['stream:release']?.({ handle: 'h1' });
  await handlers['stream:cancel']?.({ requestId: 'req-1' });

  // maxLen is bounded.
  try {
    await handlers['stream:read']?.({
      handle: 'h1',
      position: 0,
      maxLen: 2 * 1024 * 1024,
    });
    assert(false, 'oversized read must reject');
  } catch (thrown) {
    assert(isRecord(thrown) && thrown['kind'] === 'invalid-request');
  }

  // napi rejections map to typed shell errors, never raw throws.
  const rejecting = fakeRuntime(
    fakeHost({
      streamServeUrl() {
        const e = new Error('boom');
        (e as { cause?: unknown }).cause = {
          message: '{"code":"not-found"}',
        };
        throw e;
      },
    }),
  );
  try {
    await rejecting.handlers['stream:serve-url']?.({ handle: 'ghost' });
    assert(false, 'napi rejection must surface typed');
  } catch (thrown) {
    assert(
      isRecord(thrown) && thrown['kind'] === 'invalid-request',
      'not-found slug maps to invalid-request',
    );
  }
}
