import { appError } from '../errors.ts';
import { createSha256 } from '../downloads/sha256.ts';
import { utf8Decode, utf8Encode } from '../utf8.ts';

/**
 * OTA plugin delivery (decision log, Plugin guests): the app embeds
 * only the release-signing public key + feed URL and downloads signed
 * artifacts at runtime — nothing is bundled. `releases/feed.json` on
 * Auqw-plugins main is a plain index ({keyId, plugins[]}); each
 * artifact still carries its own ed25519 signature over the canonical
 * `auqw-release-v1` payload, so the feed needs no signature of its
 * own. The per-plugin `<id>.wasm` + `<id>.manifest.json` pair lands
 * under the app's plugin cache dir; loaders scan it verbatim.
 *
 * Failure posture: a fetch or verification failure never destroys the
 * on-disk set — last-known-good stays loadable. A half-written pair
 * can't smuggle through: the host pins `artifact.digest` == sha256 of
 * the wasm at load, so a torn pair fails loudly and self-heals on the
 * next successful sync.
 */

/** One plugin entry in `releases/feed.json`. */
export type PluginFeedEntry = {
  readonly id: string;
  readonly version: string;
  readonly abi: string;
  /** `sha256:<64 lowercase hex>` of the wasm bytes. */
  readonly wasm_sha256: string;
  /** `sha256:<64 lowercase hex>` of `plugin.manifest.json`. */
  readonly manifest_sha256: string;
  /** Base64 ed25519 signature over the canonical release payload. */
  readonly signature: string;
};

export type PluginFeed = {
  readonly keyId: string;
  readonly plugins: readonly PluginFeedEntry[];
};

/** Platform seam — desktop wires node fs + node:crypto, mobile wires
 * expo-file-system + @noble/curves. */
export type FeedSyncPorts = {
  /** GET url → body bytes; rejects on non-2xx or transport error. */
  fetchBytes(url: string): Promise<Uint8Array>;
  /** ed25519 verify: 64-byte signature, message, raw 32-byte key. */
  ed25519Verify(
    message: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): boolean;
  /** File names in `dir`; `[]` when the dir doesn't exist. */
  list(dir: string): Promise<readonly string[]>;
  /** File bytes, or null when absent. */
  read(path: string): Promise<Uint8Array | null>;
  /** Atomic write (tmp + rename). */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Remove a file when present. */
  remove(path: string): Promise<void>;
};

/** The newest ABI this build serves. */
export const PLUGIN_ABI = '0.1.1';

/**
 * Manifest `abi` pins this build accepts — every version sharing the
 * 0.1.x protocol line. A feed entry pinning anything else is skipped
 * (never downloaded); the installed pair stays on disk so an older
 * release keeps serving until the app updates.
 */
export const PLUGIN_ABIS: ReadonlySet<string> = new Set(['0.1.0', '0.1.1']);

/**
 * Trust root, embedded at build time. `publicKey` is the raw 32-byte
 * ed25519 key (SPKI DER is `<12-byte prefix>‖raw` on targets that need
 * it); `keyId` is the first 16 hex of sha256(SPKI DER) and must match
 * `feed.keyId` — a feed signed by any other key is refused wholesale.
 * `feedUrl` points at raw.githubusercontent on the public plugins
 * repo; dev loops override with a local file server.
 */
export const PLUGIN_RELEASE_TRUST = {
  keyId: '42d8cac606f16c04',
  publicKeyHex:
    'a1dd9fc1169be5ac2950bf55e2bcc4589774453ca935fb54f2991e5b3cc43420',
  feedUrl:
    'https://raw.githubusercontent.com/Vehicoule/Auqw-plugins/main/releases/feed.json',
} as const;

// Bounded reads — feed is ~KBs, manifests ~1KB, wasms today ~200KB.
const FEED_MAX_BYTES = 256 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const WASM_MAX_BYTES = 16 * 1024 * 1024;

function sha256Hex(bytes: Uint8Array): string {
  const h = createSha256();
  h.update(bytes);
  return `sha256:${h.digest()}`;
}

