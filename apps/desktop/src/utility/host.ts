import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { shellError } from '../shared/errors.ts';
import type { HostPluginsResult } from '../shared/contract.ts';

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
    prefer?: string;
    authToken?: string;
  }) => PluginHostLike;
};

/** The subset of the napi `PluginHost` the stream channels call. */
export type PluginHostLike = {
  loadPlugin(wasmBase64: string, manifestJson: string): Promise<string>;
  startPrepare(
    pluginId: string,
    sourceRef: string,
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
  streamClose(handle: string): void;
  streamRelease(handle: string): void;
  streamPhaseMarks(handle: string): unknown;
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

export type HostEnv = {
  /** Explicit .node artifact path — overrides the candidate scan. */
  AUQW_NODE_BINDINGS?: string | undefined;
  /** Directory of `<id>.wasm` + `<id>.manifest.json` plugin pairs. */
  AUQW_PLUGIN_DIR?: string | undefined;
  /** Host state directory — stream stores live under it. */
  AUQW_USER_DATA?: string | undefined;
  AUQW_STREAM_DIR?: string | undefined;
};

type RequireLike = (path: string) => NodeBindingsModule;

type FsLike = {
  exists(path: string): boolean;
  read(path: string): Buffer;
  list(dir: string): string[];
};

const defaultFs: FsLike = {
  exists: existsSync,
  read: readFileSync,
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
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
  if (
    env.AUQW_NODE_BINDINGS !== undefined &&
    env.AUQW_NODE_BINDINGS !== ''
  ) {
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
export function createHostRuntime(opts: {
  env: HostEnv;
  resourcesPath?: string | undefined;
  repoRoot?: string | undefined;
  require?: RequireLike | undefined;
  fs?: FsLike | undefined;
}): {
  host(): PluginHostLike;
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
  let pluginsReady: Promise<readonly string[]> | null = null;

  function loadBindings(): PluginHostLike {
    const candidates = bindingsCandidates(
      opts.env,
      opts.resourcesPath ?? undefined,
      opts.repoRoot ?? undefined,
    );
    const found = candidates.find((c) => fs.exists(c));
    if (found === undefined) {
      bindingsError = `none of ${candidates.join(', ')}`;
      throw shellError(
        'unavailable',
        `node bindings artifact not found: ${bindingsError}`,
      );
    }
    try {
      const mod = requireFn(found);
      const userData = opts.env.AUQW_USER_DATA ?? process.cwd();
      host = new mod.PluginHost({
        fuelPerEntry: FUEL_PER_ENTRY,
        fuelTotal: FUEL_TOTAL,
        statePath: join(userData, 'host-state'),
        streamPath: opts.env.AUQW_STREAM_DIR ?? join(userData, 'streams'),
      });
      bindingsError = undefined;
      return host;
    } catch (thrown) {
      bindingsError =
        thrown instanceof Error ? thrown.message : String(thrown);
      throw shellError(
        'unavailable',
        `node bindings load failed: ${bindingsError}`,
      );
    }
  }

  function ensureHost(): PluginHostLike {
    return host ?? loadBindings();
  }

  async function loadPluginDir(
    h: PluginHostLike,
  ): Promise<readonly string[]> {
    const dir = opts.env.AUQW_PLUGIN_DIR;
    if (dir === undefined || dir === '') {
      return [];
    }
    const manifests = fs
      .list(dir)
      .filter((name) => name.endsWith('.manifest.json'))
      .sort();
    const loaded: string[] = [];
    for (const manifestName of manifests) {
      const stem = manifestName.slice(0, -'.manifest.json'.length);
      const wasmPath = join(dir, `${stem}.wasm`);
      if (!fs.exists(wasmPath)) {
        continue;
      }
      try {
        const wasm = fs.read(wasmPath);
        const manifest = fs.read(join(dir, manifestName)).toString('utf8');
        const pluginId = await h.loadPlugin(
          wasm.toString('base64'),
          manifest,
        );
        loaded.push(pluginId);
      } catch {
        // A malformed pair is skipped, not fatal — other pairs still load.
      }
    }
    return loaded;
  }

  async function ready(): Promise<readonly string[]> {
    pluginsReady ??= loadPluginDir(ensureHost());
    return pluginsReady;
  }

  return {
    host(): PluginHostLike {
      return ensureHost();
    },
    pluginsReady: ready,
    async status(): Promise<HostPluginsResult> {
      try {
        const plugins = await ready();
        return { bindings: 'loaded', plugins };
      } catch {
        const result: HostPluginsResult = {
          bindings: 'unavailable',
          plugins: [],
        };
        if (bindingsError !== undefined) {
          return { ...result, bindingsError };
        }
        return result;
      }
    },
  };
}
