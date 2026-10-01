// Simulated GitHub releases feed for the desktop update flow.
// Self-signed HTTPS — launch the app with --ignore-certificate-errors.
// Env knobs: FEED_PORT (default 4477), FEED_BPS (artifact bytes/sec,
// default 600000), FEED_PAD (artifact pad bytes, default ~4MB).
import { createServer } from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.FEED_PORT ?? 4477);
const BPS = Number(process.env.FEED_BPS ?? 600_000);
const PAD = Number(process.env.FEED_PAD ?? 4 * 1024 * 1024);
const DIR = new URL('.', import.meta.url).pathname;
const ARTIFACT_NAME = 'auqw-9.9.9-linux-x86_64.AppImage';
const ARTIFACT_PATH = `${DIR}appimage/${ARTIFACT_NAME}`;
const FLATPAK_NAME = 'auqw-9.9.9-linux-x86_64.flatpak';

const onDisk = readFileSync(ARTIFACT_PATH);
// A run of '#'s after the trailing newline is still a valid shell comment;
// sha256 rides the served bytes, so padding here just throttles the download.
const artifact =
  onDisk.length >= PAD
    ? onDisk
    : Buffer.concat([onDisk, Buffer.alloc(PAD - onDisk.length, '#')]);
const artifactSha = createHash('sha256').update(artifact).digest('hex');
const checksums = `${artifactSha}  ${ARTIFACT_NAME}\n`;

function releases() {
  return JSON.stringify([
    {
      tag_name: 'v9.9.9',
      name: 'v9.9.9',
      html_url: 'https://github.com/Vehicoule/Auqw/releases/tag/v9.9.9',
      assets: [
        {
          name: ARTIFACT_NAME,
          browser_download_url: `https://127.0.0.1:${PORT}/${ARTIFACT_NAME}`,
          size: artifact.length,
        },
        {
          name: 'SHA256SUMS-Linux.txt',
          browser_download_url: `https://127.0.0.1:${PORT}/SHA256SUMS-Linux.txt`,
          size: checksums.length,
        },
        {
          name: FLATPAK_NAME,
          browser_download_url: `https://127.0.0.1:${PORT}/${FLATPAK_NAME}`,
          size: 1024,
        },
      ],
    },
  ]);
}

function streamThrottled(res, buf) {
  const chunk = Math.max(1024, Math.floor(BPS / 10));
  let off = 0;
  const timer = setInterval(() => {
    if (off >= buf.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    const end = Math.min(off + chunk, buf.length);
    res.write(buf.subarray(off, end));
    off = end;
  }, 100);
  res.on('close', () => clearInterval(timer));
}

createServer(
  { key: readFileSync(`${DIR}key.pem`), cert: readFileSync(`${DIR}cert.pem`) },
  (req, res) => {
    const url = req.url ?? '/';
    console.log(`feed GET ${url}`);
    if (url === '/releases') {
      const body = releases();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (url === '/SHA256SUMS-Linux.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(checksums);
      return;
    }
    if (url === `/${ARTIFACT_NAME}`) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': artifact.length,
      });
      streamThrottled(res, artifact);
      return;
    }
    if (url === `/${FLATPAK_NAME}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('flatpak stub');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  },
).listen(PORT, '127.0.0.1', () => {
  console.log(
    `feed listening https://127.0.0.1:${PORT} — artifact ${statSync(ARTIFACT_PATH).size}B @ ${BPS}B/s, sha256 ${artifactSha.slice(0, 12)}…`,
  );
});
