import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Verification for the loose files `utilityProcess.fork` loads —
 * `asarUnpack` puts `dist/utility/**` (and the napi artifact under
 * resources) outside app.asar, which means outside the asar-integrity
 * envelope electronFuses embeds. after-pack.mjs writes
 * `utility-integrity.sha256` beside them — sha256sum-compatible
 * `<hex>  <relpath>` lines (the tooling/checksums.mjs convention),
 * paths POSIX-joined relative to resourcesPath. On macOS the manifest
 * is written before the ad-hoc seal, so codesign --deep seals it into
 * the bundle; linux/win alpha builds ship it unsealed — tamper-evident
 * in line with the unsigned-alpha posture, never worse than asar.
 *
 * A packaged build with no manifest, a malformed line, or a digest
 * mismatch refuses the fork — the supervisor treats the throw as a
 * crash and retries, but a tampered file never passes.
 */
export function verifyUtilityIntegrity(resourcesPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(
      join(resourcesPath, 'utility-integrity.sha256'),
      'utf8',
    );
  } catch {
    throw new Error(
      'utility-integrity: manifest missing — refusing utility fork',
    );
  }
  let covered = 0;
  for (const line of raw.split('\n')) {
    if (line === '') {
      continue;
    }
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    const rel = match?.[2];
    if (
      match === null ||
      rel === undefined ||
      rel.startsWith('/') ||
      rel.includes('..') ||
      rel.includes('\\')
    ) {
      throw new Error('utility-integrity: malformed manifest');
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(resourcesPath, rel));
    } catch {
      throw new Error(
        `utility-integrity: manifest names a missing file: ${rel}`,
      );
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== match[1]) {
      throw new Error(`utility-integrity: digest mismatch: ${rel}`);
    }
    covered += 1;
  }
  if (covered === 0) {
    throw new Error('utility-integrity: manifest covered no files');
  }
}
