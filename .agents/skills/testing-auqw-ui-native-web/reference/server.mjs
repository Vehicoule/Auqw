// Web-harness server for the Auqw expo-web export.
//
// Serves apps/mobile/dist over http://localhost:8087 and a single
// range-capable media file over https://localhost:8088/media/track.wav.
// HTTPS is required: transfer-policy rejects non-https stream mints.
// CORS exposes Content-Range/Accept-Ranges/Content-Length or the fetch
// sees null headers and every chunk is rejected.
//
// Usage (from apps/mobile):
//   openssl req -x509 -newkey rsa:2048 -nodes \
//     -keyout web-harness/key.pem -out web-harness/cert.pem \
//     -days 7 -subj "/CN=localhost"
//   node web-harness/server.mjs [path/to/media.wav]
//
// MEDIA_FILE defaults to a generated 64 KiB WAV-ish blob; serve a real
// audio file for anything where bytes matter (hash finalization does
// not care about codec validity, only length).

import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', 'dist');
const CERT = join(HERE, 'cert.pem');
const KEY = join(HERE, 'key.pem');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

// A minimal valid WAV header + 64 KiB of PCM silence — enough bytes for
// ranged transfer-policy runs; hash correctness is checked anyway.
function defaultMedia() {
  const data = Buffer.alloc(64 * 1024);
  const hdr = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x01, 0x00, 0x57, 0x41, 0x56,
    0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x02,
    0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x01, 0x00,
  ]);
  hdr.copy(data, 0);
  return data;
}

const mediaPath = process.argv[2];
const media =
  mediaPath !== undefined && existsSync(mediaPath)
    ? readFileSync(mediaPath)
    : defaultMedia();

// ---- http :8087 — static dist/ + media-meta ----
httpServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // The fake host reads the served byte count from here — a custom
  // media file (argv[2]) keeps resolve/Content-Range consistent.
  if (url.pathname === '/media-meta.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ bytes: media.length }));
    return;
  }
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  // Containment: a crafted path must not escape DIST.
  const file = resolve(DIST, `.${path}`);
  const served =
    file.startsWith(DIST + '/') && existsSync(file) && statSync(file).isFile()
      ? file
      : join(DIST, 'index.html'); // SPA fallback
  res.setHeader('Content-Type', MIME[extname(served)] ?? 'application/octet-stream');
  res.end(readFileSync(served));
}).listen(8087, '127.0.0.1', () =>
  console.log('dist on http://localhost:8087'),
);

// ---- https :8088 — range media endpoint ----
if (!existsSync(CERT) || !existsSync(KEY)) {
  console.error('generate web-harness/{cert,key}.pem first — see header');
  process.exit(1);
}
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
  // Without the expose headers, fetch() reads Content-Range as null and
  // transfer-policy rejects every chunk.
  'Access-Control-Expose-Headers':
    'Content-Range, Accept-Ranges, Content-Length',
  'Accept-Ranges': 'bytes',
};
httpsServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (!req.url?.startsWith('/media/')) {
    res.writeHead(404, cors);
    return res.end();
  }
  const total = media.length;
  const range = req.headers.range; // "bytes=a-b"
  const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
  if (m) {
    const a = Number(m[1]);
    const b = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    if (a > b || a >= total) {
      res.writeHead(416, cors);
      return res.end();
    }
    const chunk = media.subarray(a, b + 1);
    res.writeHead(206, {
      ...cors,
      'Content-Range': `bytes ${a}-${b}/${total}`,
      'Content-Length': chunk.length,
      'Content-Type': 'audio/wav',
    });
    return res.end(chunk);
  }
  res.writeHead(200, {
    ...cors,
    'Content-Length': total,
    'Content-Type': 'audio/wav',
  });
  res.end(media);
}).listen(8088, '127.0.0.1', () =>
  console.log(`media on https://localhost:8088/media/track.wav (${media.length} bytes)`),
);
