import { createSha256 } from '../downloads/sha256.ts';
import { utf8Decode, utf8Encode } from '../utf8.ts';

/**
 * User-installed third-party providers (decision log, Plugin guests):
 * a pair outside the signed release feed loads only behind a persisted
 * consent record. The record pins the exact bytes (`wasm_sha256`), the
 * manifest (`manifest_sha256`), and the permission set the user saw —
 * any drift on any axis is a hard load refusal, never a silent accept.
 * The sandbox bounds what a loaded guest can *do* (memory, network
 * allowlist, budgets); consent decides whether it loads at all.
 */

const MANIFEST_MAX_BYTES = 64 * 1024;
const WASM_MAX_BYTES = 16 * 1024 * 1024;

/** The persisted per-plugin consent record. */
export type ProviderConsent = {
  readonly id: string;
  readonly version: string;
  readonly abi: string;
  readonly wasm_sha256: string;
  readonly manifest_sha256: string;
  readonly approved_permissions: readonly string[];
};

/** A candidate pair awaiting the consent gate. */
export type UnverifiedCandidate = {
  readonly manifestJson: string;
  readonly wasmB64: string;
};

/** Manifest fields the consent gate needs — bounded shape read. */
export type CandidateManifestFields = {
  readonly id: string;
  readonly version: string;
  readonly abi: string;
  readonly permissions: readonly string[];
};

function sha256Hex(bytes: Uint8Array): string {
  const h = createSha256();
  h.update(bytes);
  return `sha256:${h.digest()}`;
}

/**
 * Extract the consent-relevant fields from a manifest JSON. Returns
 * null on malformed input — the caller treats that as a refusal.
 */
export function candidateFields(
  manifestJson: string,
): CandidateManifestFields | null {
  if (utf8Encode(manifestJson).byteLength > MANIFEST_MAX_BYTES) {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(manifestJson);
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
  const permissions = d['permissions'];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 128 ||
    typeof version !== 'string' ||
    typeof abi !== 'string' ||
    !Array.isArray(permissions) ||
    !permissions.every(
      (p): p is string =>
        typeof p === 'string' && p.length > 0 && p.length <= 128,
    )
  ) {
    return null;
  }
  return { id, version, abi, permissions };
}

/** Strict base64 → bytes — same alphabet and padding rules as feed-sync. */
const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Bytes(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    return null;
  }
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const s = b64.slice(0, b64.length - pad).padEnd(b64.length, 'A');
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  for (let i = 0, j = 0; i < s.length; i += 4) {
    const n =
      (B64.indexOf(s.charAt(i)) << 18) |
      (B64.indexOf(s.charAt(i + 1)) << 12) |
      (B64.indexOf(s.charAt(i + 2)) << 6) |
      (B64.indexOf(s.charAt(i + 3)));
    out[j++] = (n >> 16) & 0xff;
    if (j < out.length) out[j++] = (n >> 8) & 0xff;
    if (j < out.length) out[j++] = n & 0xff;
  }
  return out;
}

/**
 * What the consent review surface shows: the candidate's identity plus
 * the exact bytes it would pin. `null` when the pair is malformed
 * (bad base64, oversized, unreadable manifest) — never a partial view.
 */
export function describeCandidate(
  candidate: UnverifiedCandidate,
): {
  fields: CandidateManifestFields;
  wasm_sha256: string;
  manifest_sha256: string;
} | null {
  const fields = candidateFields(candidate.manifestJson);
  if (fields === null) {
    return null;
  }
  const wasmBytes = b64Bytes(candidate.wasmB64);
  if (
    wasmBytes === null ||
    wasmBytes.byteLength === 0 ||
    wasmBytes.byteLength > WASM_MAX_BYTES
  ) {
    return null;
  }
  return {
    fields,
    wasm_sha256: sha256Hex(wasmBytes),
    manifest_sha256: sha256Hex(utf8Encode(candidate.manifestJson)),
  };
}

/**
 * The consent gate: a candidate loads only when a persisted record
 * pins its exact digests and the permission set the user approved.
 * Drift on any axis — new bytes, new manifest, new permissions — is a
 * refusal that re-asks; the empty record set refuses everything.
 */
export function consentAllows(
  candidate: ReturnType<typeof describeCandidate>,
  consents: readonly ProviderConsent[],
): boolean {
  if (candidate === null) {
    return false;
  }
  const { fields } = candidate;
  return consents.some(
    (c) =>
      c.id === fields.id &&
      c.version === fields.version &&
      c.abi === fields.abi &&
      c.wasm_sha256 === candidate.wasm_sha256 &&
      c.manifest_sha256 === candidate.manifest_sha256 &&
      samePermissions(c.approved_permissions, fields.permissions),
  );
}

/** Order-insensitive permission comparison — sets, not sequences. */
function samePermissions(
  approved: readonly string[],
  declared: readonly string[],
): boolean {
  if (approved.length !== declared.length) {
    return false;
  }
  const left = [...approved].sort();
  const right = [...declared].sort();
  return left.every((p, i) => p === right[i]);
}

/** Serialize consent records for persistence. */
export function consentsToJson(consents: readonly ProviderConsent[]): string {
  return JSON.stringify({ consents });
}

/** Parse persisted consent records; malformed input yields `[]`. */
export function consentsFromJson(text: string): readonly ProviderConsent[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null) {
    return [];
  }
  const arr = (doc as Record<string, unknown>)['consents'];
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: ProviderConsent[] = [];
  for (const entry of arr) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = e['id'];
    const version = e['version'];
    const abi = e['abi'];
    const wasmSha = e['wasm_sha256'];
    const manifestSha = e['manifest_sha256'];
    const permissions = e['approved_permissions'];
    if (
      typeof id !== 'string' ||
      typeof version !== 'string' ||
      typeof abi !== 'string' ||
      typeof wasmSha !== 'string' ||
      typeof manifestSha !== 'string' ||
      !Array.isArray(permissions) ||
      !permissions.every(
        (p): p is string =>
          typeof p === 'string' && p.length > 0 && p.length <= 128,
      )
    ) {
      continue;
    }
    out.push({
      id,
      version,
      abi,
      wasm_sha256: wasmSha,
      manifest_sha256: manifestSha,
      approved_permissions: permissions,
    });
  }
  return out;
}

/** Decode base64 wasm bytes for a host `loadPlugin` — null when invalid. */
export function candidateWasmBytes(
  candidate: UnverifiedCandidate,
): Uint8Array | null {
  return b64Bytes(candidate.wasmB64);
}

/** utf8 re-export for callers that read files as bytes. */
export { utf8Decode };
