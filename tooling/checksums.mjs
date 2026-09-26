#!/usr/bin/env node
// Write SHA256SUMS.txt for the shipped artifacts in a directory —
// sha256sum -c compatible ("<hex>  <name>" lines). Used instead of the
// sha256sum binary because macOS runners only ship `shasum` and the
// release matrix builds on three OSes.
//
//   node tooling/checksums.mjs <dir> [outName]
//
// `outName` defaults to SHA256SUMS.txt; the release jobs pass a
// per-platform name (SHA256SUMS-Linux.txt, SHA256SUMS-Android.txt) so
// the bundle dirs don't collide on one release's asset list.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';
const outName = process.argv[3] ?? 'SHA256SUMS.txt';
// *.blockmap is electron-updater differential-update internals — not
// shipped in alpha (excluded from upload), so it isn't checksummed
// either or the release-side `sha256sum -c` would fail on missing files.
const names = readdirSync(dir)
  .filter((n) => n.startsWith('auqw-') && !n.startsWith('SHA256SUMS') && !n.endsWith('.blockmap'))
  .sort();

if (names.length === 0) {
  console.error(`checksums: no auqw-* artifacts in ${dir}`);
  process.exit(1);
}

const lines = names.map((n) => {
  const hex = createHash('sha256').update(readFileSync(join(dir, n))).digest('hex');
  return `${hex}  ${n}`;
});

writeFileSync(join(dir, outName), lines.join('\n') + '\n');
console.log(lines.join('\n'));
