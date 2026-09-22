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
    fs: {
      exists: () => false,
      read: () => Buffer.alloc(0),
      list: () => [],
      mkdir: () => {},
      copy: () => {},
    },
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
  const loadedPlugins: Array<{ wasm: Buffer; manifest: string }> = [];
  const hostConfigs: unknown[] = [];
  const fakeHost: PluginHostLike = {
    async loadPlugin(wasm: Buffer, manifestJson: string) {
      loadedPlugins.push({ wasm, manifest: manifestJson });
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
      mkdir: () => {},
      copy: () => {},
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
    loadedPlugins[0]?.wasm.toString('utf8') === 'wasm-deezer' &&
      loadedPlugins[0]?.manifest === '{"id":"deezer"}',
    'wasm rides a Buffer + manifest JSON to loadPlugin',
  );
  const loaded = await runtime.status();
  assertEqual(loaded.bindings, 'loaded');
  assertEqual(loaded.plugins.length, 1);

  // A platform-named cdylib (what cargo emits) is staged to a .node
  // copy under userData before require — direct .node paths are not.
  {
    const staged: Array<{ src: string; dst: string }> = [];
    const dirs: string[] = [];
    const soRuntime = createHostRuntime({
      env: {
        AUQW_NODE_BINDINGS: '/repo/target/debug/libauqw_node_bindings.so',
        AUQW_USER_DATA: '/ud',
      },
      require: (path) => {
        assertEqual(path, '/ud/node-bindings/auqw_node_bindings.node');
        return fakeModule;
      },
      fs: {
        exists: (p) => p === '/repo/target/debug/libauqw_node_bindings.so',
        read: () => Buffer.alloc(0),
        list: () => [],
        mkdir: (d) => {
          dirs.push(d);
        },
        copy: (src, dst) => {
          staged.push({ src, dst });
        },
      },
    });
    const soStatus = await soRuntime.status();
    assertEqual(soStatus.bindings, 'loaded');
    assert(
      staged.length === 1 &&
        staged[0]?.src === '/repo/target/debug/libauqw_node_bindings.so' &&
        staged[0]?.dst === '/ud/node-bindings/auqw_node_bindings.node' &&
        dirs.includes('/ud/node-bindings'),
      'cdylib staged to userData .node',
    );
  }

  // A rejected init is retried on the next call — the artifact may
  // appear after a build; only a successful result is memoized.
  {
    let requireCalls = 0;
    const retryRuntime = createHostRuntime({
      env: { AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node' },
      require: () => {
        requireCalls++;
        if (requireCalls === 1) {
          throw new Error('not built yet');
        }
        return fakeModule;
      },
      fs: {
        exists: (p) => p === '/b/auqw_node_bindings.node',
        read: () => Buffer.alloc(0),
        list: () => [],
        mkdir: () => {},
        copy: () => {},
      },
    });
    const first = await retryRuntime.status();
    assertEqual(first.bindings, 'unavailable');
    const second = await retryRuntime.status();
    assertEqual(second.bindings, 'loaded');
    assertEqual(requireCalls, 2);
  }
}
