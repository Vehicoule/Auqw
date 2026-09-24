import { Directory, File, FileMode, Paths } from 'expo-file-system';
import {
  appError,
  createArtworkCache,
  err,
  ok,
} from '@auqw/application';
import type {
  AppError,
  ArtworkCache,
  ArtworkFetchPort,
  ArtworkPathsPort,
  CancellationSignal,
  ClockPort,
  IdPort,
  LogPort,
  Result,
  StoragePort,
} from '@auqw/application';

/**
 * expo-file-system backing for the bounded artwork cache. The cache
 * directory lives under `Paths.cache` so the OS can reclaim it under
 * pressure; the persisted `artworkCache` section stays authoritative
 * for what the app believes is on disk — a reaped file just scores a
 * miss on the next `get` and is re-downloaded.
 *
 * `download` is atomic per the module contract: bytes land in a temp
 * sibling file first and only `move` into place on success, so a
 * failed or cancelled transfer never leaves a partial file at the
 * entry's path. Cancellation is bridged through the request's
 * AbortController; a cancelled download deletes its temp file.
 */

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** FNV-1a over UTF-8 — deterministic, no deps. Two lanes (forward
 *  and reversed read) keep same-url-always-same-path collision-safe
 *  enough that a 200 MB cache never collides in practice; the url
 *  stays in the entry row, so a file is never ambiguous about its
 *  origin. */
function artworkKey(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h1 = Math.imul(h1 ^ url.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ url.charCodeAt(url.length - 1 - i), 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 300_000);
  }
  return undefined;
}

function statusError(status: number, headers: Headers): AppError {
  if (status === 429) {
    const retryMs = retryAfterMs(headers);
    const base = appError('rate-limit', `artwork http ${status}`);
    return retryMs === undefined ? base : { ...base, retryAfterMs: retryMs };
  }
  if (status >= 500) {
    return appError('transient', `artwork http ${status}`);
  }
  return appError('unavailable', `artwork http ${status}`);
}

function thrownName(thrown: unknown): string {
  return thrown instanceof Error ? thrown.name : 'unknown';
}

export type ExpoArtworkDeps = {
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly log: LogPort;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `<Paths.cache>/artwork`. */
  readonly directory?: Directory;
};

export function createExpoArtwork(
  deps: ExpoArtworkDeps,
): { cache: ArtworkCache; dir: string } {
  const directory = deps.directory ?? new Directory(Paths.cache, 'artwork');
  const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));

  const paths: ArtworkPathsPort = {
    dir: directory.uri,
    destFor(url: string): string {
      return `${directory.uri}/${artworkKey(url)}.img`;
    },
    async exists(
      filePath: string,
      signal: CancellationSignal,
    ): Promise<Result<boolean>> {
      if (signal.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      try {
        return ok(new File(filePath).exists);
      } catch (thrown) {
        return err(
          appError('internal', `artwork stat failed: ${thrownName(thrown)}`),
        );
      }
    },
    async remove(
      filePath: string,
      signal: CancellationSignal,
    ): Promise<Result<void>> {
      if (signal.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      try {
        const file = new File(filePath);
        if (file.exists) {
          file.delete();
        }
        return ok(undefined);
      } catch (thrown) {
        return err(
          appError('internal', `artwork remove failed: ${thrownName(thrown)}`),
        );
      }
    },
  };

  const fetchPort: ArtworkFetchPort = {
    async download(url, destPath, signal) {
      if (signal.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), DEFAULT_TIMEOUT_MS);
      const unsub = signal.subscribe(() => abort.abort());
      const temp = new File(`${destPath}.dl`);
      try {
        const response = await fetchImpl(url, { signal: abort.signal });
        if (!response.ok) {
          return err(statusError(response.status, response.headers));
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('image/')) {
          return err(
            appError('invalid-response', 'artwork response is not an image'),
          );
        }
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.byteLength === 0 || body.byteLength > IMAGE_MAX_BYTES) {
          return err(
            appError('invalid-response', 'artwork body empty or oversized'),
          );
        }
        if (signal.cancelled) {
          return err(appError('cancelled', 'cancelled'));
        }
        if (temp.exists) {
          temp.delete();
        }
        // `File.create` throws when the parent is missing — the
        // artwork dir is OS-reclaimable, so intermediates rebuild it
        // on every write rather than only at session init.
        temp.create({ intermediates: true });
        const handle = temp.open(FileMode.WriteOnly);
        try {
          handle.writeBytes(body);
        } finally {
          handle.close();
        }
        const dest = new File(destPath);
        // The finalize stays synchronous end to end: an awaited-free
        // `move` let a racing download for the same entry consume the
        // shared `.dl` temp first and escaped as an uncaught promise
        // rejection. One JS turn keeps create→write→move atomic, and
        // `overwrite` removes the delete-then-move gap at the entry
        // path — the winning write replaces the file in place.
        temp.moveSync(dest, { overwrite: true });
        return ok({ bytes: body.byteLength });
      } catch (thrown) {
        if (
          signal.cancelled ||
          (thrown instanceof Error && thrown.name === 'AbortError')
        ) {
          return err(
            signal.cancelled
              ? appError('cancelled', 'cancelled')
              : appError('timeout', 'artwork download timed out'),
          );
        }
        return err(appError('transient', 'artwork download failed'));
      } finally {
        clearTimeout(timer);
        unsub();
        try {
          if (temp.exists) {
            temp.delete();
          }
        } catch {
          // A lingering temp file is reclaimed with the OS cache dir.
        }
      }
    },
  };

  const cache = createArtworkCache({
    storage: deps.storage,
    clock: deps.clock,
    ids: deps.ids,
    log: deps.log,
    fetch: fetchPort,
    paths,
  });
  return { cache, dir: directory.uri };
}
