import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const require_ = createRequire(import.meta.url);
const jsdomRoot = dirname(require_.resolve('jsdom/package.json'));

// jsdom reads its default stylesheet off disk by `__dirname` path,
// which a bundle destroys — inline it at build time. css-tree (a
// jsdom dep) loads mdn-data JSON via createRequire(import.meta.url)
// — dropping the two lines leaves literal require()s esbuild bundles
// as static deps. Its lazy `require.resolve('xhr-sync-worker.js')`
// needs the real file beside the bundle — copied post-build below.
const domBundleFixes = {
  name: 'dom-bundle-fixes',
  setup(b) {
    b.onLoad({ filter: /computed-style\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      if (!src.includes('default-stylesheet.css')) return null;
      const css = JSON.stringify(
        await readFile(
          join(jsdomRoot, 'lib/jsdom/browser/default-stylesheet.css'),
          'utf8',
        ),
      );
      return {
        contents: src.replace(
          /const defaultStyleSheet = fs\.readFileSync\([\s\S]*?\);/,
          `const defaultStyleSheet = ${css};`,
        ),
        loader: 'js',
      };
    });
    b.onLoad(
      { filter: /css-tree\/lib\/(data|data-patch|version)\.js$/ },
      async (args) => ({
        contents: (await readFile(args.path, 'utf8'))
          .replace(/import \{ createRequire \} from 'module';\s*/, '')
          .replace(/const require = createRequire\(import\.meta\.url\);\s*/, ''),
        loader: 'js',
      }),
    );
  },
};

const nodeBundle = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  // canvas/bufferutil/utf-8-validate are optional native addons jsdom
  // probes in try/catch — absent is the supported path.
  external: ['electron', 'canvas', 'bufferutil', 'utf-8-validate'],
  plugins: [domBundleFixes],
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
// jsdom's synchronous-XHR worker is looked up lazily by path — it
// must exist beside the bundles that embed jsdom (dist/utility).
// Two packaging repairs ship with it: the repo's `"type": "module"`
// scope would parse the worker's .js as ESM and its CJS requires
// would throw, so dist/utility gets its own CJS marker; and its
// `require("../../..")` chains assume jsdom's on-disk layout, so
// they are rewritten to package-root specifiers resolvable from the
// bundle output (dev: node_modules; packaged: the asar-unpacked
// node_modules).
const workerSrc = await readFile(
  join(jsdomRoot, 'lib/jsdom/living/xhr/xhr-sync-worker.js'),
  'utf8',
);
await writeFile(
  'dist/utility/xhr-sync-worker.js',
  workerSrc
    .replace('require("../../../..")', 'require("jsdom")')
    .replace(
      'require("../../../generated/idl/utils")',
      'require("jsdom/lib/generated/idl/utils")',
    ),
);
await writeFile(
  'dist/utility/package.json',
  JSON.stringify({ type: 'commonjs' }),
);
console.log('desktop bundles written to dist/');
