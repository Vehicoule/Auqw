import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

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
 * A packaged build with no manifest, a malformed line, a digest
 * mismatch — OR A LOOSE FILE THE MANIFEST DOES NOT COVER — refuses
 * the fork: coverage is enumerated on disk, so a manifest that simply
 * omits a planted or left-behind file can't let it ride in loose.
 * The supervisor treats the throw as a crash and retries, but a
 * tampered file never passes.
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
  const expected = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (line === '') {
      continue;
    }
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    const hex = match?.[1];
    const rel = match?.[2];
    if (
      hex === undefined ||
      rel === undefined ||
      rel.startsWith('/') ||
      rel.includes('..') ||
      rel.includes('\\') ||
      expected.has(rel)
    ) {
      throw new Error('utility-integrity: malformed manifest');
    }
    expected.set(rel, hex);
  }
  if (expected.size === 0) {
    throw new Error('utility-integrity: manifest covered no files');
  }
  const found = new Set<string>();
  for (const abs of looseFiles(resourcesPath)) {
    const rel = relative(resourcesPath, abs).split(sep).join('/');
    found.add(rel);
    const hex = expected.get(rel);
    if (hex === undefined) {
      throw new Error(
        `utility-integrity: manifest omits loose file: ${rel}`,
      );
    }
    const actual = createHash('sha256')
      .update(readFileSync(abs))
      .digest('hex');
    if (actual !== hex) {
      throw new Error(`utility-integrity: digest mismatch: ${rel}`);
    }
  }
  for (const rel of expected.keys()) {
    if (!found.has(rel)) {
      throw new Error(
        `utility-integrity: manifest names a missing file: ${rel}`,
      );
    }
  }
}

/**
 * The loose payloads the fork can load: everything under
 * `app.asar.unpacked` plus the `*.node` artifacts dropped at the
 * resources root. Sorted for a deterministic refusal order.
 */
function looseFiles(resourcesPath: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  };
  const unpacked = join(resourcesPath, 'app.asar.unpacked');
  if (existsSync(unpacked)) {
    walk(unpacked);
  }
  for (const entry of readdirSync(resourcesPath, {
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith('.node')) {
      files.push(join(resourcesPath, entry.name));
    }
  }
  return files.sort();
}
