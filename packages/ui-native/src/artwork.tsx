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
 * The uri an artwork image should render: the remote url immediately,
 * swapped for the cache-local file once the resolver lands. Without
 * a provider (or for non-cacheable urls) the remote url is used
 * throughout. The in-flight lookup is cancelled when the url changes
 * or the component unmounts; `resetResolved` lets the render path
 * drop back to remote when a cached file turns out unreadable (the
 * cache dir is OS-reclaimable, so an entry can outlive its file).
 */
export function useResolvedArtworkUri(url: string | null): {
  readonly uri: string | null;
  readonly resetResolved: () => void;
} {
  const resolve = useArtworkResolver();
  // Tag the resolution with the url it was made for — a late landing
  // from a superseded url is ignored without a state reset effect.
  const [resolved, setResolved] = useState<{
    readonly url: string;
    readonly uri: string;
  } | null>(null);
  useEffect(() => {
    if (resolve === null || url === null || !url.startsWith('https://')) {
      return;
    }
    const source = new CancellationSource();
    void resolve(url, source.signal)
      .then((fileUri) => {
        if (fileUri !== null && !source.signal.cancelled) {
          setResolved({ url, uri: fileUri });
        }
      })
      .catch(() => {
        // A resolver breach resolves to nothing — remote renders.
      });
    return () => source.cancel();
  }, [url, resolve]);
  return {
    uri: resolved !== null && resolved.url === url ? resolved.uri : url,
    resetResolved: () => setResolved(null),
  };
}
