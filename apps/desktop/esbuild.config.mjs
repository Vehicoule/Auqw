import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

const nodeBundle = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'warning',
};

// ESM main entry — Electron >= 28 loads ESM mains from `main` when the
// package is `"type": "module"`.
await build({
  ...nodeBundle,
  format: 'esm',
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
});

// Sandboxed preloads run in a CJS-only context — never emit ESM here.
await build({
  ...nodeBundle,
  format: 'cjs',
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
});

// utilityProcess.fork children carry no Electron import; CJS keeps the
// fork load path identical across platforms.
await build({
  ...nodeBundle,
  format: 'cjs',
  entryPoints: ['src/utility/index.ts'],
  outfile: 'dist/utility/index.cjs',
});

await build({
  bundle: true,
  platform: 'browser',
  target: 'chrome152',
  format: 'iife',
  sourcemap: true,
  logLevel: 'warning',
  entryPoints: ['src/renderer/index.ts'],
  outfile: 'dist/renderer/index.js',
});

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
console.log('desktop bundles written to dist/');
