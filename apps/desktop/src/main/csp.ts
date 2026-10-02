import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The product window's CSP meta is a static file — but `img-src 'self'
 * https:` grants the sandboxed renderer unrestricted HTTPS egress,
 * bypassing the `connect-src` lock (any fetch-shaped side channel can
 * hide in an <img> request). The directive is rewritten at serve time
 * (see the `protocol.handle('file')` site in index.ts) to enumerate
 * only:
 *
 *   - `'self'` + `data:` + `blob:` — same-scheme/local and the canvas /
 *     object-URL surfaces the current policy already relies on;
 *   - `https:` host sources for each `network:<host>` permission the
 *     installed plugin manifests declare — artwork a provider serves
 *     from a host it already declared keeps working;
 *   - the proven artwork CDN families the bundled providers return —
 *     manifests grant `network:api.deezer.com` while covers actually
 *     come from `cdn-images.dzcdn.net`, so the artwork hosts are a
 *     separate allowlist, not derived.
 *
 * A plugin manifest only ever widens img-src — it can never widen
 * connect-src or script-src, which this rewrite leaves untouched.
 */

// Artwork CDNs observed from the shipped providers (packages/ui-shared/
// src/artwork-url.ts documents the same host families):
//   *.dzcdn.net           Deezer covers (cdn-images, e-cdns-images…)
//   *.mzstatic.com        iTunes artwork up to 3000px
//   *.googleusercontent.com / *.ggpht.com  YouTube Music covers
const ARTWORK_HOSTS: readonly string[] = [
  'https://*.dzcdn.net',
  'https://*.ggpht.com',
  'https://*.googleusercontent.com',
  'https://*.mzstatic.com',
];

/** `network:host` / `network:*.host` permission entries — anything else
 * (`pot-provider`, `kv`) carries no origin. */
const NETWORK_PERMISSION = /^network:((\*\.)?[a-z0-9.-]+)$/;

const HOSTNAME = /^(\*\.)?[a-z0-9.-]+$/;

function manifestNetworkHosts(pluginDir: string): readonly string[] {
  let entries: string[];
  try {
    entries = readdirSync(pluginDir);
  } catch {
    // No plugin dir staged (dev without sync-plugins) — the artwork
    // allowlist alone still keeps the bundled providers' covers live.
    return [];
  }
  const hosts = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith('.manifest.json')) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(pluginDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const permissions = (raw as Record<string, unknown>)['permissions'];
    if (!Array.isArray(permissions)) {
      continue;
    }
    for (const permission of permissions) {
      if (typeof permission !== 'string') {
        continue;
      }
      const host = NETWORK_PERMISSION.exec(permission)?.[1];
      if (host === undefined || !HOSTNAME.test(host)) {
        continue;
      }
      if (host.startsWith('*.')) {
        // CSP `*.h` matches subdomains but not the bare apex —
        // grant both so `network:*.x` never narrows an apex hit.
        hosts.add(`https://${host.slice(2)}`);
        hosts.add(`https://${host}`);
      } else {
        hosts.add(`https://${host}`);
      }
    }
  }
  return [...hosts];
}

/**
 * The `img-src` source-expression list (no directive name) for the
 * plugin set installed under `pluginDir`. Sorted for a stable served
 * document.
 */
export function imgSrcSources(pluginDir: string): string {
  const sources = new Set<string>([
    "'self'",
    'data:',
    'blob:',
    ...ARTWORK_HOSTS,
    ...manifestNetworkHosts(pluginDir),
  ]);
  return [...sources].join(' ');
}

const CSP_META = /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/;
const CONTENT_ATTR = /content="([^"]*)"/;
const IMG_SRC = /img-src[^;]*/;

/**
 * Replaces the `img-src` directive inside the document's CSP meta
 * tag with `img-src <sources>`. Returns the document unchanged when
 * no CSP meta or no img-src directive is found — a failed rewrite
 * must never strip the rest of the policy.
 */
export function rewriteCsp(html: string, sources: string): string {
  const meta = CSP_META.exec(html);
  if (meta === null) {
    return html;
  }
  const tag = meta[0];
  const content = CONTENT_ATTR.exec(tag);
  if (content === null) {
    return html;
  }
  const policy = content[1];
  if (policy === undefined || !IMG_SRC.test(policy)) {
    return html;
  }
  const rewritten = policy.replace(IMG_SRC, `img-src ${sources}`);
  const tagWithSources = `${tag.slice(0, content.index)}content="${rewritten}"${tag.slice(content.index + content[0].length)}`;
  return `${html.slice(0, meta.index)}${tagWithSources}${html.slice(meta.index + tag.length)}`;
}
