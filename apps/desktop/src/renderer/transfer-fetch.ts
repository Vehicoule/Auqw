import { DownloadFailure } from '@auqw/application';
import type {
  CancellationSignal,
  IdPort,
  RangeFetch,
} from '@auqw/application';
import type { AuqwApi } from '../shared/contract.ts';
import { isShellError } from '../shared/errors.ts';

/**
 * `RangeFetch` over the `transfer:fetch*` channels — the desktop
 * download wire leg. The renderer can't fetch minted https urls
 * itself: the CSP's `connect-src` allows only the loopback pump, and
 * a forbidden `User-Agent` is dropped by browser fetch anyway. The
 * utility's Node fetch sends the minted headers verbatim; this
 * adapter only bridges the policy's `CancellationSignal` onto
 * `fetchAbort` and maps envelope kinds back onto the policy's
 * DownloadFailure vocabulary (retryable → `transient`, abort →
 * `cancelled`, everything else → `invalid-response`).
 */
export function createTransferFetch(
  api: Pick<AuqwApi['transfer'], 'fetch' | 'fetchBody' | 'fetchAbort'>,
  ids: IdPort,
): RangeFetch {
  /** Signal → 'cancelled'; shell kinds → the policy vocabulary. */
  const mapWireError = (signal: CancellationSignal, thrown: unknown): never => {
    // A cancelled download surfaces as 'cancelled' no matter which
    // leg the abort raced — even a consumed-entry 'invalid-request'
    // is just the cancel winning the race against `fetchBody`.
    if (signal.cancelled) {
      throw new DownloadFailure('cancelled', 'cancelled');
    }
    if (isShellError(thrown)) {
      if (thrown.kind === 'cancelled') {
        // No cancel behind this shell abort — the utility's backstop
        // or a stall cut the request; that's a transient, not a
        // user-visible cancel.
        throw new DownloadFailure('transient', 'fetch aborted mid-request');
      }
      if (thrown.retryable) {
        throw new DownloadFailure(
          'transient',
          `wire fetch failed: ${thrown.kind}`,
        );
      }
      throw new DownloadFailure(
        'invalid-response',
        `wire fetch failed: ${thrown.kind}`,
      );
    }
    throw thrown;
  };

  return async (url, init, signal) => {
    const requestId = ids.next('fetch');
    const unsubscribe = signal.subscribe(() => {
      void api.fetchAbort({ requestId }).catch(() => undefined);
    });
    try {
      if (signal.cancelled) {
        throw new DownloadFailure('cancelled', 'cancelled');
      }
      const head = await api.fetch({ requestId, url, headers: init.headers });
      if (signal.cancelled) {
        // The abort raced a completed head — don't hand the policy a
        // live response for a cancelled download.
        throw new DownloadFailure('cancelled', 'cancelled');
      }
      // The policy only ever buffers a 206 body — anything else is
      // status + headers for a re-mint verdict, so release the parked
      // response now instead of holding its socket to the backstop.
      const released = head.status !== 206;
      if (released) {
        void api.fetchAbort({ requestId }).catch(() => undefined);
        // No body read is coming — the abort bridge is dead weight.
        unsubscribe();
      }
      const headers = new Map(
        head.headers.map(([name, value]) => [name.toLowerCase(), value]),
      );
      return {
        status: head.status,
        headers: {
          get: (name: string) => headers.get(name.toLowerCase()) ?? null,
        },
        arrayBuffer: async () => {
          if (released) {
            throw new DownloadFailure(
              'invalid-response',
              'non-206 response body was released',
            );
          }
          try {
            if (signal.cancelled) {
              throw new DownloadFailure('cancelled', 'cancelled');
            }
            const body = await api.fetchBody({ requestId });
            if (signal.cancelled) {
              throw new DownloadFailure('cancelled', 'cancelled');
            }
            const binary = atob(body.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
              bytes[i] = binary.charCodeAt(i);
            }
            return bytes.buffer as ArrayBuffer;
          } catch (thrown) {
            return mapWireError(signal, thrown);
          } finally {
            // The subscription must outlive the headers — a body
            // stall still has to reach `fetchAbort` — so it releases
            // when the read settles, not when the head answers.
            unsubscribe();
          }
        },
      };
    } catch (thrown) {
      unsubscribe();
      return mapWireError(signal, thrown);
    }
  };
}
