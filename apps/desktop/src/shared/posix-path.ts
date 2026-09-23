// Browser-side implementations of the `node:url`/`node:path` members
// `shared/local-paths.ts` uses — the renderer bundle has no Node
// builtins, so esbuild.config.mjs aliases 'node:url' and 'node:path'
// here for that bundle only (the utility bundle keeps the real
// builtins). URI math is host-shaped in both worlds: treeUris are
// RFC 8089 `file:` URLs whose paths are '/'-joined regardless of host
// OS, and every consumer on the renderer side does pure string math —
// no fs access — so the semantics are exact, not an approximation.
// Windows forms follow RFC 8089 too: a `/C:/x` pathname decodes to
// `C:/x`, a `file://host/share` URI decodes to the UNC root
// `//host/share`, and re-encoding reproduces the original URI.
const FILE_PREFIX = 'file://';
const WINDOWS_DRIVE = /^[A-Za-z]:$/;

export function fileURLToPath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:') {
    throw new Error('not a file URL');
  }
  const path = decodeURIComponent(url.pathname);
  if (url.hostname !== '' && url.hostname !== 'localhost') {
    // `file://host/share` — a UNC grant; keep the host as root.
    return `//${url.hostname}${path}`;
  }
  if (
    path.length > 3 &&
    path[0] === '/' &&
    WINDOWS_DRIVE.test(path.slice(1, 3)) &&
    path[3] === '/'
  ) {
    return path.slice(1);
  }
  return path;
}

export function pathToFileURL(absPath: string): { href: string } {
  const encodeTail = (p: string): string =>
    p
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  if (absPath.startsWith('//')) {
    // UNC root `//host/share` — the host rides as the URL hostname,
    // unencoded like the drive colon below.
    const rest = absPath.slice(2);
    const slash = rest.indexOf('/');
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? '' : rest.slice(slash);
    return new URL(`${FILE_PREFIX}${host}${encodeTail(tail)}`);
  }
  // A drive-qualified path keeps its colon literal — `C:/x` →
  // `file:///C:/x`, never `C%3A`.
  const drive =
    absPath.length > 2 &&
    WINDOWS_DRIVE.test(absPath.slice(0, 2)) &&
    absPath[2] === '/';
  const encoded = absPath
    .split('/')
    .map((seg, i) => (i === 0 && drive ? seg : encodeURIComponent(seg)))
    .join('/');
  return new URL(
    `${FILE_PREFIX}${encoded.startsWith('/') ? '' : '/'}${encoded}`,
  );
}

export function isAbsolute(p: string): boolean {
  return (
    p.startsWith('/') || // POSIX root and the `//host` UNC root
    /^[A-Za-z]:[\\/]/.test(p) // drive-qualified (`C:/x` or `C:\x`)
  );
}

export function join(...segs: readonly string[]): string {
  return normalize(segs.filter((s) => s !== '').join('/'));
}

export const sep = '/';

function normalize(p: string): string {
  const absolute = isAbsolute(p);
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
  const joined = parts.join('/');
  // `C:/x` normalizes to `C:x` in parts — restore the drive's own
  // root so `join` never demotes a grant path to drive-relative.
  if (absolute && parts.length > 0 && WINDOWS_DRIVE.test(parts[0] ?? '')) {
    return `${parts[0]}/${parts.slice(1).join('/')}`;
  }
  // `//host/...` keeps its UNC root — a single-slash result would
  // silently re-root the grant at the local filesystem.
  if (p.startsWith('//')) {
    return `//${joined}`;
  }
  return (absolute ? '/' : '') + joined;
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
