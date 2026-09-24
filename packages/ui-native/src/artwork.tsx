import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CancellationSource } from '@auqw/application';
import type { CancellationSignal } from '@auqw/application';

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

export function useArtworkResolver(): ArtworkResolver | null {
  return useContext(ArtworkResolverContext);
}

/**
 * What an artwork image should render. `pending` is true while the
 * resolver is looking up a cacheable url — the render path shows its
 * placeholder then, never the remote url: giving `Image` the remote
 * source up front would double-fetch every cache miss (one request
 * from the component, one from the cache's own downloader). On a
 * hit the file uri lands quickly; on a miss or failure `uri` falls
 * back to the remote url as exactly one source. `markRemote` lets
 * the render path drop a cached file that turns out unreadable (the
 * cache dir is OS-reclaimable, so an entry can outlive its file).
 */
export function useResolvedArtworkUri(url: string | null): {
  readonly uri: string | null;
  readonly pending: boolean;
  readonly markRemote: () => void;
} {
  const resolve = useArtworkResolver();
  // Tag the outcome with the url it was made for — a late landing
  // from a superseded url is ignored without a state reset effect.
  const [outcome, setOutcome] = useState<{
    readonly url: string;
    /** Cache-local uri, or null when the lookup produced no file. */
    readonly uri: string | null;
  } | null>(null);
  const cacheable =
    resolve !== null && url !== null && url.startsWith('https://');
  useEffect(() => {
    if (!cacheable || url === null) {
      return;
    }
    const source = new CancellationSource();
    void resolve(url, source.signal)
      .then((fileUri) => setOutcome({ url, uri: fileUri }))
      .catch(() => setOutcome({ url, uri: null }));
    return () => source.cancel();
  }, [url, resolve, cacheable]);
  return {
    uri:
      outcome !== null && outcome.url === url && outcome.uri !== null
        ? outcome.uri
        : url,
    pending: cacheable && (outcome === null || outcome.url !== url),
    markRemote: () => {
      if (url !== null) {
        setOutcome({ url, uri: null });
      }
    },
  };
}
