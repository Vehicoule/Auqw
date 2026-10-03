import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
  consentAllows,
  consentsFromJson,
  consentsToJson,
  describeCandidate,
  manifestPermissions,
  parsePluginPair,
  pluginPublicKey,
  syncPluginFeed,
} from '@auqw/application';
import type {
  FeedSyncPorts,
  VerifiedPluginPair,
} from '@auqw/application';
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
  unloadPlugin(providerId: string): Promise<void>;
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
  stat(path: string): { mtimeMs: number; size: number } | null;
  write(path: string, data: string): void;
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
  stat: (path) => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  },
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.part`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
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
  /** Manifest `permissions` strings, order preserved. */
  readonly permissions: readonly string[];
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
  permissions: readonly string[];
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
  // The host validator's permission grammar is length-unbounded —
  // verbatim carriage, non-empty strings only.
  const permissions = Array.isArray(record['permissions'])
    ? (record['permissions'] as unknown[]).filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      )
    : [];
  return {
    providerId: str(record['id'], 128) ?? stem,
    capabilities,
    version: str(record['version'], 64),
    permissions,
  };
}

/** ed25519 SPKI DER is a fixed 12-byte header over the raw key. */
const ED25519_SPKI_DER_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);

/**
 * Raw user-pair document cap, checked before any parse: manifest
 * (64 KiB) + wasm (16 MiB) + base64 inflation (~4/3) + JSON framing.
 */
const PAIR_FILE_MAX_BYTES = 26 * 1024 * 1024;

/**
 * Content signature of the user-pair directory: one `name:mtimeMs:size`
 * entry per file, sorted. A change in any pair or consent file flips
 * the signature and re-arms the load. Absent dir signs as `''`.
 */
function userDirSignature(dir: string, fs: FsLike): string {
  if (!fs.exists(dir)) {
    return '';
  }
  try {
    return fs
      .list(dir)
      .sort()
      .map((name) => {
        const st = fs.stat(join(dir, name));
        return `${name}:${st === null ? '-' : st.mtimeMs}:${st === null ? '-' : st.size}`;
      })
      .join('|');
  } catch {
    return '';
  }
}

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

/** What the review surface shows for a candidate pair — identity plus
 * the exact digests an approval would pin. */
export type UserPairReview = {
  readonly id: string;
  readonly version: string;
  readonly abi: string;
  readonly capabilities: readonly string[];
  readonly permissions: readonly string[];
  readonly wasm_sha256: string;
  readonly manifest_sha256: string;
};

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
   * Injectable signed-pair verifier for tests — defaults to the real
   * release-signature check (`parsePluginPair` + the embedded key).
   */
  pairVerifier?:
    | ((text: string) => VerifiedPluginPair | null)
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
  /** Describe a candidate user pair for the consent review surface. */
  reviewUserPair(path: string): UserPairReview | null;
  /**
   * Persist a reviewed pair + its consent record — pinned to the
   * digests the consent dialog approved; a pair whose bytes drifted
   * since that review is refused outright.
   */
  approveUserPair(
    path: string,
    wasmSha256: string,
    manifestSha256: string,
  ): boolean;
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
  let lastUserSignature: string | null = null;
  // Provider ids the previous pass loaded from user pairs — the
  // revocation set for the next reload. `userScanCache` carries the
  // loaded entries so a signed-feed retry never rescans + reloads
  // unchanged user guests.
  let lastUserProviderIds: readonly string[] = [];
  let userScanCache: readonly LoadedPlugin[] | null = null;
  // User ids whose registered guest a signed load replaced after the
  // pair was cached — the cache entry still describes the user pair,
  // but the host would run signed bytes for it. A cached hit on one
  // drops the pass into a real rescan so approved bytes reload before
  // status advertises the entry again.
  const displacedUserIds = new Set<string>();

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

  /**
   * Read + shape a user-pair document — null on any malformed or
   * oversized input, the same bounds the loader's scan applies. The
   * raw bytes come back with the parsed candidate so an approval can
   * install the exact document that was reviewed.
   */
  function readPairDoc(
    path: string,
  ): {
    readonly raw: Buffer;
    readonly manifest: string;
    readonly candidate: NonNullable<ReturnType<typeof describeCandidate>>;
  } | null {
    let raw: Buffer;
    try {
      raw = fs.read(path);
    } catch {
      return null;
    }
    if (raw.byteLength > PAIR_FILE_MAX_BYTES) {
      return null;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof doc !== 'object' || doc === null) {
      return null;
    }
    const d = doc as Record<string, unknown>;
    const manifest = d['manifest'];
    const wasm = d['wasm'];
    if (typeof manifest !== 'string' || typeof wasm !== 'string') {
      return null;
    }
    const candidate = describeCandidate({
      manifestJson: manifest,
      wasmB64: wasm,
    });
    if (candidate === null) {
      return null;
    }
    return { raw, manifest, candidate };
  }

  async function loadPluginDir(
    h: PluginHostLike,
    reuseUserScan: boolean,
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
      const parseSignedPair =
        opts.pairVerifier ??
        ((text: string): VerifiedPluginPair | null => {
          const spki = createPublicKey({
            key: Buffer.concat([
              ED25519_SPKI_DER_PREFIX,
              pluginPublicKey(),
            ]),
            format: 'der',
            type: 'spki',
          });
          const verify: FeedSyncPorts['ed25519Verify'] = (
            message,
            signature,
          ) => verifySignature(null, message, spki, signature);
          return parsePluginPair(text, {
            keyId: PLUGIN_RELEASE_TRUST.keyId,
            publicKey: pluginPublicKey(),
            verify,
          });
        });
      // Feed-claimed identities: every signed pair that passed the
      // compatible gate reserves its id whether or not the load then
      // succeeded — a failed `loadPlugin` must not free a signed id
      // for an unsigned pair to answer under.
      const signedIds = new Set<string>();
      for (const name of fs.list(cacheDir).sort()) {
        if (!name.endsWith('.json')) {
          continue;
        }
        try {
          const pair = parseSignedPair(
            fs.read(join(cacheDir, name)).toString('utf8'),
          );
          if (
            pair === null ||
            (synced !== undefined && !synced.compatible.includes(pair.id))
          ) {
            continue;
          }
          const fields = manifestFields(pair.manifestJson, pair.id);
          signedIds.add(pair.id);
          signedIds.add(fields.providerId);
          const pluginId = await h.loadPlugin(
            Buffer.from(pair.wasmB64, 'base64'),
            pair.manifestJson,
          );
          loaded.push({
            pluginId,
            providerId: fields.providerId,
            capabilities: fields.capabilities,
            version: fields.version,
            permissions: fields.permissions,
          });
          // A signed load into a user-registered id replaces that
          // guest in the host's id-keyed registry — the stale cache
          // entry can no longer advertise it without reloading the
          // approved user bytes first.
          if (lastUserProviderIds.includes(fields.providerId)) {
            displacedUserIds.add(fields.providerId);
          }
        } catch {
          // A malformed pair is skipped, not fatal — other pairs still load.
        }
      }
      // User-installed third-party pairs (decision log, Plugin guests):
      // `<userData>/plugins-user/<id>.pair.json` documents carry
      // `{manifest, wasm}` without a release signature — they load
      // only behind the persisted consent record in
      // `<userData>/plugins-user/consents.json`, which pins the exact
      // digests and the approved permission set. Any drift is a skip,
      // never a silent accept; the pair file itself stays untouched.
      // The scan runs BEFORE the feed-failure gate so an offline user
      // keeps their approved providers when the signed cache is empty.
      const userDir = join(
        opts.env.AUQW_USER_DATA ?? process.cwd(),
        'plugins-user',
      );
      const consents = fs.exists(join(userDir, 'consents.json'))
        ? consentsFromJson(
            fs.read(join(userDir, 'consents.json')).toString('utf8'),
          )
        : [];
      // Signed feed ids are load-bearing identity: a user pair that
      // reuses one would replace the signed guest in the host's
      // id-keyed registry — unsigned code answering for a signed id.
      // Duplicate user ids among themselves double-register the same
      // way. Both are refusals, and the pair file stays untouched.
      const takenIds = new Set([...signedIds]);
      for (const p of loaded) {
        takenIds.add(p.providerId);
      }
      // Only signed loads count toward the retry gate — user pairs
      // must not mask a signed provider that failed `loadPlugin`.
      // Snapshotted before cached entries join `loaded`, or the split
      // below would count cache hits as fresh signed loads.
      const signedProviderIds = loaded.map((p) => p.providerId);
      const signedLoaded = loaded.length;
      const userProviderIds: string[] = [];
      // A signed-feed retry reuses the cached user scan — unchanged
      // guests are never re-loaded. A displaced id can't ride the
      // cache at all: nothing is registered for it while a signed
      // guest shadows it, so only the flag sees it — and the shadow
      // lifting means the approved pair must reload, which drops the
      // pass into the real scan below.
      let rescan = userScanCache === null || !reuseUserScan;
      if (!rescan) {
        for (const id of displacedUserIds) {
          if (!signedIds.has(id)) {
            rescan = true;
            break;
          }
        }
      }
      if (!rescan) {
        for (const cached of userScanCache ?? []) {
          if (takenIds.has(cached.providerId)) {
            continue;
          }
          loaded.push(cached);
          takenIds.add(cached.providerId);
          userProviderIds.push(cached.providerId);
        }
      }
      if (!rescan) {
        // A revoked guest stays owed until the unload lands — retry
        // it on the reuse path too, or a long reuse streak would
        // leave the revoked provider registered and callable.
        await unloadRevoked(h, userProviderIds, signedProviderIds);
        // Same empty-result gate as the full path: a failed feed with
        // no providers at all must reject — a cached empty scan
        // swallowing the failure would memoize an empty success and
        // kill every later recovery retry.
        if (loaded.length === 0 && feedFailure !== undefined) {
          throw feedFailure;
        }
        lastLoadIncomplete =
          synced !== undefined &&
          (synced.ready.length < synced.compatible.length ||
            signedLoaded < synced.compatible.length);
        return loaded;
      }
      for (const name of fs.list(userDir).sort()) {
        if (!name.endsWith('.pair.json')) {
          continue;
        }
        try {
          // Size-cap the raw pair bytes BEFORE parsing — an oversized
          // document must not transit the JSON parse at all.
          const raw = fs.read(join(userDir, name));
          if (raw.byteLength > PAIR_FILE_MAX_BYTES) {
            continue;
          }
          const doc: unknown = JSON.parse(raw.toString('utf8'));
          if (typeof doc !== 'object' || doc === null) {
            continue;
          }
          const d = doc as Record<string, unknown>;
          const manifest = d['manifest'];
          const wasm = d['wasm'];
          if (typeof manifest !== 'string' || typeof wasm !== 'string') {
            continue;
          }
          const candidate = describeCandidate({
            manifestJson: manifest,
            wasmB64: wasm,
          });
          if (candidate === null || !consentAllows(candidate, consents)) {
            continue;
          }
          if (takenIds.has(candidate.fields.id)) {
            // Consented but feed-claimed: shadowed, not absent — keep
            // the id marked so a pass reloads the pair once the feed
            // claim lifts. It never enters the cache while shadowed.
            if (signedIds.has(candidate.fields.id)) {
              displacedUserIds.add(candidate.fields.id);
            }
            continue;
          }
          const pluginId = await h.loadPlugin(
            Buffer.from(wasm, 'base64'),
            manifest,
          );
          const fields = manifestFields(manifest, name.replace(/\.pair\.json$/, ''));
          loaded.push({
            pluginId,
            providerId: fields.providerId,
            capabilities: fields.capabilities,
            version: fields.version,
            permissions: manifestPermissions(JSON.parse(manifest)),
          });
          takenIds.add(fields.providerId);
          userProviderIds.push(fields.providerId);
        } catch {
          // A malformed or unconsented pair is skipped, not fatal.
        }
      }
      // A consent removal must revoke the guest at runtime too — the
      // host's registry keeps the id registered otherwise. Guests the
      // previous pass loaded as user pairs but this pass no longer
      // carries are unloaded; a signed feed id never lands here.
      await unloadRevoked(h, userProviderIds, signedProviderIds);
      // Origins re-derive with the scan — except ids a signed guest
      // still shadows: those marks carry over so a later pass reloads
      // the pair when the feed claim lifts. An unclaimed mark reloaded
      // its pair (or found nothing left) this pass and drops.
      for (const id of [...displacedUserIds]) {
        if (!signedIds.has(id)) {
          displacedUserIds.delete(id);
        }
      }
      userScanCache = loaded.slice(signedLoaded);
      // A failed feed refresh with an empty cache must not pin an empty
      // provider set: `pluginsReady` resets on rejection, so the next
      // call re-syncs — a cache hit meanwhile stays usable offline.
      // User-approved pairs count as a loadable provider set too, so
      // the gate fires only when BOTH sources came up empty.
      if (loaded.length === 0 && feedFailure !== undefined) {
        throw feedFailure;
      }
      // The retry gate stays armed while the feed's compatible set is
      // not fully available — either because a listed plugin is below
      // its feed release (stale LKG loads, ready tracks currency) or
      // because a current pair failed to load into the host (loadPlugin
      // rejects skip it, so loaded counts only compatible pairs: dropped
      // ids were filtered above). The next `ready()` re-syncs and the
      // host's id-keyed insert hot-swaps the pair.
      lastLoadIncomplete =
        synced !== undefined &&
        (synced.ready.length < synced.compatible.length ||
          signedLoaded < synced.compatible.length);
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
          permissions: fields.permissions,
        });
      } catch {
        // A malformed pair is skipped, not fatal — other pairs still load.
      }
    }
    return loaded;
  }

  /**
   * Revoke user guests the current pass no longer carries — a failed
   * unload stays owed to the next scan instead of being dropped, so
   * the revoked provider can't keep answering under its old id.
   */
  async function unloadRevoked(
    h: PluginHostLike,
    keptUserIds: readonly string[],
    signedIds: readonly string[],
  ): Promise<void> {
    const stillOwed: string[] = [];
    for (const gone of lastUserProviderIds.filter(
      (id) => !keptUserIds.includes(id) && !signedIds.includes(id),
    )) {
      try {
        await h.unloadPlugin(gone);
      } catch {
        stillOwed.push(gone);
      }
    }
    lastUserProviderIds = [...keptUserIds, ...stillOwed];
  }

  async function ready(): Promise<readonly LoadedPlugin[]> {
    // The user-installed set is file-driven state that can change under
    // a healthy memoized load (a new pair, an approval, a removal): a
    // directory-content signature (name + mtime + size per entry)
    // invalidates the memo so the next `host:plugins`/`ready()` re-reads
    // consents and pairs without a utility restart.
    const userSignature = userDirSignature(
      join(opts.env.AUQW_USER_DATA ?? process.cwd(), 'plugins-user'),
      fs,
    );
    const userChanged = userSignature !== lastUserSignature;
    if (userChanged) {
      lastUserSignature = userSignature;
      lastLoadIncomplete = true;
    }
    if (pluginsReady === null || lastLoadIncomplete) {
      lastLoadIncomplete = false;
      // A signed-feed retry (the only other armer) reuses the cached
      // user scan — unchanged guests are never re-loaded.
      const pending = loadPluginDir(ensureHost(), !userChanged);
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
    reviewUserPair(path: string): UserPairReview | null {
      const doc = readPairDoc(path);
      if (doc === null) {
        return null;
      }
      return {
        id: doc.candidate.fields.id,
        version: doc.candidate.fields.version,
        abi: doc.candidate.fields.abi,
        capabilities: manifestFields(doc.manifest, '').capabilities,
        permissions: [...doc.candidate.fields.permissions],
        wasm_sha256: doc.candidate.wasm_sha256,
        manifest_sha256: doc.candidate.manifest_sha256,
      };
    },
    approveUserPair(
      path: string,
      wasmSha256: string,
      manifestSha256: string,
    ): boolean {
      const doc = readPairDoc(path);
      if (doc === null) {
        return false;
      }
      // The consent dialog approved an exact candidate — a pair
      // whose bytes drifted since that review is a refusal, never a
      // new approval. The pin is what `main` re-reviewed, not what
      // happens to sit at the path now.
      if (
        doc.candidate.wasm_sha256 !== wasmSha256 ||
        doc.candidate.manifest_sha256 !== manifestSha256
      ) {
        return false;
      }
      const id = doc.candidate.fields.id;
      // The pair lands byte-for-byte as the document just verified —
      // writing the reviewed bytes rather than re-reading the source
      // keeps a swapped file from ever reaching the install dir; the
      // loader re-verifies it there anyway. A replacement must never
      // disable the working install: the previous pair + consent are
      // captured first and restored on any failure, so a botched
      // upgrade leaves v1 fully intact.
      const userDir = join(
        opts.env.AUQW_USER_DATA ?? process.cwd(),
        'plugins-user',
      );
      const pairPath = join(userDir, `${id}.pair.json`);
      const consentsPath = join(userDir, 'consents.json');
      const hadPair = fs.exists(pairPath);
      const oldPair = hadPair ? fs.read(pairPath) : undefined;
      const oldConsents = fs.exists(consentsPath)
        ? fs.read(consentsPath).toString('utf8')
        : undefined;
      try {
        fs.mkdir(userDir);
        fs.write(pairPath, doc.raw.toString('utf8'));
        const consents = oldConsents !== undefined
          ? consentsFromJson(oldConsents)
          : [];
        const next = consents.filter((c) => c.id !== id);
        next.push({
          id,
          version: doc.candidate.fields.version,
          abi: doc.candidate.fields.abi,
          wasm_sha256: doc.candidate.wasm_sha256,
          manifest_sha256: doc.candidate.manifest_sha256,
          approved_permissions: [...doc.candidate.fields.permissions],
        });
        fs.write(consentsPath, consentsToJson(next));
      } catch {
        try {
          if (oldPair !== undefined) {
            fs.write(pairPath, oldPair.toString('utf8'));
          }
          if (oldConsents !== undefined) {
            fs.write(consentsPath, oldConsents);
          }
        } catch {
          // Best-effort restore — the loader's digest pin still
          // refuses a mismatched pair, so the failure mode stays
          // 'provider absent', never 'provider wrong'.
        }
        return false;
      }
      return true;
    },
    async status(): Promise<HostPluginsResult> {
      try {
        const loaded = await ready();
        const manifests: PluginManifestPayload[] = loaded.map((p) => ({
          pluginId: p.pluginId,
          providerId: p.providerId,
          capabilities: p.capabilities,
          version: p.version,
          permissions: p.permissions,
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
