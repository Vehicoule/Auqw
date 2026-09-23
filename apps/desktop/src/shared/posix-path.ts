// Browser-side POSIX implementations of the `node:url`/`node:path`
// members `shared/local-paths.ts` uses — the renderer bundle has no
// Node builtins, so esbuild.config.mjs aliases 'node:url' and
// 'node:path' here for that bundle only (the utility bundle keeps the
// real builtins). URI math is POSIX-shaped in both worlds: treeUris
// are RFC 8089 `file:` URLs whose paths are '/'-joined regardless of
// host OS, and every consumer on the renderer side does pure string
// math — no fs access — so the POSIX semantics are exact, not an
// approximation.
const FILE_PREFIX = 'file://';

export function fileURLToPath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:') {
    throw new Error('not a file URL');
  }
  if (url.hostname !== '' && url.hostname !== 'localhost') {
    throw new Error('file URL host must be empty');
  }
  return decodeURIComponent(url.pathname);
}

export function pathToFileURL(absPath: string): { href: string } {
  const encoded = absPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return new URL(`${FILE_PREFIX}${encoded}`);
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

export function join(...segs: readonly string[]): string {
  return normalize(segs.filter((s) => s !== '').join('/'));
}

export const sep = '/';

function normalize(p: string): string {
  const absolute = p.startsWith('/');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

export function relative(from: string, to: string): string {
  const fromParts = normalize(from).split('/').filter(Boolean);
  const toParts = normalize(to).split('/').filter(Boolean);
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i] === toParts[i]
  ) {
    i++;
  }
  const ups = fromParts.length - i;
  return [...new Array(ups).fill('..'), ...toParts.slice(i)].join('/');
}
