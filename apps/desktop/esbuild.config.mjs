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

// The POT minter child — remote BotGuard interpreter code runs in this
// dedicated process, never the utility's. Bundled beside the utility
// entry (child_process.fork target); asarUnpack covers dist/utility/**.
await build({
  ...nodeBundle,
  format: 'cjs',
  entryPoints: ['src/utility/pot-minter-child.ts'],
  outfile: 'dist/utility/pot-minter-child.cjs',
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

// The product UI — Session boot + ui-web screens. Same sandbox rules
// as the dev harness bundle: iife, no node builtins, chrome152.
await build({
  bundle: true,
  platform: 'browser',
  target: 'chrome152',
  format: 'iife',
  sourcemap: true,
  logLevel: 'warning',
  // shared/local-paths.ts pulls node:url/node:path into this browser
  // bundle — alias to the POSIX implementations in src/shared/posix-
  // path.ts (URI math is POSIX-shaped on both sides). The utility
  // bundle below keeps the real Node builtins.
  alias: {
    'node:url': './src/shared/posix-path.ts',
    'node:path': './src/shared/posix-path.ts',
  },
  entryPoints: ['src/renderer/app.tsx'],
  outfile: 'dist/renderer/app.js',
});

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await copyFile('src/renderer/app.html', 'dist/renderer/app.html');
// The stylesheet is an export of @auqw/ui-web; the design-token sheet
// is the package's generated css artifact (tracked, not bundled).
await copyFile(
  '../../packages/ui-web/src/styles.css',
  'dist/renderer/styles.css',
);
await copyFile(
  '../../packages/design-tokens/dist/tokens.css',
  'dist/renderer/tokens.css',
);
console.log('desktop bundles written to dist/');
