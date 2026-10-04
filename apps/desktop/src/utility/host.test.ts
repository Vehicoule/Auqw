import { join } from 'node:path';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { describeCandidate } from '@auqw/application';
import { isRecord } from '../shared/check.ts';
import type { NodeBindingsModule, PluginHostLike } from './host.ts';
import {
  bindingsCandidates,
  boundedPluginFetch,
  createHostRuntime,
} from './host.ts';

export async function run(): Promise<void> {
  // Candidate order: env override, resources, then repo dev outputs.
  // Expectations go through join() — the candidates carry OS-native
  // separators, so literal POSIX strings never match on Windows.
  const candidates = bindingsCandidates(
    { AUQW_NODE_BINDINGS: '/opt/auqw_node_bindings.node' },
    '/resources',
    '/repo',
  );
  assertEqual(candidates[0], '/opt/auqw_node_bindings.node');
  assert(
    candidates.includes(join('/resources', 'auqw_node_bindings.node')),
    'resources candidate scanned',
  );
  assert(
    candidates.includes(
      join('/repo', 'target', 'debug', 'libauqw_node_bindings.so'),
    ),
    'dev target/debug candidate scanned',
  );

  // Missing artifact: status reports unavailable, host() throws typed.
  const missing = createHostRuntime({
    env: {},
    resourcesPath: '/r',
    repoRoot: '/repo',
    feedSync: async () => ({ ready: [], compatible: [] }),
    require: () => {
      throw new Error('unreachable');
    },
    fs: {
      exists: () => false,
      read: () => Buffer.alloc(0),
      list: () => [],
      mkdir: () => {},
      copy: () => {},
      stat: () => null,
      write: () => {},
    },
  });
  const unavailable = await missing.status();
  assertEqual(unavailable.bindings, 'unavailable');
  assert(
    typeof unavailable.bindingsError === 'string' &&
      unavailable.bindingsError.length > 0,
    'unavailable carries a reason',
  );
  // The reason is redacted: candidate paths are utility-side
  // diagnostics — never part of a message that crosses to the
  // renderer.
  assert(
    unavailable.bindingsError !== undefined &&
      !unavailable.bindingsError.includes('/') &&
      !unavailable.bindingsError.includes('auqw_node_bindings'),
    `bindingsError redacted: ${unavailable.bindingsError}`,
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
    async unloadPlugin() {},
    async startPrepare() {
      return { type: 'prepared' };
    },
    async startRequest() {
      return { type: 'succeeded' };
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
    async streamProbe() {
      return { data: Buffer.alloc(0), total: null, eof: true };
    },
    streamClose() {},
    streamRelease() {},
    streamPhaseMarks() {
      return {};
    },
    setPotProvider() {},
    setAuthToken() {},
  };
  const fakeModule: NodeBindingsModule = {
    PluginHost: class {
      constructor(config: unknown) {
        hostConfigs.push(config);
        return fakeHost;
      }
    } as unknown as NodeBindingsModule['PluginHost'],
  };
  // fs keys are join()ed — loadPluginDir stages OS-native paths, so
  // literal POSIX names never match on Windows.
  const files = new Map<string, Buffer>([
    ['/b/auqw_node_bindings.node', Buffer.from('')],
    [join('/plugins', 'deezer.wasm'), Buffer.from('wasm-deezer')],
    [
      join('/plugins', 'deezer.manifest.json'),
      Buffer.from(
        '{"id":"deezer","capabilities":["catalog.search","playback.resolve"]}',
      ),
    ],
    [
      join('/plugins', 'lyrics.manifest.json'),
      Buffer.from('{"id":"lyrics"}'),
    ],
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
      stat: () => null,
      write: () => {},
    },
  });

  const plugins = await runtime.pluginsReady();
  assertEqual(plugins.length, 1, 'only manifest+wasm pairs load');
  assertEqual(hostConfigs.length, 1, 'host constructed once');
  const config = hostConfigs[0];
  assert(
    isRecord(config) &&
      config['statePath'] === join('/ud', 'host-state') &&
      config['streamPath'] === join('/ud', 'streams'),
    'host paths derive from AUQW_USER_DATA',
  );
  assert(
    loadedPlugins[0]?.wasm.toString('utf8') === 'wasm-deezer' &&
      loadedPlugins[0]?.manifest?.includes('"id":"deezer"') === true,
    'wasm Buffer + manifest JSON reach loadPlugin untouched',
  );
  const loaded = await runtime.status();
  assertEqual(loaded.bindings, 'loaded');
  assertEqual(loaded.plugins.length, 1);
  // Each loaded plugin surfaces its declared provider id + capabilities
  // for the renderer's provider adapters.
  assert(
    loaded.manifests.length === 1 &&
      loaded.manifests[0]?.providerId === 'deezer' &&
      loaded.manifests[0]?.capabilities.length === 2 &&
      loaded.manifests[0]?.capabilities.includes('catalog.search'),
    'status carries the manifest fields',
  );

  // An empty manifest id isn't a provider id — the pair loads under
  // its file stem instead of shipping providerId '' downstream.
  {
    const stemFiles = new Map<string, Buffer>([
      ['/b/auqw_node_bindings.node', Buffer.from('')],
      [join('/plugins', 'quiet.wasm'), Buffer.from('wasm-quiet')],
      [
        join('/plugins', 'quiet.manifest.json'),
        Buffer.from('{"id":""}'),
      ],
    ]);
    const stemRuntime = createHostRuntime({
      env: {
        AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
        AUQW_PLUGIN_DIR: '/plugins',
        AUQW_USER_DATA: '/ud',
      },
      require: () => fakeModule,
      fs: {
        exists: (p) => stemFiles.has(p) || p === '/plugins',
        read: (p) => stemFiles.get(p) ?? Buffer.alloc(0),
        list: (d) =>
          d === '/plugins'
            ? ['quiet.manifest.json', 'quiet.wasm']
            : [],
        mkdir: () => {},
        copy: () => {},
        stat: () => null,
        write: () => {},
      },
    });
    await stemRuntime.pluginsReady();
    const stemStatus = await stemRuntime.status();
    assertEqual(stemStatus.manifests[0]?.providerId, 'quiet');
  }

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
      feedSync: async () => ({ ready: [], compatible: [] }),
      require: (path) => {
        assertEqual(
          path,
          join('/ud', 'node-bindings', 'auqw_node_bindings.node'),
        );
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
        stat: () => null,
        write: () => {},
      },
    });
    const soStatus = await soRuntime.status();
    assertEqual(soStatus.bindings, 'loaded');
    assert(
      staged.length === 1 &&
        staged[0]?.src === '/repo/target/debug/libauqw_node_bindings.so' &&
        staged[0]?.dst ===
          join('/ud', 'node-bindings', 'auqw_node_bindings.node') &&
        dirs.includes(join('/ud', 'node-bindings')),
      'cdylib staged to userData .node',
    );
  }


  // User-installed third-party pairs: the consent gate end-to-end
  // through the loader (scan, refusal, collision, offline order).
  {
    const manifest = JSON.stringify({
      id: 'foo-music',
      version: '1.2.3',
      abi: '0.1.0',
      capabilities: ['catalog.search'],
      permissions: ['network:api.foo.com'],
      artifact: { path: 'foo.wasm', digest: 'sha256:' + 'a'.repeat(64) },
    });
    const wasm = Buffer.from('wasm-foo');
    const pair = JSON.stringify({ manifest, wasm: wasm.toString('base64') });
    const desc = describeCandidate({
      manifestJson: manifest,
      wasmB64: wasm.toString('base64'),
    });
    assert(desc !== null, 'candidate describes');
    const consents = [
      {
        id: 'foo-music',
        version: '1.2.3',
        abi: '0.1.0',
        wasm_sha256: desc.wasm_sha256,
        manifest_sha256: desc.manifest_sha256,
        approved_permissions: ['network:api.foo.com'],
      },
    ];
    const consentJson = JSON.stringify({ consents });
    const userFiles = new Map<string, Buffer>([
      ['/b/auqw_node_bindings.node', Buffer.from('')],
      [join('/ud', 'plugins-user', 'foo-music.pair.json'), Buffer.from(pair)],
      [join('/ud', 'plugins-user', 'consents.json'), Buffer.from(consentJson)],
    ]);
    const userLoaded: Array<{ wasm: Buffer; manifest: string }> = [];
    const userModule: NodeBindingsModule = {
      PluginHost: class {
        constructor() {
          return {
            ...fakeHost,
            loadPlugin: async (w: Buffer, m: string) => {
              userLoaded.push({ wasm: w, manifest: m });
              return 'plugin-foo';
            },
          } as unknown as PluginHostLike;
        }
      } as unknown as NodeBindingsModule['PluginHost'],
    };
    const userDir = join('/ud', 'plugins-user');
    const userFs = {
      exists: (p: string) => userFiles.has(p) || p === userDir,
      read: (p: string) => userFiles.get(p) ?? Buffer.alloc(0),
      list: (d: string) =>
        d === userDir
          ? [...userFiles.keys()].map((p) =>
              p.endsWith('consents.json')
                ? 'consents.json'
                : 'foo-music.pair.json',
            )
          : [],
      mkdir: () => {},
      copy: () => {},
      stat: (p: string) => {
        const b = userFiles.get(p);
        return b === undefined
          ? null
          : { mtimeMs: 1, size: b.byteLength, isFile: true };
      },
      write: () => {},
    };
    const userRuntime = createHostRuntime({
      env: {
        AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
        AUQW_USER_DATA: '/ud',
      },
      feedSync: async () => ({ ready: [], compatible: [] }),
      require: () => userModule,
      fs: userFs,
    });
    const status = await userRuntime.status();
    assertEqual(status.bindings, 'loaded', 'consented pair keeps status loaded');
    assert(
      userLoaded.length === 1 &&
        userLoaded[0]?.wasm.toString('utf8') === 'wasm-foo' &&
        userLoaded[0]?.manifest.includes('"id":"foo-music"') === true,
      'consented pair reaches loadPlugin',
    );

    // Without the consent record the same pair is refused.
    userFiles.delete(join('/ud', 'plugins-user', 'consents.json'));
    const refused = await userRuntime.status();
    assertEqual(
      refused.manifests.length,
      0,
      'unconsented pair never loads',
    );

    // A collision with a signed feed id is a refusal, not a replace:
    // the feed loads first, the user pair with the same id skips.
    const signedFiles = new Map<string, Buffer>([
      ['/b/auqw_node_bindings.node', Buffer.from('')],
      [join('/plugins', 'deezer.wasm'), Buffer.from('wasm-deezer')],
      [
        join('/plugins', 'deezer.manifest.json'),
        Buffer.from(
          '{"id":"deezer","capabilities":["catalog.search"]}',
        ),
      ],
    ]);
    const collisionManifest = manifest.replace('foo-music', 'deezer');
    const collisionDesc = describeCandidate({
      manifestJson: collisionManifest,
      wasmB64: wasm.toString('base64'),
    });
    assert(collisionDesc !== null, 'collision candidate describes');
    const collisionConsents = [
      {
        id: 'deezer',
        version: '1.2.3',
        abi: '0.1.0',
        wasm_sha256: collisionDesc.wasm_sha256,
        manifest_sha256: collisionDesc.manifest_sha256,
        approved_permissions: ['network:api.foo.com'],
      },
    ];
    signedFiles.set(
      join('/ud', 'plugins-user', 'deezer.pair.json'),
      Buffer.from(
        JSON.stringify({
          manifest: collisionManifest,
          wasm: wasm.toString('base64'),
        }),
      ),
    );
    signedFiles.set(
      join('/ud', 'plugins-user', 'consents.json'),
      Buffer.from(JSON.stringify({ consents: collisionConsents })),
    );
    const collisionLoaded: Array<{ wasm: Buffer; manifest: string }> = [];
    const collisionModule: NodeBindingsModule = {
      PluginHost: class {
        constructor() {
          return {
            ...fakeHost,
            loadPlugin: async (w: Buffer, m: string) => {
              collisionLoaded.push({ wasm: w, manifest: m });
              return 'plugin-x';
            },
          } as unknown as PluginHostLike;
        }
      } as unknown as NodeBindingsModule['PluginHost'],
    };
    const collisionRuntime = createHostRuntime({
      env: {
        AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
        AUQW_PLUGIN_DIR: '/plugins',
        AUQW_USER_DATA: '/ud',
      },
      require: () => collisionModule,
      fs: {
        exists: (p: string) => signedFiles.has(p) || p === '/plugins',
        read: (p: string) => signedFiles.get(p) ?? Buffer.alloc(0),
        list: (d: string) =>
          d === '/plugins'
            ? ['deezer.manifest.json', 'deezer.wasm']
            : d === join('/ud', 'plugins-user')
              ? ['consents.json', 'deezer.pair.json']
              : [],
        mkdir: () => {},
        copy: () => {},
        stat: () => null,
        write: () => {},
      },
    });
    const collisionStatus = await collisionRuntime.status();
    assertEqual(
      collisionStatus.manifests.length,
      1,
      'collision runtime loads exactly one provider',
    );
    assert(
      collisionStatus.manifests[0]?.providerId === 'deezer' &&
        collisionLoaded[0]?.wasm.toString('utf8') === 'wasm-deezer',
      'the signed guest wins its id; the user pair never replaces it',
    );

    // A consent removal unloads the guest from the live host — the
    // registry must not keep answering for a revoked provider.
    const unloaded: string[] = [];
    const revokeModule: NodeBindingsModule = {
      PluginHost: class {
        constructor() {
          return {
            ...fakeHost,
            loadPlugin: async (_w: Buffer, m: string) => {
              return JSON.parse(m)['id'];
            },
            unloadPlugin: async (providerId: string) => {
              unloaded.push(providerId);
            },
          } as unknown as PluginHostLike;
        }
      } as unknown as NodeBindingsModule['PluginHost'],
    };
    const revokeFiles = new Map<string, Buffer>([
      ['/b/auqw_node_bindings.node', Buffer.from('')],
      [join('/ud', 'plugins-user', 'foo-music.pair.json'), Buffer.from(pair)],
      [join('/ud', 'plugins-user', 'consents.json'), Buffer.from(consentJson)],
    ]);
    const revokeFs = {
      exists: (p: string) => revokeFiles.has(p) || p === userDir,
      read: (p: string) => revokeFiles.get(p) ?? Buffer.alloc(0),
      list: (d: string) =>
        d === userDir
          ? [...revokeFiles.keys()].map((p) =>
              p.endsWith('consents.json')
                ? 'consents.json'
                : 'foo-music.pair.json',
            )
          : [],
      mkdir: () => {},
      copy: () => {},
      stat: (p: string) => {
        const b = revokeFiles.get(p);
        return b === undefined
          ? null
          : { mtimeMs: 1, size: b.byteLength, isFile: true };
      },
      write: () => {},
    };
    const revokeRuntime = createHostRuntime({
      env: {
        AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
        AUQW_USER_DATA: '/ud',
      },
      feedSync: async () => ({ ready: [], compatible: [] }),
      require: () => revokeModule,
      fs: revokeFs,
    });
    const withConsent = await revokeRuntime.status();
    assertEqual(withConsent.manifests.length, 1, 'pair loads behind consent');
    assertEqual(unloaded.length, 0, 'nothing unloaded while consented');
    // Revoke: drop the consent record — the next status unloads.
    revokeFiles.delete(join('/ud', 'plugins-user', 'consents.json'));
    const revoked = await revokeRuntime.status();
    assertEqual(revoked.manifests.length, 0, 'revoked pair never loads');
    assert(
      unloaded.includes('foo-music'),
      'revocation unloads the guest from the host',
    );

    // A signed feed promoting a user id never unloads the signed
    // replacement — the id now belongs to the feed.
    const promoteUnloaded: string[] = [];
    const promoteModule: NodeBindingsModule = {
      PluginHost: class {
        constructor() {
          return {
            ...fakeHost,
            loadPlugin: async (_w: Buffer, m: string) =>
              JSON.parse(m)['id'],
            unloadPlugin: async (providerId: string) => {
              promoteUnloaded.push(providerId);
            },
          } as unknown as PluginHostLike;
        }
      } as unknown as NodeBindingsModule['PluginHost'],
    };
    const promoteFiles = new Map<string, Buffer>([
      ['/b/auqw_node_bindings.node', Buffer.from('')],
      [join('/plugins', 'foo-music.wasm'), Buffer.from('wasm-signed')],
      [
        join('/plugins', 'foo-music.manifest.json'),
        Buffer.from('{"id":"foo-music","capabilities":["catalog.search"]}'),
      ],
      [join('/ud', 'plugins-user', 'foo-music.pair.json'), Buffer.from(pair)],
      [join('/ud', 'plugins-user', 'consents.json'), Buffer.from(consentJson)],
    ]);
    const promoteRuntime = createHostRuntime({
      env: {
        AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
        AUQW_PLUGIN_DIR: '/plugins',
        AUQW_USER_DATA: '/ud',
      },
      require: () => promoteModule,
      fs: {
        exists: (p: string) => promoteFiles.has(p) || p === '/plugins',
        read: (p: string) => promoteFiles.get(p) ?? Buffer.alloc(0),
        list: (d: string) =>
          d === '/plugins'
            ? ['foo-music.manifest.json', 'foo-music.wasm']
            : [],
        mkdir: () => {},
        copy: () => {},
        stat: () => null,
        write: () => {},
      },
    });
    const promoted = await promoteRuntime.status();
    assertEqual(promoted.manifests.length, 1, 'signed winner loads');
    assertEqual(
      promoteUnloaded.length,
      0,
      'the signed replacement is never unloaded',
    );

    // OTA-path scenarios: `pairVerifier` stands in for the signed
    // release check so the scan sees feed pairs without real
    // signatures; `feedSync` scripts the feed's availability.
    const signedFooPair = {
      id: 'foo-music',
      version: '9.9.9',
      wasmSha256: 'sha256:' + 'f'.repeat(64),
      manifestSha256: 'sha256:' + 'e'.repeat(64),
      wasmB64: Buffer.from('wasm-signed').toString('base64'),
      manifestJson:
        '{"id":"foo-music","version":"9.9.9","capabilities":["catalog.search"],"abi":"0.1.0","permissions":[]}',
    };
    const userDirPath = join('/ud', 'plugins-user');
    const cacheDirPath = join('/ud', 'plugins');
    const otaFs = (
      files: Map<string, Buffer>,
      userNames: () => readonly string[],
      signedNames: () => readonly string[],
      writes?: Array<{ path: string; data: string }>,
    ) => ({
      exists: (p: string) =>
        files.has(p) || p === userDirPath || p === cacheDirPath,
      read: (p: string) => files.get(p) ?? Buffer.alloc(0),
      list: (d: string) =>
        d === cacheDirPath
          ? [...signedNames()]
          : d === userDirPath
            ? [...userNames()]
            : [],
      mkdir: () => {},
      copy: () => {},
      stat: (p: string) => {
        const b = files.get(p);
        return b === undefined
          ? null
          : { mtimeMs: 1, size: b.byteLength, isFile: true };
      },
      write: (p: string, data: string) => {
        writes?.push({ path: p, data });
      },
    });
    const otaHost = (
      load: (wasm: Buffer, manifest: string) => Promise<string>,
      unload?: (providerId: string) => Promise<void>,
    ): NodeBindingsModule => ({
      PluginHost: class {
        constructor() {
          return {
            ...fakeHost,
            loadPlugin: load,
            unloadPlugin:
              unload ?? (async () => {}),
          } as unknown as PluginHostLike;
        }
      } as unknown as NodeBindingsModule['PluginHost'],
    });

    // A failed feed with an empty provider set must keep rejecting —
    // the cached empty user scan can't swallow the failure or a
    // recovery would never re-sync.
    {
      let feedCalls = 0;
      const recoveryRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: () => {
          feedCalls += 1;
          return feedCalls < 3
            ? Promise.reject(new Error('feed down'))
            : Promise.resolve({ ready: [], compatible: [] });
        },
        pairVerifier: () => null,
        require: () => fakeModule,
        fs: {
          exists: (p) => p === '/b/auqw_node_bindings.node',
          read: () => Buffer.alloc(0),
          list: () => [],
          mkdir: () => {},
          copy: () => {},
          stat: () => null,
          write: () => {},
        },
      });
      const down1 = await recoveryRuntime.status();
      const down2 = await recoveryRuntime.status();
      assertEqual(down1.bindings, 'unavailable');
      assertEqual(
        down2.bindings,
        'unavailable',
        'a failed feed keeps rejecting while the scan is empty',
      );
      const up = await recoveryRuntime.status();
      assertEqual(feedCalls, 3, 'recovery re-syncs the feed');
      assertEqual(up.bindings, 'loaded');
    }

    // A signed pair that fails to load still owns its id — a
    // consented user pair must not register under it.
    {
      const otaLoaded: string[] = [];
      let reserveFeeds = 0;
      const colliding = new Map<string, Buffer>([
        ['/b/auqw_node_bindings.node', Buffer.from('')],
        [join(cacheDirPath, 'foo-music.json'), Buffer.from('{"feed":1}')],
        [join(userDirPath, 'foo-music.pair.json'), Buffer.from(pair)],
        [join(userDirPath, 'consents.json'), Buffer.from(consentJson)],
      ]);
      const reserveRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: async () => {
          reserveFeeds += 1;
          return { ready: ['x'], compatible: ['foo-music', 'x'] };
        },
        pairVerifier: () => signedFooPair,
        require: () =>
          otaHost(async (w, m) => {
            if (w.toString('utf8') === 'wasm-signed') {
              throw new Error('signed load failed');
            }
            otaLoaded.push(`${w.toString('utf8')}|${m}`);
            return 'p';
          }),
        fs: otaFs(
          colliding,
          () => ['consents.json', 'foo-music.pair.json'],
          () => ['foo-music.json'],
        ),
      });
      const blocked = await reserveRuntime.status();
      assertEqual(
        blocked.manifests.length,
        0,
        'a failed signed load keeps its id reserved',
      );
      assert(
        !otaLoaded.some((l) => l.includes('wasm-foo')),
        'the unsigned pair never registers under a feed-claimed id',
      );
      await reserveRuntime.status();
      assertEqual(
        reserveFeeds,
        2,
        'the missing signed provider keeps the retry gate armed',
      );
    }

    // A signed load replacing a user guest displaces the cached
    // entry: once the signed pair is gone the approved user bytes
    // must reload before the entry advertises again — status may
    // never describe a guest the registry no longer runs.
    {
      const loadSeq: string[] = [];
      const dispFiles = new Map<string, Buffer>([
        ['/b/auqw_node_bindings.node', Buffer.from('')],
        [join(userDirPath, 'foo-music.pair.json'), Buffer.from(pair)],
        [join(userDirPath, 'consents.json'), Buffer.from(consentJson)],
      ]);
      let signedNames: readonly string[] = [];
      const dispRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: async () => ({
          ready: ['x'],
          compatible: ['foo-music', 'x'],
        }),
        pairVerifier: () => signedFooPair,
        require: () =>
          otaHost(async (w) => {
            loadSeq.push(w.toString('utf8'));
            return 'p';
          }),
        fs: otaFs(
          dispFiles,
          () => ['consents.json', 'foo-music.pair.json'],
          () => signedNames,
        ),
      });
      await dispRuntime.status();
      signedNames = ['foo-music.json'];
      await dispRuntime.status();
      signedNames = [];
      const back = await dispRuntime.status();
      assertDeepEqual(
        loadSeq,
        ['wasm-foo', 'wasm-signed', 'wasm-foo'],
        'the displaced guest reloads its approved user bytes',
      );
      assertEqual(
        back.manifests[0]?.providerId,
        'foo-music',
        'the reloaded user provider advertises again',
      );
    }

    // A consented pair shadowed by a signed id through a full scan
    // must not vanish from the user set: it can't ride the cache, so
    // only the displacement mark keeps it reachable — the mark must
    // survive scans that happen while the feed claim stands, and the
    // pair must reload the moment the claim lifts.
    {
      const barManifest =
        '{"id":"bar-music","version":"1.0.0","capabilities":["catalog.search"],"abi":"0.1.0","permissions":[]}';
      const barWasm = Buffer.from('wasm-bar');
      const barPair = JSON.stringify({
        manifest: barManifest,
        wasm: barWasm.toString('base64'),
      });
      const barDesc = describeCandidate({
        manifestJson: barManifest,
        wasmB64: barWasm.toString('base64'),
      });
      assert(barDesc !== null, 'bar candidate describes');
      const consentsBoth = [
        {
          id: 'foo-music',
          version: '1.2.3',
          abi: '0.1.0',
          wasm_sha256: desc.wasm_sha256,
          manifest_sha256: desc.manifest_sha256,
          approved_permissions: ['network:api.foo.com'],
        },
        {
          id: 'bar-music',
          version: '1.0.0',
          abi: '0.1.0',
          wasm_sha256: barDesc.wasm_sha256,
          manifest_sha256: barDesc.manifest_sha256,
          approved_permissions: [],
        },
      ];
      const shadowFiles = new Map<string, Buffer>([
        ['/b/auqw_node_bindings.node', Buffer.from('')],
        [join(userDirPath, 'foo-music.pair.json'), Buffer.from(pair)],
        [
          join(userDirPath, 'consents.json'),
          Buffer.from(JSON.stringify({ consents: consentsBoth })),
        ],
      ]);
      let shadowUserNames: readonly string[] = [
        'consents.json',
        'foo-music.pair.json',
      ];
      let shadowSignedNames: readonly string[] = [];
      const shadowSeq: string[] = [];
      const shadowRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: async () => ({
          ready: ['x'],
          compatible: ['foo-music', 'x'],
        }),
        pairVerifier: () => signedFooPair,
        require: () =>
          otaHost(async (w) => {
            shadowSeq.push(w.toString('utf8'));
            return 'p';
          }),
        fs: otaFs(
          shadowFiles,
          () => shadowUserNames,
          () => shadowSignedNames,
        ),
      });
      // 1. user foo registers; the retry gate stays armed.
      await shadowRuntime.status();
      // 2. signed foo arrives on a reuse pass and displaces the guest.
      shadowSignedNames = ['foo-music.json'];
      await shadowRuntime.status();
      // 3. An unrelated user install rescans while signed foo stands —
      //    bar registers, consented foo is skipped behind the feed
      //    claim and marked shadowed.
      shadowFiles.set(
        join(userDirPath, 'bar-music.pair.json'),
        Buffer.from(barPair),
      );
      shadowUserNames = [
        'bar-music.pair.json',
        'consents.json',
        'foo-music.pair.json',
      ];
      await shadowRuntime.status();
      // 4. The signed pair leaves the feed — the dir signature is
      //    unchanged, so only the carried mark can notice. The pass
      //    must rescan and reload the approved foo bytes.
      shadowSignedNames = [];
      const restored = await shadowRuntime.status();
      assertDeepEqual(
        shadowSeq,
        [
          'wasm-foo',
          'wasm-signed',
          'wasm-signed',
          'wasm-bar',
          'wasm-bar',
          'wasm-foo',
        ],
        'the shadowed pair reloads once the feed claim lifts',
      );
      assert(
        restored.manifests.some((m) => m.providerId === 'foo-music') &&
          restored.manifests.some((m) => m.providerId === 'bar-music'),
        'foo-music is absent no longer once the shadow lifts',
      );
    }

    // A failed revocation stays owed — reuse passes keep retrying
    // the unload rather than leaving the guest registered.
    {
      let unloadCalls = 0;
      const revokeRetryFiles = new Map<string, Buffer>([
        ['/b/auqw_node_bindings.node', Buffer.from('')],
        [join(userDirPath, 'foo-music.pair.json'), Buffer.from(pair)],
        [join(userDirPath, 'consents.json'), Buffer.from(consentJson)],
      ]);
      const revokeRetryRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: async () => ({ ready: ['x'], compatible: ['x'] }),
        pairVerifier: () => null,
        require: () =>
          otaHost(
            async () => 'p',
            async () => {
              unloadCalls += 1;
              throw new Error('unload unsupported');
            },
          ),
        fs: otaFs(
          revokeRetryFiles,
          () => ['consents.json', 'foo-music.pair.json'],
          () => [],
        ),
      });
      await revokeRetryRuntime.status();
      // Revoke: the consent removal changes the dir signature, the
      // rescan revokes — and keeps owing the unload when it fails.
      revokeRetryFiles.delete(join(userDirPath, 'consents.json'));
      await revokeRetryRuntime.status();
      await revokeRetryRuntime.status();
      assert(
        unloadCalls >= 2,
        `a failed unload stays owed to later scans, got ${unloadCalls}`,
      );
    }

    // The approve call pins the digests the consent dialog approved —
    // a pair whose bytes drifted since is refused, and the installed
    // file is byte-for-byte the reviewed document.
    {
      const writes: Array<{ path: string; data: string }> = [];
      const approveFiles = new Map<string, Buffer>([
        ['/b/auqw_node_bindings.node', Buffer.from('')],
        ['/pick/foo-music.pair.json', Buffer.from(pair)],
      ]);
      const approveRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: async () => ({ ready: [], compatible: [] }),
        require: () => fakeModule,
        fs: {
          exists: (p) => approveFiles.has(p) || p === userDirPath,
          read: (p) => approveFiles.get(p) ?? Buffer.alloc(0),
          list: () => [],
          mkdir: () => {},
          copy: () => {},
          stat: (p) => {
            const b = approveFiles.get(p);
            return b === undefined
              ? null
              : { mtimeMs: 1, size: b.byteLength, isFile: true };
          },
          write: (p, data) => {
            writes.push({ path: p, data });
          },
        },
      });
      const review = approveRuntime.reviewUserPair(
        '/pick/foo-music.pair.json',
      );
      assert(review !== null, 'review describes the candidate');
      assertEqual(
        approveRuntime.approveUserPair(
          '/pick/foo-music.pair.json',
          'sha256:' + '9'.repeat(64),
          review.manifest_sha256,
        ),
        false,
        'a drifted pair is refused at the write',
      );
      assertEqual(writes.length, 0, 'a refused approve writes nothing');
      assertEqual(
        approveRuntime.approveUserPair(
          '/pick/foo-music.pair.json',
          review.wasm_sha256,
          review.manifest_sha256,
        ),
        true,
        'the approved digests persist',
      );
      const pairWrite = writes.find((w) =>
        w.path.endsWith('foo-music.pair.json'),
      );
      assert(
        pairWrite !== undefined && pairWrite.data === pair,
        'the installed pair is byte-for-byte the reviewed document',
      );
      const consentWrite = writes.find((w) =>
        w.path.endsWith('consents.json'),
      );
      assert(
        consentWrite !== undefined &&
          consentWrite.data.includes(review.wasm_sha256) &&
          consentWrite.data.includes('foo-music'),
        'the consent record pins the approved digests',
      );
    }

    // A pair/consent write during an in-flight load queues exactly
    // one follow-up instead of launching a second concurrent pass —
    // passes serialize, and the trailing pass reads the write.
    {
      const serFiles = new Map<string, Buffer>([
        ['/b/auqw_node_bindings.node', Buffer.from('')],
        [join(userDirPath, 'consents.json'), Buffer.from(consentJson)],
      ]);
      let serUserNames: readonly string[] = ['consents.json'];
      const serLoaded: string[] = [];
      const feedResolvers: Array<() => void> = [];
      const serRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: () =>
          new Promise((resolveFeed) => {
            feedResolvers.push(() =>
              resolveFeed({ ready: [], compatible: [] }),
            );
          }),
        pairVerifier: () => null,
        require: () =>
          otaHost(async (w, m) => {
            serLoaded.push(m);
            return 'p';
          }),
        fs: otaFs(serFiles, () => serUserNames, () => []),
      });
      const first = serRuntime.status();
      // The drain body starts on a microtask — let pass 1 reach its
      // feed suspension before observing it.
      await new Promise((r) => setTimeout(r, 0));
      assertEqual(feedResolvers.length, 1, 'the first pass syncs once');
      // The approval lands while pass 1 is suspended in the feed —
      // the re-arm must queue, not interleave a second load.
      serFiles.set(
        join(userDirPath, 'foo-music.pair.json'),
        Buffer.from(pair),
      );
      serUserNames = ['consents.json', 'foo-music.pair.json'];
      const second = serRuntime.status();
      await Promise.resolve();
      assertEqual(
        feedResolvers.length,
        1,
        'a mid-flight re-arm queues behind the in-flight pass',
      );
      feedResolvers[0]?.();
      await new Promise((r) => setTimeout(r, 10));
      assertEqual(
        feedResolvers.length,
        2,
        'the queued follow-up runs its own sync once started',
      );
      feedResolvers[1]?.();
      const out = await second;
      await first;
      assert(
        out.manifests.some((m) => m.providerId === 'foo-music'),
        'the trailing pass loads the mid-flight pair',
      );
    }

    // The pair write asserts its own containment — an id carrying
    // path segments (reachable if the grammar regresses or a caller
    // skips describeCandidate) must not place bytes outside
    // plugins-user.
    {
      const traversalManifest = JSON.stringify({
        id: 'a/b',
        version: '1.2.3',
        abi: '0.1.0',
        capabilities: ['catalog.search'],
        permissions: ['network:api.foo.com'],
        artifact: { path: 'foo.wasm', digest: 'sha256:' + 'a'.repeat(64) },
      });
      const traversalPair = JSON.stringify({
        manifest: traversalManifest,
        wasm: wasm.toString('base64'),
      });
      const traversalFiles = new Map<string, Buffer>([
        ['/b/auqw_node_bindings.node', Buffer.from('')],
        ['/pick/ab.pair.json', Buffer.from(traversalPair)],
      ]);
      const traversalWrites: Array<{ path: string; data: string }> = [];
      const traversalRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: async () => ({ ready: [], compatible: [] }),
        require: () => fakeModule,
        fs: {
          exists: (p) => traversalFiles.has(p) || p === userDirPath,
          read: (p) => traversalFiles.get(p) ?? Buffer.alloc(0),
          list: () => [],
          mkdir: () => {},
          copy: () => {},
          stat: (p) => {
            const b = traversalFiles.get(p);
            return b === undefined
              ? null
              : { mtimeMs: 1, size: b.byteLength, isFile: true };
          },
          write: (p, data) => {
            traversalWrites.push({ path: p, data });
          },
        },
      });
      const traversalReview = traversalRuntime.reviewUserPair(
        '/pick/ab.pair.json',
      );
      assert(
        traversalReview !== null && traversalReview.id === 'a/b',
        'the candidate describes the traversal id',
      );
      assertEqual(
        traversalRuntime.approveUserPair(
          '/pick/ab.pair.json',
          traversalReview.wasm_sha256,
          traversalReview.manifest_sha256,
        ),
        false,
        'an id escaping plugins-user is refused at the write',
      );
      assertEqual(
        traversalWrites.length,
        0,
        'a refused traversal writes nothing',
      );
    }

    // The pair-file cap binds the FILE, not the buffered bytes: an
    // oversized or non-regular target is refused on stat before
    // `read` can wedge the utility.
    {
      const capReads: string[] = [];
      const capRuntime = (
        stat: { mtimeMs: number; size: number; isFile: boolean } | null,
      ) =>
        createHostRuntime({
          env: {
            AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
            AUQW_USER_DATA: '/ud',
          },
          feedSync: async () => ({ ready: [], compatible: [] }),
          require: () => fakeModule,
          fs: {
            exists: () => true,
            read: (p) => {
              capReads.push(p);
              return Buffer.alloc(0);
            },
            list: () => [],
            mkdir: () => {},
            copy: () => {},
            stat: () => stat,
            write: () => {},
          },
        });
      // 27 MiB > PAIR_FILE_MAX_BYTES (26 MiB).
      const over = capRuntime({
        mtimeMs: 1,
        size: 27 * 1024 * 1024,
        isFile: true,
      });
      assertEqual(
        over.reviewUserPair('/pick/huge.pair.json'),
        null,
        'an oversized pair is refused before read',
      );
      assertEqual(
        over.approveUserPair('/pick/huge.pair.json', 'x', 'y'),
        false,
        'an oversized pair is refused at approve',
      );
      assert(
        !capReads.includes('/pick/huge.pair.json'),
        'read never ran on the oversized target',
      );
      const dev = capRuntime({ mtimeMs: 1, size: 0, isFile: false });
      assertEqual(
        dev.reviewUserPair('/dev/zero'),
        null,
        'a non-regular file is refused before read',
      );
      assert(
        !capReads.includes('/dev/zero'),
        'read never ran on the special file',
      );
    }

    // The loader's user scan applies the same stat gate: a planted
    // oversized pair is skipped before `read`, not after — every
    // scan would OOM on it otherwise.
    {
      const bigPair = join(userDirPath, 'big.pair.json');
      const scanReads: string[] = [];
      const scanRuntime = createHostRuntime({
        env: {
          AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node',
          AUQW_USER_DATA: '/ud',
        },
        feedSync: async () => ({ ready: [], compatible: [] }),
        pairVerifier: () => null,
        require: () => fakeModule,
        fs: {
          exists: (p) =>
            p === '/b/auqw_node_bindings.node' ||
            p === userDirPath ||
            p === bigPair,
          read: (p) => {
            scanReads.push(p);
            return Buffer.alloc(0);
          },
          list: (d) => (d === userDirPath ? ['big.pair.json'] : []),
          mkdir: () => {},
          copy: () => {},
          stat: (p) =>
            p === bigPair
              ? { mtimeMs: 1, size: 27 * 1024 * 1024, isFile: true }
              : null,
          write: () => {},
        },
      });
      const scanStatus = await scanRuntime.status();
      assertEqual(scanStatus.bindings, 'loaded');
      assert(
        !scanReads.includes(bigPair),
        'the oversized pair is skipped before read',
      );
    }
  }

  // The feed leg is bounded: a declared-oversize body fails before a
  // byte is read, a streamed body over the cap fails mid-read, a
  // non-2xx is a typed transient, and the whole leg races a hard
  // timeout — the caller's per-resource caps still decide what an
  // in-budget body may mean.
  {
    const realFetch = globalThis.fetch;
    const stubFetch = (res: {
      ok: boolean;
      status?: number;
      contentLength?: number | null;
      chunks?: readonly Uint8Array[];
      onRead?: () => void;
    }) => {
      const chunks = res.chunks ?? [];
      return (async () => ({
        ok: res.ok,
        status: res.status ?? 200,
        headers: {
          get: (name: string) =>
            name === 'content-length' && res.contentLength != null
              ? String(res.contentLength)
              : null,
        },
        body: {
          getReader: () => {
            let i = 0;
            return {
              read: async () => {
                res.onRead?.();
                return i < chunks.length
                  ? { done: false, value: chunks[i++] }
                  : { done: true, value: undefined };
              },
              cancel: async () => {},
              releaseLock: () => {},
            };
          },
        },
      })) as unknown as typeof fetch;
    };
    const transientKind = async (url: string): Promise<string | null> => {
      try {
        await boundedPluginFetch(url);
        return null;
      } catch (thrown) {
        return isRecord(thrown) && typeof thrown['kind'] === 'string'
          ? thrown['kind']
          : null;
      }
    };
    try {
      // Declared oversize: refused without consuming the body.
      let bodyTouched = false;
      globalThis.fetch = stubFetch({
        ok: true,
        contentLength: 32 * 1024 * 1024,
        onRead: () => {
          bodyTouched = true;
        },
      });
      assertEqual(
        await transientKind('https://feed/x'),
        'transient',
        'a declared-oversize body is refused',
      );
      assert(!bodyTouched, 'the over-cap body was never read');
      // Streamed oversize under the wire: the cap counts real bytes.
      globalThis.fetch = stubFetch({
        ok: true,
        chunks: [new Uint8Array(17 * 1024 * 1024)],
      });
      assertEqual(
        await transientKind('https://feed/x'),
        'transient',
        'a streamed body is refused at the cap',
      );
      // In-budget body: the bytes come back.
      globalThis.fetch = stubFetch({
        ok: true,
        chunks: [new Uint8Array([1, 2]), new Uint8Array([3])],
      });
      const out = await boundedPluginFetch('https://feed/x');
      assert(
        out.length === 3 && out[2] === 3,
        'an in-budget body returns its bytes',
      );
      // A non-2xx is a typed transient, never a raw error.
      globalThis.fetch = stubFetch({ ok: false, status: 503 });
      assertEqual(
        await transientKind('https://feed/x'),
        'transient',
        'a failed status is a typed transient',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // A rejected init is retried on the next call — the artifact may
  // appear after a build; only a successful result is memoized.
  {
    let requireCalls = 0;
    const retryRuntime = createHostRuntime({
      env: { AUQW_NODE_BINDINGS: '/b/auqw_node_bindings.node' },
      feedSync: async () => ({ ready: [], compatible: [] }),
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
        stat: () => null,
        write: () => {},
      },
    });
    const first = await retryRuntime.status();
    assertEqual(first.bindings, 'unavailable');
    const second = await retryRuntime.status();
    assertEqual(second.bindings, 'loaded');
    assertEqual(requireCalls, 2);
  }
}