/** The embedded release-signing public key as raw 32 bytes. */
export function pluginPublicKey(): Uint8Array {
  const hex = PLUGIN_RELEASE_TRUST.publicKeyHex;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes → standard base64 (btoa is not universal on Hermes). */
export function b64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const tail = bytes.length - i;
    out +=
      B64.charAt((n >> 18) & 63) +
      B64.charAt((n >> 12) & 63) +
      (tail > 1 ? B64.charAt((n >> 6) & 63) : '=') +
      (tail > 2 ? B64.charAt(n & 63) : '=');
  }
  return out;
}

/** The canonical sign payload — same byte shape sign.mjs emits. */
function releasePayload(
  id: string,
  version: string,
  abi: string,
  wasmSha256: string,
  manifestSha256: string,
  keyId: string,
): Uint8Array {
  return utf8Encode(
    `auqw-release-v1\n${id}\n${version}\n${abi}\n${wasmSha256}\n${manifestSha256}\n${keyId}\n`,
  );
}

function verifyRelease(
  entry: PluginFeedEntry,
  manifest: Uint8Array,
  wasm: Uint8Array,
  opts: {
    keyId: string;
    publicKey: Uint8Array;
    verify: FeedSyncPorts['ed25519Verify'];
  },
): boolean {
  const signature = base64Bytes(entry.signature);
  return (
    signature !== null &&
    opts.verify(
      releasePayload(
        entry.id,
        entry.version,
        entry.abi,
        entry.wasm_sha256,
        entry.manifest_sha256,
        opts.keyId,
      ),
      signature,
      opts.publicKey,
    )
  );
}

/** One verified cached plugin, decoded for a host `loadPlugin`. */
export type VerifiedPluginPair = {
  readonly id: string;
  readonly version: string;
  readonly wasmSha256: string;
  readonly manifestSha256: string;
  readonly wasmB64: string;
  readonly manifestJson: string;
};

/**
 * Offline authentication for the cache: re-verifies the stored
 * release signature and both digests, so a pair document that was
 * forged, truncated, or tampered with can never load. Returns the
 * verified pair, or null when anything fails.
 */
export function parsePluginPair(
  text: string,
  opts: {
    keyId: string;
    publicKey: Uint8Array;
    verify: FeedSyncPorts['ed25519Verify'];
  },
): VerifiedPluginPair | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) {
    return null;
  }
  const d = doc as Record<string, unknown>;
  const id = d['id'];
  const version = d['version'];
  const abi = d['abi'];
  const wasmSha = d['wasm_sha256'];
  const manifestSha = d['manifest_sha256'];
  const signature = d['signature'];
  const manifest = d['manifest'];
  const wasm = d['wasm'];
  if (
    typeof id !== 'string' ||
    typeof version !== 'string' ||
    typeof abi !== 'string' ||
    typeof wasmSha !== 'string' ||
    typeof manifestSha !== 'string' ||
    typeof signature !== 'string' ||
    typeof manifest !== 'string' ||
    typeof wasm !== 'string'
  ) {
    return null;
  }
  const wasmBytes = base64Bytes(wasm);
  const sigBytes = base64Bytes(signature);
  const manifestBytes = utf8Encode(manifest);
  if (
    wasmBytes === null ||
    sigBytes === null ||
    wasmBytes.byteLength > WASM_MAX_BYTES ||
    manifestBytes.byteLength > MANIFEST_MAX_BYTES ||
    sha256Hex(wasmBytes) !== wasmSha ||
    sha256Hex(manifestBytes) !== manifestSha ||
    !PLUGIN_ABIS.has(abi)
  ) {
    return null;
  }
  if (
    !opts.verify(
      releasePayload(id, version, abi, wasmSha, manifestSha, opts.keyId),
      sigBytes,
      opts.publicKey,
    )
  ) {
    return null;
  }
  return {
    id,
    version,
    wasmSha256: wasmSha,
    manifestSha256: manifestSha,
    wasmB64: wasm,
    manifestJson: manifest,
  };
}

/**
 * Decode table — one slot per ASCII byte, -1 marks an invalid char.
 * Built once from B64 so the decode is a table read per char, not a
 * linear alphabet scan (the wasm body runs through here by the
 * megabyte on plugin downloads).
 */
