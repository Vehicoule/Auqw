import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  PLUGIN_RELEASE_TRUST,
  parsePluginPair,
  pluginPublicKey,
  syncPluginFeed,
} from '@auqw/application';
import type { FeedSyncPorts } from '@auqw/application';
import { shellError } from '../shared/errors.ts';
import type {
  HostPluginsResult,
  PluginManifestPayload,
} from '../shared/contract.ts';

/**
 * The napi `.node` module's export surface (mirrors `crates/node-
 * bindings`). Declared structurally so this module stays loadable and
 * testable under plain node — a missing artifact is a runtime status,
 * never an import-time failure.
 */
export type NodeBindingsModule = {
  PluginHost: new (config: {
    fuelPerEntry: number;
    fuelTotal: number;
    potProviderUrl?: string;
    statePath?: string;
    streamPath?: string;
    prefer?: string[];
    authToken?: string;
  }) => PluginHostLike;
};

/** The subset of the napi `PluginHost` the stream channels call. */
export type PluginHostLike = {
  // napi `load_plugin(&self, wasm: Buffer, manifest_json: String)` —
  // raw bytes, NOT the base64 string the UniFFI mobile surface takes.
  loadPlugin(wasm: Buffer, manifestJson: string): Promise<string>;
  startPrepare(
    pluginId: string,
    sourceRef: string,
    requestId: string,
  ): Promise<unknown>;
  startRequest(
    pluginId: string,
    capability: string,
    payloadJson: string,
    requestId: string,
  ): Promise<unknown>;
  cancel(requestId: string): void;
  devPrepareUrl(
    url: string,
    mime: string,
    contentLength: number | undefined,
    remintable: boolean,
  ): unknown;
  streamServeUrl(handle: string): string;
  streamOpen(handle: string, position: number): number | null;
  streamRead(
    handle: string,
    position: number,
    maxLen: number,
  ): Promise<Buffer>;
  streamProbe(
    handle: string,
    position: number,
    maxLen: number,
    fetch: boolean,
  ): Promise<{ data: Buffer; total: number | null; eof: boolean }>;
  streamClose(handle: string): void;
  streamRelease(handle: string): void;
  streamPhaseMarks(handle: string): unknown;
  /**
   * napi `set_pot_provider(&self, url: Option<String>)` — updates
   * the provider slot resolves read at invocation spawn, so a
   * minter bind retry landing after construction still reaches the
   * running host. `null` restores anonymous resolves.
   */
  setPotProvider(url: string | null): void;
  /**
   * napi `set_auth_token(&self, token: Option<String>)` — the access
   * token merges into every session-trust payload; `null` (and any
   * off-contract value) clears the slot, restoring the anonymous
   * ladder. The bearer itself never crosses the renderer.
   */
  setAuthToken(token: string | null): void;
};

/** Fuel budgets match the mobile host's values (200M/entry, 2G total). */
const FUEL_PER_ENTRY = 200_000_000;
const FUEL_TOTAL = 2_000_000_000;

const BINDINGS_BASENAME = 'auqw_node_bindings';
const BINDINGS_CANDIDATES: readonly string[] = [
  `${BINDINGS_BASENAME}.node`,
  `lib${BINDINGS_BASENAME}.so`,
  `lib${BINDINGS_BASENAME}.dylib`,
  `${BINDINGS_BASENAME}.dll`,
];

type HostEnv = {
  /** Explicit .node artifact path — overrides the candidate scan. */
  AUQW_NODE_BINDINGS?: string | undefined;
  /** Directory of `<id>.wasm` + `<id>.manifest.json` plugin pairs —
   * when set it wins over the feed cache (dev/test seam). */
  AUQW_PLUGIN_DIR?: string | undefined;
  /** OTA feed URL override — defaults to the embedded release feed. */
  AUQW_PLUGIN_FEED?: string | undefined;
  /** Host state directory — stream stores live under it. */
  AUQW_USER_DATA?: string | undefined;
  AUQW_STREAM_DIR?: string | undefined;
  /**
   * POT provider override — wins over the bundled pot-service's
   * loopback URL when set (points the host at an external bgutil).
   */
  AUQW_POT_PROVIDER_URL?: string | undefined;
};

type RequireLike = (path: string) => NodeBindingsModule;

type FsLike = {
  exists(path: string): boolean;
  read(path: string): Buffer;
  list(dir: string): string[];
  mkdir(dir: string): void;
  copy(src: string, dst: string): void;
};

const defaultFs: FsLike = {
  exists: existsSync,
  read: readFileSync,
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  copy: (src, dst) => {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  },
};

/**
 * Resolution order for the bindings artifact:
 * `AUQW_NODE_BINDINGS`, then `process.resourcesPath` (packaged),
 * then the repo's dev build outputs (cargo `target/debug`).
 */
