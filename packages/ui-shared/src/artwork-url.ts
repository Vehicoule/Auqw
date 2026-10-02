/**
 * Provider artwork arrives at whatever resolution the plugin minted —
 * Deezer hands out 1000px covers, iTunes up to 3000px, YouTube Music
 * 544px — and the renderer keeps the decoded bitmap in Chromium's
 * image cache for as long as the <img> stays mounted (kept-alive
 * panes hold every visited screen's rows). A 3000px cover decodes to
 * ~34 MB for what is usually a 40px row; an afternoon of browsing
 * piles that into gigabytes of retained bitmaps.
 *
 * Every artwork CDN the app uses serves the same asset at size
 * variants addressable in the URL, so the cheapest possible fix runs
 * at the src boundary: rewrite the requested size to the smallest
 * step that still covers the rendered pixels. The fetch is unchanged
 * (img-src already permits these hosts) — only the decoded footprint
 * drops. Unknown shapes pass through untouched, and call sites fall
 * back to the original URL when a rewrite 404s.
 */

const LADDER = [64, 128, 192, 256, 384, 512, 768, 1024, 2048] as const;

/** Deezer's cover CDN serves only these exact `{n}x{n}` tails —
 * anything else 404s back to the unrewritten URL. */
const DEEZER_LADDER = [28, 56, 120, 250, 500, 1000] as const;

/** Deezer ladder only applies to real dzcdn.net hosts — a look-alike
 * suffix (`dzcdn.net.evil.tld`) or a needle in the query must not
 * pick the discrete-size ladder. */
const DEEZER_HOST = /^https:\/\/(?:[a-z0-9-]{1,63}\.){0,4}dzcdn\.net(?::\d{1,5})?\//i;

/** Google's image CDNs serve `=wN-hN`/`=sN` size params only on
 * googleusercontent/ggpht hosts — the same test the bare-append branch
 * applies. A look-alike tail on another host (a signed query value, a
 * tracking token) is opaque data, not a size knob — rewriting it
 * corrupts the URL. */
const GOOGLE_HOST = /\.googleusercontent\.com\/|ggpht\.com\//;

function pickSize(targetPx: number, ladder: readonly number[]): number {
  for (const step of ladder) {
    if (step >= targetPx) {
      return step;
    }
  }
  return ladder[ladder.length - 1] ?? 2048;
}

/**
 * Returns a same-asset URL at the smallest served size that still
 * covers `targetPx` physical pixels, or `url` itself when the shape
 * isn't a size-addressable CDN pattern. Never upscales: a source
 * smaller than the target keeps its own size (the rewrite only ever
 * shrinks the request).
 */
export function scaledArtworkUrl(url: string, targetPx: number): string {
  if (
    !url.startsWith('https://') ||
    !Number.isFinite(targetPx) ||
    targetPx <= 0
  ) {
    return url;
  }

  // googleusercontent (lh3/yt3/yt4/ggpht/gp5 — YouTube Music covers and
  // artist images): size rides a `=w544-h544-...` or `=s544` suffix;
  // any pixel value is servable.
  const googleSize = url.match(/=w(\d{1,8})-h(\d{1,8})(-\S{1,127})?$/);
  if (googleSize !== null && GOOGLE_HOST.test(url)) {
    const offered = parseInt(googleSize[1] ?? '0', 10);
    const px = Math.min(offered, pickSize(targetPx, LADDER));
    return `${url.slice(0, googleSize.index ?? 0)}=w${px}-h${px}${googleSize[3] ?? ''}`;
  }
  const googleSquare = url.match(/=s(\d{1,8})(-\S{1,127})?$/);
  if (googleSquare !== null && GOOGLE_HOST.test(url)) {
    const offered = parseInt(googleSquare[1] ?? '0', 10);
    const px = Math.min(offered, pickSize(targetPx, LADDER));
    return `${url.slice(0, googleSquare.index ?? 0)}=s${px}${googleSquare[2] ?? ''}`;
  }
  // Same infra, bare path (no `=` suffix): the CDN falls back to a
  // ~900px default — appending the size param picks the small one.
  // The last segment must be parameter-free or the append would
  // double a suffix too long for the matchers above.
  if (GOOGLE_HOST.test(url) && /\/[^/?=]{0,255}$/.test(url)) {
    const px = pickSize(targetPx, LADDER);
    return `${url}=w${px}-h${px}`;
  }

  // Square size in the path tail — Deezer
  // (`/cover/<hash>/1000x1000-000000-80-0-0.jpg`), iTunes/mzstatic
  // (`/3000x3000bb.jpg`, `/600x600.jpg`), plus generic `NNNxNNN.ext`
  // CDNs. Keep every trailing flag — only the size changes.
  const sizedTail = url.match(
    /\/(\d{2,4})x(\d{2,4})([a-z]{0,4})((?:-\d+)*)\.(jpe?g|png|webp)(\?\S*)?$/i,
  );
  // Square-only: two differing numbers can encode a crop, and a square
  // variant would silently reshape the artwork instead of shrinking it.
  if (sizedTail !== null && sizedTail[1] === sizedTail[2]) {
    const offered = parseInt(sizedTail[1] ?? '0', 10);
    const ladder = DEEZER_HOST.test(url) ? DEEZER_LADDER : LADDER;
    const px = Math.min(offered, pickSize(targetPx, ladder));
    if (px === offered) {
      return url;
    }
    const [, , , flags, deezerTail, ext, query] = sizedTail;
    return `${url.slice(0, sizedTail.index ?? 0)}/${px}x${px}${flags}${deezerTail ?? ''}.${ext}${query ?? ''}`;
  }

  return url;
}