const B64_DECODE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) {
    table[B64.charCodeAt(i)] = i;
  }
  return table;
})();

/** Strict base64 → bytes (no `Uint8Array.fromBase64` — Hermes lacks it). */
function base64Bytes(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0) {
    return null;
  }
  // Padding lives only on the final quad — strict shape: pad 1 must
  // end "xy=", pad 2 must end "xy==", and nothing else may repeat.
  const finalQuad = b64.length - 4;
  const c2 = b64.charCodeAt(finalQuad + 2);
  const c3 = b64.charCodeAt(finalQuad + 3);
  const pad = c3 === 61 ? (c2 === 61 ? 2 : 1) : 0;
  if (pad === 1 && c2 === 61) {
    return null;
  }
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  const len = b64.length - pad;
  let j = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = b64.charCodeAt(i);
    const c1 = b64.charCodeAt(i + 1);
    const q2 = b64.charCodeAt(i + 2);
    const q3 = b64.charCodeAt(i + 3);
    const v0 = c0 < 128 ? (B64_DECODE[c0] ?? -1) : -1;
    const v1 = c1 < 128 ? (B64_DECODE[c1] ?? -1) : -1;
    const v2 = q2 < 128 ? (B64_DECODE[q2] ?? -1) : -1;
    const v3 = q3 < 128 ? (B64_DECODE[q3] ?? -1) : -1;
    // Interior quads carry no padding; the final quad keeps its tail
    // chars strictly alphabet-only.
    const last = i === finalQuad;
    if (
      v0 < 0 ||
      v1 < 0 ||
      (!last && (v2 < 0 || v3 < 0)) ||
      (last &&
        ((pad === 0 && (v2 < 0 || v3 < 0)) ||
          (pad === 1 && (v2 < 0 || q3 !== 61)) ||
          (pad === 2 && (q2 !== 61 || q3 !== 61))))
    ) {
      return null;
    }
    const n =
      (v0 << 18) |
      (v1 << 12) |
      (i + 2 < len ? v2 << 6 : 0) |
      (i + 3 < len ? v3 : 0);
    if (j < out.length) {
      out[j++] = n >> 16;
    }
    if (j < out.length) {
      out[j++] = n >> 8;
    }
    if (j < out.length) {
      out[j++] = n;
    }
  }
  return out;
}

function isEntry(raw: unknown): raw is PluginFeedEntry {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const e = raw as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(e['id']) &&
    typeof e['version'] === 'string' &&
    /^\d+\.\d+\.\d+$/.test(e['version']) &&
    typeof e['abi'] === 'string' &&
    typeof e['wasm_sha256'] === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(e['wasm_sha256']) &&
    typeof e['manifest_sha256'] === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(e['manifest_sha256']) &&
    typeof e['signature'] === 'string' &&
    base64Bytes(e['signature']) !== null
  );
}

/** Parse + shape-check a feed body. Throws `invalid-response`. */
export function parsePluginFeed(
  text: string,
  expectedKeyId: string,
): PluginFeed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw appError('invalid-response', 'plugin feed is not JSON');
  }
  const body = raw as Record<string, unknown>;
  const plugins = body?.['plugins'];
  if (
    body === null ||
    body['keyId'] !== expectedKeyId ||
    !Array.isArray(plugins) ||
    plugins.length === 0 ||
    !plugins.every(isEntry) ||
    new Set(plugins.map((p) => p.id)).size !== plugins.length
  ) {
    throw appError('invalid-response', 'plugin feed failed shape check');
  }
  return { keyId: expectedKeyId, plugins };
}

/**
 * Refresh the on-disk plugin set to the feed's: fetch → sha-check →
 * signature-verify → write, per plugin. Entries whose on-disk pair
 * already matches the feed digest are skipped; entries the feed drops
 * are swept; a per-plugin failure keeps last-known-good.
 *
 * Returns the ids whose pair is now current — feed-level failures
 * (unreachable, malformed, wrong keyId) throw so the caller can fall
 * back to the cache as-is.
 */