export function bindingsCandidates(
  env: HostEnv,
  resourcesPath: string | undefined,
  repoRoot: string | undefined,
): string[] {
  const out: string[] = [];
  if (env.AUQW_NODE_BINDINGS) {
    out.push(env.AUQW_NODE_BINDINGS);
  }
  if (resourcesPath !== undefined) {
    for (const name of BINDINGS_CANDIDATES) {
      out.push(join(resourcesPath, name));
    }
  }
  if (repoRoot !== undefined) {
    for (const name of BINDINGS_CANDIDATES) {
      out.push(join(repoRoot, 'target', 'debug', name));
    }
  }
  return out;
}

/**
 * Lazily-resolved host: the artifact may legitimately be absent (a dev
 * checkout without `cargo build -p auqw-node-bindings`), so the first
 * stream call — not utility boot — pays the load, and the status stays
 * inspectable via `host:plugins`.
 */
/** A loaded plugin + the manifest fields the renderer needs to build
 * its provider adapters — `id` and `capabilities` verbatim from the
 * manifest JSON (the adapter re-validates capability names against
 * the ABI set; unknown names never survive `startRequest` anyway).
 */
type LoadedPlugin = {
  readonly pluginId: string;
  readonly providerId: string;
  readonly capabilities: readonly string[];
  /** Manifest `version`; null when the manifest omits it. */
  readonly version: string | null;
};

/** Manifest `id` + `capabilities` extraction — bounded-shape read, no
 * ABI knowledge: undeclared fields fall back to the file stem + an
 * empty capability list, and a malformed manifest skips the pair at
 * load time anyway.
 */
function manifestFields(
  manifestJson: string,
  stem: string,
): {
  providerId: string;
  capabilities: readonly string[];
  version: string | null;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    raw = null;
  }
  const str = (value: unknown, max: number): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= max
      ? value
      : null;
  const record =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const capabilities = Array.isArray(record['capabilities'])
    ? (record['capabilities'] as unknown[]).filter(
        (c): c is string => typeof c === 'string' && c.length <= 64,
      )
    : [];
  return {
    providerId: str(record['id'], 128) ?? stem,
    capabilities,
    version: str(record['version'], 64),
  };
}

/** ed25519 SPKI DER is a fixed 12-byte header over the raw key. */
const ED25519_SPKI_DER_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);

