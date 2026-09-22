import { assert, assertEqual } from '@auqw/application/testing';
import { isRecord } from '../shared/check.ts';
import type { NodeBindingsModule, PluginHostLike } from './host.ts';
import { bindingsCandidates, createHostRuntime } from './host.ts';

export async function run(): Promise<void> {
  // Candidate order: env override, resources, then repo dev outputs.
  const candidates = bindingsCandidates(
    { AUQW_NODE_BINDINGS: '/opt/auqw_node_bindings.node' },
    '/resources',
    '/repo',
  );
  assertEqual(candidates[0], '/opt/auqw_node_bindings.node');
  assert(
    candidates.includes('/resources/auqw_node_bindings.node'),
    'resources candidate scanned',
  );
  assert(
    candidates.includes('/repo/target/debug/libauqw_node_bindings.so'),
    'dev target/debug candidate scanned',
  );

  // Missing artifact: status reports unavailable, host() throws typed.
  const missing = createHostRuntime({
    env: {},
    resourcesPath: '/r',
    repoRoot: '/repo',
    require: () => {
      throw new Error('unreachable');
    },
    fs: { exists: () => false, read: () => Buffer.alloc(0), list: () => [] },
  });
  const unavailable = await missing.status();
  assertEqual(unavailable.bindings, 'unavailable');
  assert(
    typeof unavailable.bindingsError === 'string' &&
      unavailable.bindingsError.length > 0,
    'unavailable carries a reason',
  );
  try {
    missing.host();
    assert(false, 'host() must throw when bindings are absent');
  } catch (thrown) {
    assert(
      isRecord(thrown) && thrown['kind'] === 'unavailable',
      'host() throws a typed unavailable',
    );
  }

  // Fake bindings module + plugin dir scan.
  const loadedPlugins: Array<{ wasm: string; manifest: string }> = [];
  const hostConfigs: unknown[] = [];
  const fakeHost: PluginHostLike = {
    async loadPlugin(wasmBase64: string, manifestJson: string) {
      loadedPlugins.push({ wasm: wasmBase64, manifest: manifestJson });
      return 'plugin-id';
    },
    async startPrepare() {
      return { type: 'prepared' };
    },
    cancel() {},
    devPrepareUrl() {
      return { handle: 'h', mime: 'audio/mp4' };
    },
    streamServeUrl() {
      return 'http://127.0.0.1:1/s/t';
    },
    streamOpen() {
      return null;
    },
    async streamRead() {
      return Buffer.alloc(0);
    },
    streamClose() {},
    streamRelease() {},
    streamPhaseMarks() {
      return {};
    },
  };
  const fakeModule: NodeBindingsModule = {
    PluginHost: class {
      constructor(config: unknown) {
        hostConfigs.push(config);
        return fakeHost;
      }
    } as unknown as NodeBindingsModule['PluginHost'],
  };
  const files = new Map<string, Buffer>([
    ['/b/auqw_node_bindings.node', Buffer.from('')],
    ['/plugins/deezer.wasm', Buffer.from('wasm-deezer')],
    ['/plugins/deezer.manifest.json', Buffer.from('{"id":"deezer"}')],
    ['/plugins/lyrics.manifest.json', Buffer.from('{"id":"lyrics"}')],
  ]);
  const runtime = createHostRuntime({
    env: {
      AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
      AUQW_PLUGIN_DIR: '/plugins',
      AUQW_USER_DATA: '/ud',
    },
    require: (path) => {
      assertEqual(path, '/b/auqw_node_bindings.node');
      return fakeModule;
    },
    fs: {
      exists: (p) => files.has(p) || p === '/plugins',
      read: (p) => files.get(p) ?? Buffer.alloc(0),
      list: (d) =>
        d === '/plugins'
          ? ['deezer.manifest.json', 'deezer.wasm', 'lyrics.manifest.json']
          : [],
    },
  });

  const plugins = await runtime.pluginsReady();
  assertEqual(plugins.length, 1, 'only manifest+wasm pairs load');
  assertEqual(hostConfigs.length, 1, 'host constructed once');
  const config = hostConfigs[0];
  assert(
    isRecord(config) &&
      config['statePath'] === '/ud/host-state' &&
      config['streamPath'] === '/ud/streams',
    'host paths derive from AUQW_USER_DATA',
  );
  assert(
    Buffer.from(loadedPlugins[0]?.wasm ?? '', 'base64').toString('utf8') ===
      'wasm-deezer' &&
      loadedPlugins[0]?.manifest === '{"id":"deezer"}',
    'wasm rides base64 + manifest JSON to loadPlugin',
  );
  const loaded = await runtime.status();
  assertEqual(loaded.bindings, 'loaded');
  assertEqual(loaded.plugins.length, 1);
}
