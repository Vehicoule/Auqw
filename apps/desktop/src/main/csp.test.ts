import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEqual } from '@auqw/application/testing';
import { imgSrcSources, rewriteCsp } from './csp.ts';

const DOC = `<!doctype html>
<html>
  <head>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' http://127.0.0.1:* blob: file:; connect-src 'self' http://127.0.0.1:*"
    />
  </head>
  <body><div id="root"></div></body>
</html>
`;

function cspContent(html: string): string {
  const content = /content="([^"]*)"/.exec(
    /<meta\b[^>]*Content-Security-Policy[^>]*>/.exec(html)?.[0] ?? '',
  );
  return content?.[1] ?? '';
}

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-csp-'));
  try {
    // img-src enumerates the proven artwork CDNs even with no
    // manifests — the bundled providers' covers must never break.
    const bare = imgSrcSources(dir);
    const bareSources = new Set(bare.split(' '));
    for (const host of [
      'https://*.dzcdn.net',
      'https://*.ggpht.com',
      'https://*.googleusercontent.com',
      'https://*.mzstatic.com',
    ]) {
      assert(
        bareSources.has(host),
        `img-src dropped the artwork host ${host}: ${bare}`,
      );
    }
    assert(
      !bareSources.has('https:'),
      `img-src kept the blanket https: source: ${bare}`,
    );
    for (const local of ["'self'", 'data:', 'blob:']) {
      assert(bareSources.has(local), `img-src dropped ${local}: ${bare}`);
    }

    // Manifest network: permissions widen img-src — a provider whose
    // artwork lives on its declared API host stays renderable.
    mkdirSync(join(dir, 'plugins'));
    writeFileSync(
      join(dir, 'plugins', 'deezer.manifest.json'),
      JSON.stringify({
        abi: '0.1.0',
        capabilities: ['catalog.search'],
        id: 'deezer',
        permissions: ['network:api.deezer.com'],
        version: '0.1.2',
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'plugins', 'youtube-music.manifest.json'),
      JSON.stringify({
        abi: '0.1.0',
        capabilities: ['playback.resolve'],
        id: 'youtube-music',
        permissions: [
          'network:music.youtube.com',
          'network:*.googlevideo.com',
          'pot-provider',
          'kv',
        ],
        version: '0.4.10',
      }),
      'utf8',
    );
    // A malformed manifest is skipped, not fatal.
    writeFileSync(join(dir, 'plugins', 'broken.manifest.json'), '{nope', 'utf8');
    const pluginDir = join(dir, 'plugins');
    const widened = imgSrcSources(pluginDir);
    // img-src is a space-separated source list — membership means the
    // whole token, not a substring inside some longer host.
    const widenedSources = new Set(widened.split(' '));
    assert(
      widenedSources.has('https://api.deezer.com'),
      `network: grant did not widen img-src: ${widened}`,
    );
    assert(
      widenedSources.has('https://music.youtube.com'),
      `network: grant did not widen img-src: ${widened}`,
    );
    // network:*.h grants the wildcard AND the bare apex — CSP `*.h`
    // alone never matches the apex.
    assert(
      widenedSources.has('https://*.googlevideo.com') &&
        widenedSources.has('https://googlevideo.com'),
      `wildcard network: grant lost its apex: ${widened}`,
    );
    // Non-origin permissions contribute nothing — every token must be
    // a real CSP source expression.
    for (const token of widenedSources) {
      assert(
        /^('self'|data:|blob:|https:\/\/\S+)$/.test(token),
        `capability name leaked into img-src: ${token}`,
      );
    }

    // rewriteCsp swaps only the img-src directive — every other
    // directive in the meta survives byte-for-byte.
    const rewritten = rewriteCsp(DOC, widened);
    const before = cspContent(DOC);
    const after = cspContent(rewritten);
    assert(after !== before, 'rewrite left img-src untouched');
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "media-src 'self' http://127.0.0.1:* blob: file:",
      "connect-src 'self' http://127.0.0.1:*",
    ]) {
      assert(
        after.includes(directive),
        `rewrite dropped a directive: ${directive}`,
      );
    }
    assert(
      !/img-src [^;]*https:( |;)/.test(`${after};`),
      `rewrite kept a blanket https: image source: ${after}`,
    );
    assert(
      after.includes(`img-src ${widened}`),
      `rewrite did not install the enumerated sources: ${after}`,
    );

    // No CSP meta → document passes through unchanged; never strip or
    // invent a policy.
    const noCspDoc = '<html><head></head><body></body></html>';
    assertEqual(rewriteCsp(noCspDoc, widened), noCspDoc);
    // A meta without img-src stays byte-identical too.
    const noImg = DOC.replace(
      /img-src 'self' https: data: blob:; /,
      '',
    );
    assertEqual(rewriteCsp(noImg, widened), noImg);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