/** Release feed sync over node builtins — the utility's OTA path. */
async function defaultFeedSync(
  dir: string,
  feedUrl: string,
): Promise<{ ready: readonly string[]; compatible: readonly string[] }> {
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_DER_PREFIX, pluginPublicKey()]),
    format: 'der',
    type: 'spki',
  });
  return syncPluginFeed({
    feedUrl,
    keyId: PLUGIN_RELEASE_TRUST.keyId,
    publicKey: pluginPublicKey(),
    dir,
    ports: {
      fetchBytes: async (url) => {
        // The utility's fetch advertises gzip but does NOT
        // transparently decode it (unlike undici) — GitHub's edge
        // gzips feed.json, so ask for identity explicitly.
        const res = await fetch(url, {
          headers: { 'accept-encoding': 'identity' },
        });
        if (!res.ok) {
          throw shellError('transient', `plugin feed fetch ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      },
      ed25519Verify: (message, signature) =>
        verifySignature(null, message, publicKey, signature),
      list: async (d) => (existsSync(d) ? readdirSync(d) : []),
      read: async (p) => (existsSync(p) ? readFileSync(p) : null),
      write: async (p, bytes) => {
        mkdirSync(dirname(p), { recursive: true });
        const tmp = `${p}.part`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, p);
      },
      remove: async (p) => rmSync(p, { force: true }),
    },
  });
}

export function createHostRuntime(opts: {
  env: HostEnv;
  resourcesPath?: string | undefined;
  repoRoot?: string | undefined;
  require?: RequireLike | undefined;
  fs?: FsLike | undefined;
  /** Injectable for tests — defaults to the node OTA sync. */
  feedSync?:
    | ((dir: string) => Promise<{
        ready: readonly string[];
        compatible: readonly string[];
      }>)
    | undefined;
  /**
   * Bundled POT service's loopback URL — read at PluginHost
   * construction (lazy bindings make this a thunk, not a value).
   * `AUQW_POT_PROVIDER_URL` wins over it when set.
   */
  potProviderUrl?: () => string | null;
  /**
   * Live OAuth access token for session-trust payloads — a thunk so a
   * token minted before the bindings loaded still reaches the
   * PluginHost constructor (the utility restores custody before the
   * first stream call forces a host load).
   */
  authToken?: () => string | null;
}): {
  host(): PluginHostLike;
  /**
   * The already-constructed host or null — never builds one. For
   * late-arriving updates (`setPotProvider` after a minter bind
   * retry) that must not force bindings to load.
   */
  hostIfLoaded(): PluginHostLike | null;
  pluginsReady(): Promise<readonly string[]>;
  status(): Promise<HostPluginsResult>;
} {
  const fs = opts.fs ?? defaultFs;
  const requireFn: RequireLike =
    opts.require ??
    ((path) =>
      createRequire(process.cwd())(path) as NodeBindingsModule);

  let host: PluginHostLike | null = null;
  let bindingsError: string | undefined;
  let pluginsReady: Promise<readonly LoadedPlugin[]> | null = null;
  // Set when the last load left the registry short of the feed's
  // compatible set — the next ready() re-syncs instead of serving the
  // stale memoized result.
  let lastLoadIncomplete = false;

  function loadBindings(): PluginHostLike {
    const candidates = bindingsCandidates(
      opts.env,
      opts.resourcesPath ?? undefined,
      opts.repoRoot ?? undefined,
    );
    const found = candidates.find((c) => fs.exists(c));
    if (found === undefined) {
      // Absolute candidate paths stay utility-side — the status field
      // and the thrown message both cross to the renderer.
      bindingsError = 'no candidate artifact found';
      throw shellError(
        'unavailable',
        'node bindings artifact not found',
      );
    }
    try {
      const mod = requireFn(stageArtifact(found));
      const userData = opts.env.AUQW_USER_DATA ?? process.cwd();
      // An empty override reads as unset — otherwise it would both
      // skip the bundled service's loopback URL AND fail the host's
      // own URL validation, leaving playback with no provider.
      const envPotUrl = opts.env.AUQW_POT_PROVIDER_URL;
      const potUrl =
        (envPotUrl !== undefined && envPotUrl.trim() !== ''
          ? envPotUrl
          : opts.potProviderUrl?.()) ?? undefined;
      const authToken = opts.authToken?.();
      host = new mod.PluginHost({
        fuelPerEntry: FUEL_PER_ENTRY,
        fuelTotal: FUEL_TOTAL,
        statePath: join(userData, 'host-state'),
        streamPath: opts.env.AUQW_STREAM_DIR ?? join(userData, 'streams'),
        // Decided surface hint: webm-first on desktop, mp4 where the
        // codec matrix requires it. Without the hint the guest prefers
        // mp4 on ties — wrong container for this surface.
        prefer: ['audio/webm', 'audio/mp4'],
        ...(potUrl !== undefined && potUrl !== ''
          ? { potProviderUrl: potUrl }
          : {}),
        // A token restored before this lazy load rides the constructor
        // — live updates go through setAuthToken instead.
        ...(authToken !== undefined && authToken !== null
          ? { authToken }
          : {}),
      });
      bindingsError = undefined;
      return host;
    } catch {
      // Raw dlopen text carries paths — the renderer gets the slug.
      bindingsError = 'bindings artifact failed to load';
      throw shellError('unavailable', 'node bindings load failed');
    }
  }

  /**
   * `require()` only dlopens `.node` files — a platform-named cdylib
   * (`lib*.so`/`*.dylib`/`*.dll`, what cargo emits) is staged under
   * userData first, same convention as `crates/node-bindings`' smoke
   * test. The copy is unconditional so a rebuilt artifact can never
   * serve a stale module.
   */
  function stageArtifact(src: string): string {
    if (src.endsWith('.node')) {
      return src;
    }
    const userData = opts.env.AUQW_USER_DATA ?? process.cwd();
    const dst = join(
      userData,
      'node-bindings',
      `${BINDINGS_BASENAME}.node`,
    );
    fs.mkdir(dirname(dst));
    fs.copy(src, dst);
    return dst;
  }

  function ensureHost(): PluginHostLike {
    return host ?? loadBindings();
  }

  async function loadPluginDir(
    h: PluginHostLike,
  ): Promise<readonly LoadedPlugin[]> {
    const dir =
      opts.env.AUQW_PLUGIN_DIR === undefined || opts.env.AUQW_PLUGIN_DIR === ''
        ? undefined
        : opts.env.AUQW_PLUGIN_DIR;
    const loaded: LoadedPlugin[] = [];
    if (dir === undefined) {
      // OTA path: refresh the cache under userData, then load it.
      // `AUQW_PLUGIN_DIR` still wins — dev loops and harnesses point
      // at their own unsigned sets.
      const cacheDir = join(opts.env.AUQW_USER_DATA ?? process.cwd(), 'plugins');
      const sync =
        opts.feedSync ??
        ((d: string) =>
          defaultFeedSync(
            d,
            opts.env.AUQW_PLUGIN_FEED ?? PLUGIN_RELEASE_TRUST.feedUrl,
          ));
      let feedFailure: unknown;
      // Present only when the feed answered — the feed is the
      // authority on which plugin ids may load while it is reachable;
      // an unreachable feed leaves the whole cache usable as
      // last-known-good.
      let synced: { ready: readonly string[]; compatible: readonly string[] } | undefined;
      try {
        synced = await sync(cacheDir);
      } catch (thrown) {
        feedFailure = thrown;
      }
      const spki = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_DER_PREFIX, pluginPublicKey()]),
        format: 'der',
        type: 'spki',
      });
      const verify: FeedSyncPorts['ed25519Verify'] = (message, signature) =>
        verifySignature(null, message, spki, signature);
      for (const name of fs.list(cacheDir).sort()) {
        if (!name.endsWith('.json')) {
          continue;
        }
        try {
          const pair = parsePluginPair(
            fs.read(join(cacheDir, name)).toString('utf8'),
            {
              keyId: PLUGIN_RELEASE_TRUST.keyId,
              publicKey: pluginPublicKey(),
              verify,
            },
          );
          if (
            pair === null ||
            (synced !== undefined && !synced.compatible.includes(pair.id))
          ) {
            continue;
          }
          const pluginId = await h.loadPlugin(
            Buffer.from(pair.wasmB64, 'base64'),
            pair.manifestJson,
          );
          const fields = manifestFields(pair.manifestJson, pair.id);
          loaded.push({
            pluginId,
            providerId: fields.providerId,
            capabilities: fields.capabilities,
            version: fields.version,
          });
        } catch {
          // A malformed pair is skipped, not fatal — other pairs still load.
        }
      }
      // A failed feed refresh with an empty cache must not pin an empty
      // provider set: `pluginsReady` resets on rejection, so the next
      // call re-syncs — a cache hit meanwhile stays usable offline.
      if (loaded.length === 0 && feedFailure !== undefined) {
        throw feedFailure;
      }
      // A feed sync that left any listed plugin below its current
      // release stays retriable (an outdated LKG pair still loads —
      // the gate tracks ready, not loaded): the next `ready()`
      // re-syncs and the host's id-keyed insert hot-swaps the pair.
      lastLoadIncomplete =
        synced !== undefined && synced.ready.length < synced.compatible.length;
      return loaded;
    }
    const manifests = fs
      .list(dir)
      .filter((name) => name.endsWith('.manifest.json'))
      .sort();
    for (const manifestName of manifests) {
      const stem = manifestName.slice(0, -'.manifest.json'.length);
      const wasmPath = join(dir, `${stem}.wasm`);
      if (!fs.exists(wasmPath)) {
        continue;
      }
      try {
        const wasm = fs.read(wasmPath);
        const manifest = fs.read(join(dir, manifestName)).toString('utf8');
        const pluginId = await h.loadPlugin(wasm, manifest);
        const fields = manifestFields(manifest, stem);
        loaded.push({
          pluginId,
          providerId: fields.providerId,
          capabilities: fields.capabilities,
          version: fields.version,
        });
      } catch {
        // A malformed pair is skipped, not fatal — other pairs still load.
      }
    }
    return loaded;
  }

  async function ready(): Promise<readonly LoadedPlugin[]> {
    if (pluginsReady === null || lastLoadIncomplete) {
      lastLoadIncomplete = false;
      const pending = loadPluginDir(ensureHost());
      pluginsReady = pending;
      // A rejected init stays retriable — the artifact may appear
      // after a build — while in-flight calls still share `pending`.
      void pending.catch(() => {
        if (pluginsReady === pending) {
          pluginsReady = null;
        }
      });
    }
    return pluginsReady;
  }

  return {
    host(): PluginHostLike {
      return ensureHost();
    },
    hostIfLoaded(): PluginHostLike | null {
      return host;
    },
    pluginsReady(): Promise<readonly string[]> {
      return ready().then((loaded) => loaded.map((p) => p.pluginId));
    },
    async status(): Promise<HostPluginsResult> {
      try {
        const loaded = await ready();
        const manifests: PluginManifestPayload[] = loaded.map((p) => ({
          pluginId: p.pluginId,
          providerId: p.providerId,
          capabilities: p.capabilities,
          version: p.version,
        }));
        return {
          bindings: 'loaded',
          plugins: loaded.map((p) => p.pluginId),
          manifests,
        };
      } catch {
        const result: HostPluginsResult = {
          bindings: 'unavailable',
          plugins: [],
          manifests: [],
        };
        if (bindingsError !== undefined) {
          return { ...result, bindingsError };
        }
        return result;
      }
    },
  };
}