export async function syncPluginFeed(opts: {
  readonly feedUrl: string;
  readonly keyId: string;
  /** Raw 32-byte ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** Cache dir holding signed `<id>.json` pair documents. */
  readonly dir: string;
  readonly ports: FeedSyncPorts;
}): Promise<{ readonly ready: readonly string[]; readonly compatible: readonly string[] }> {
  const { ports, dir } = opts;
  const feedBytes = await ports.fetchBytes(opts.feedUrl);
  if (feedBytes.byteLength > FEED_MAX_BYTES) {
    throw appError('invalid-response', 'plugin feed over size cap');
  }
  const feed = parsePluginFeed(utf8Decode(feedBytes), opts.keyId);
  const base = opts.feedUrl.slice(0, opts.feedUrl.lastIndexOf('/') + 1);
  const current = new Set<string>();
  const compatible: string[] = [];
  const ready: string[] = [];
  for (const entry of feed.plugins) {
    // The feed still names this id — keep any installed pair alive
    // even when the offered release's abi is one this build can't
    // serve (the sweep below only removes what the feed dropped).
    current.add(entry.id);
    if (!PLUGIN_ABIS.has(entry.abi)) {
      continue;
    }
    compatible.push(entry.id);
    // Cache hit: the stored pair re-verifies offline (signature +
    // both digests), so cached bytes are never loaded unverified.
    const cached = await ports.read(`${dir}/${entry.id}.json`);
    const pair =
      cached === null
        ? null
        : parsePluginPair(utf8Decode(cached), {
            keyId: opts.keyId,
            publicKey: opts.publicKey,
            verify: ports.ed25519Verify,
          });
    if (
      pair !== null &&
      pair.id === entry.id &&
      pair.wasmSha256 === entry.wasm_sha256 &&
      pair.manifestSha256 === entry.manifest_sha256
    ) {
      ready.push(entry.id);
      continue;
    }
    try {
      const dirUrl = `${base}${entry.id}/${entry.version}/`;
      const [manifest, wasm] = await Promise.all([
        ports.fetchBytes(`${dirUrl}plugin.manifest.json`),
        ports.fetchBytes(`${dirUrl}${entry.id}-${entry.version}.wasm`),
      ]);
      if (
        manifest.byteLength > MANIFEST_MAX_BYTES ||
        wasm.byteLength > WASM_MAX_BYTES ||
        sha256Hex(manifest) !== entry.manifest_sha256 ||
        sha256Hex(wasm) !== entry.wasm_sha256 ||
        !verifyRelease(entry, manifest, wasm, {
          keyId: opts.keyId,
          publicKey: opts.publicKey,
          verify: ports.ed25519Verify,
        })
      ) {
        continue;
      }
      // One self-describing document — a single atomic write per
      // plugin, so no torn pair can ever strand a provider.
      await ports.write(
        `${dir}/${entry.id}.json`,
        utf8Encode(
          JSON.stringify({
            id: entry.id,
            version: entry.version,
            abi: entry.abi,
            wasm_sha256: entry.wasm_sha256,
            manifest_sha256: entry.manifest_sha256,
            signature: entry.signature,
            manifest: utf8Decode(manifest),
            wasm: b64Encode(wasm),
          }),
        ),
      );
      ready.push(entry.id);
    } catch {
      // Per-plugin failure keeps last-known-good on disk.
    }
  }
  // Sweep artifact-shaped files the feed does not name (legacy
  // two-file sets from earlier builds, dropped plugins, stray
  // staging) — non-artifact names in the dir are left alone.
  for (const name of await ports.list(dir)) {
    const isArtifact =
      name.endsWith('.json') ||
      name.endsWith('.wasm') ||
      name.endsWith('.manifest.json') ||
      name.endsWith('.part');
    if (!isArtifact || name === 'feed.json') {
      continue;
    }
    const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null;
    if (stem === null || !current.has(stem)) {
      await ports.remove(`${dir}/${name}`).catch(() => {});
    }
  }
  // Every compatible entry failed while the cache produced nothing —
  // treat it like a feed-level failure so callers retry instead of
  // pinning an empty provider set.
  if (compatible.length > 0 && ready.length === 0) {
    throw appError('transient', 'no feed plugins became ready');
  }
  return { ready, compatible };
}
