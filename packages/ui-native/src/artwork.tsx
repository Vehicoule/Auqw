import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CancellationSource } from '@auqw/application';
import type { CancellationSignal } from '@auqw/application';
import { scaledArtworkUrl } from '@auqw/ui-shared';

/**
 * Resolves a remote artwork url to a cache-local file uri through the
 * session's bounded LRU cache (docs/specs/data.md: ~200 MB, managed
 * in settings). Returns null when the lookup can't produce a file —
 * the caller then renders the remote url rather than nothing.
 */
export type ArtworkResolver = (
  url: string,
  signal: CancellationSignal,
) => Promise<string | null>;

const ArtworkResolverContext = createContext<ArtworkResolver | null>(null);

export type ArtworkResolverProviderProps = {
  readonly resolve: ArtworkResolver;
  readonly children: ReactNode;
};

export function ArtworkResolverProvider({
  resolve,
  children,
}: ArtworkResolverProviderProps) {
  return (
    <ArtworkResolverContext.Provider value={resolve}>
      {children}
    </ArtworkResolverContext.Provider>
  );
}

function useArtworkResolver(): ArtworkResolver | null {
  return useContext(ArtworkResolverContext);
}

/**
 * Session-lifetime answers from the resolver, keyed by url. A row
 * remounting after list virtualization would otherwise paint its
 * placeholder for at least a frame while the already-answered
 * lookup repeats; seeding `uri` from the memo restores the image on
 * the first paint. Bounded; a cached file that turns out unreadable
 * drops its memo entry via `markSourceError` so the next mount
 * resolves afresh rather than trusting a path the OS may have
 * reclaimed.
 */
const RESOLVED_MEMO_MAX = 512;
const resolvedUriMemo = new Map<string, string>();

/** LRU-ish insert: overwrite refreshes recency, bound evicts oldest. */
function memoizeUri(url: string, uri: string): void {
  resolvedUriMemo.delete(url);
  resolvedUriMemo.set(url, uri);
  while (resolvedUriMemo.size > RESOLVED_MEMO_MAX) {
    const oldest = resolvedUriMemo.keys().next();
    if (oldest.done) {
      break;
    }
    resolvedUriMemo.delete(oldest.value);
  }
}

/**
 * What an artwork image should render. `pending` is true while the
 * resolver is looking up a cacheable url with nothing memoized to
 * paint meanwhile — the render path shows its placeholder then,
 * never the remote url: giving `Image` the remote source up front
 * would double-fetch every cache miss (one request from the
 * component, one from the cache's own downloader). On a hit the
 * file uri lands quickly; a url the memo already answered paints
 * its file immediately; on a miss or failure `uri` falls back to
 * the remote url as exactly one source.
 *
 * `markSourceError` is the painted source's error handler. When the
 * lookup for `url` is still in flight — a stale memo painted a file
 * the OS already reclaimed — it drops the memo and falls back to
 * the placeholder while the resolver's own download continues,
 * rather than also loading the remote url concurrently. Once the
 * lookup has answered, an unreadable file means the answer itself
 * is bad: the memo is dropped and `uri` falls back to remote.
 */
export function useResolvedArtworkUri(
  url: string | null,
  targetPx?: number | undefined,
): {
  readonly uri: string | null;
  readonly pending: boolean;
  readonly markSourceError: () => void;
} {
  const resolve = useArtworkResolver();
  // The scaled variant that failed to paint — a scaled request the
  // CDN can't serve retries at the provider's original size, the same
  // retry the web <img> onError path makes. The latch lifts once the
  // original's own lookup lands a file, so one transient scaled-URL
  // failure doesn't pin every later paint to the full-size asset for
  // the rest of the mount.
  const [scaledFailed, setScaledFailed] = useState<string | null>(null);
  // The url whose scaled re-attempt was already granted — a second
  // scaled failure keeps the latch instead of bouncing between
  // variants forever.
  const [retriedFor, setRetriedFor] = useState<string | null>(null);
  const scaled =
    url !== null && targetPx !== undefined
      ? scaledArtworkUrl(url, targetPx)
      : url;
  const requested = scaled === scaledFailed ? url : scaled;
  // Tag the outcome with the url it was made for — a late landing
  // from a superseded url is ignored without a state reset effect.
  const [outcome, setOutcome] = useState<{
    readonly url: string;
    /** Cache-local uri, or null when the lookup produced no file. */
    readonly uri: string | null;
  } | null>(null);
  const cacheable =
    resolve !== null && requested !== null && requested.startsWith('https://');
  const memoized =
    requested !== null ? resolvedUriMemo.get(requested) : undefined;
  /**
   * A url whose painted source errored while its lookup was still
   * in flight: the memo answered with a file the OS reclaimed. The
   * placeholder holds the spot until the resolver's verdict lands —
   * its fresh file, or the remote url on a null.
   */
  const [broken, setBroken] = useState<string | null>(null);
  const resolving =
    cacheable && (outcome === null || outcome.url !== requested);
  const painted = broken === requested ? undefined : memoized;
  useEffect(() => {
    if (!cacheable || requested === null) {
      return;
    }
    const source = new CancellationSource();
    void resolve(requested, source.signal)
      .then((fileUri) => {
        // A live answer refreshes the memo; an empty one clears it —
        // null means the cache holds nothing, so a stale memo entry
        // would only keep painting a path that no longer resolves.
        if (fileUri !== null) {
          memoizeUri(requested, fileUri);
        } else {
          resolvedUriMemo.delete(requested);
        }
        // The original landing a file while a scaled variant sat
        // latched proves the fallback servable — the variant gets its
        // one re-attempt. Guarded by the variant itself: a latch set
        // for a different shape since isn't this one's to lift. A url
        // whose re-attempt already ran keeps its latch — the next
        // failure is the re-attempt's, not a fresh transient.
        if (fileUri !== null && scaled === scaledFailed && retriedFor !== url) {
          setScaledFailed((cur) => (cur === scaled ? null : cur));
          setRetriedFor(url);
        }
        // The verdict is in: a `broken` marker for this url is stale —
        // leaving it would suppress the refreshed memo on the next
        // revisit and paint a placeholder over a cache-ready file.
        setBroken((b) => (b === requested ? null : b));
        setOutcome({ url: requested, uri: fileUri });
      })
      .catch(() => {
        setBroken((b) => (b === requested ? null : b));
        setOutcome({ url: requested, uri: null });
      });
    return () => source.cancel();
  }, [requested, resolve, cacheable]);
  return {
    uri:
      outcome !== null && outcome.url === requested
        ? (outcome.uri ?? requested)
        : (painted ?? requested),
    pending: resolving && painted === undefined,
    markSourceError: () => {
      if (requested === null) {
        return;
      }
      // What the Image actually painted: the resolver's file when the
      // verdict (or memo) produced one, the remote request otherwise.
      const shown =
        outcome !== null && outcome.url === requested
          ? (outcome.uri ?? requested)
          : (painted ?? requested);
      // Only a failed remote source retries at the provider's original
      // size — the same retry the web <img> onError path makes. A
      // failed cache file is a different fault: the memo answered a
      // path the OS reclaimed, the scaled lookup in flight (or the
      // fresh one the memo drop triggers) is already retrying at the
      // same small size, and switching to the original here would pay
      // a full-size download for a cache fault.
      if (url !== null && shown === requested && requested !== url) {
        setScaledFailed(requested);
        return;
      }
      resolvedUriMemo.delete(requested);
      if (resolving) {
        setBroken(requested);
      } else {
        setOutcome({ url: requested, uri: null });
      }
    },
  };
}
