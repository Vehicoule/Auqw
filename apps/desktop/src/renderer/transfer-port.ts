import type {
  CancellationSignal,
  MediaTransferPort,
  Result,
  TransferSink,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';
import type { AuqwApi } from '../shared/contract.ts';
import { shellToAppError } from './ipc-errors.ts';

/**
 * `MediaTransferPort` over the `transfer:*` IPC surface — the desktop
 * half of the download file plane. The engine (`DownloadManager` +
 * `runTransfer`) drives fetch/Range/policy renderer-side; this adapter
 * is the sink plumbing underneath it: begin → write* → commit/finalize
 * with the utility owning `.part` staging and the atomic rename.
 *
 * Cancellation is observed: the signal is polled before each call,
 * a sink cancelled mid-`begin` is aborted as soon as it lands, and a
 * live sink subscribes so a cancel aborts it utility-side even while
 * the engine isn't driving a call.
 */
export function createDesktopTransfer(api: AuqwApi): MediaTransferPort {
  const ifCancelled = (signal: CancellationSignal): Result<never> | null =>
    signal.cancelled ? err(appError('cancelled', 'cancelled')) : null;

  class DesktopSink implements TransferSink {
    #id: string;
    #closed = false;

    constructor(id: string, signal: CancellationSignal) {
      this.#id = id;
      // A cancel while the sink is live aborts the utility side —
      // the engine may not issue another call for the signal to ride.
      const unsubscribe = signal.subscribe(() => {
        unsubscribe();
        this.#closed = true;
        void api.transfer
          .abort({ sinkId: this.#id, keep: true })
          .catch(() => undefined);
      });
      if (this.#closed) {
        unsubscribe();
      }
    }

    async write(bytes: Uint8Array): Promise<Result<void>> {
      if (this.#closed) {
        return err(appError('released', 'sink is closed'));
      }
      try {
        // Bytes cross as base64 — `transfer:write` caps the frame at
        // 4MiB decoded; larger writes split at the seam.
        for (let off = 0; off < bytes.length; off += WRITE_CHUNK) {
          const chunk = bytes.subarray(
            off,
            Math.min(off + WRITE_CHUNK, bytes.length),
          );
          await api.transfer.write({
            sinkId: this.#id,
            data: toBase64(chunk),
          });
        }
        return ok(undefined);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    }

    async commit(): Promise<Result<number>> {
      try {
        const result = await api.transfer.commit({ sinkId: this.#id });
        return ok(result.offset);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    }

    async finalize(expected: string | null): Promise<Result<string>> {
      try {
        const result = await api.transfer.finalize({
          sinkId: this.#id,
          expected,
        });
        this.#closed = true;
        return ok(result.digest);
      } catch (thrown) {
        this.#closed = true;
        return err(shellToAppError(thrown));
      }
    }

    async abort(keep: boolean): Promise<Result<void>> {
      try {
        await api.transfer.abort({ sinkId: this.#id, keep });
        this.#closed = true;
        return ok(undefined);
      } catch (thrown) {
        this.#closed = true;
        return err(shellToAppError(thrown));
      }
    }
  }

  function makeSink(
    sinkId: string,
    signal: CancellationSignal,
  ): TransferSink {
    return new DesktopSink(sinkId, signal);
  }

  return {
    async ensureDir(signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        await api.transfer.ensureDir();
        return ok(undefined);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    async begin(input, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const { sinkId } = await api.transfer.begin({
          destPath: input.destPath,
          resumeAtBytes: input.resumeAtBytes,
        });
        if (signal.cancelled) {
          // Cancellation landed mid-begin (e.g. behind the sink cap):
          // release the just-minted sink so nothing writes through it.
          await api.transfer
            .abort({ sinkId, keep: false })
            .catch(() => undefined);
          return err(appError('cancelled', 'cancelled'));
        }
        return ok(makeSink(sinkId, signal));
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    async sweepPartials(keepPaths, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const { swept } = await api.transfer.sweepPartials({ keepPaths });
        return ok(swept);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    async usage(signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const stats = await api.transfer.stats();
        return ok(stats.bytes);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    async freeBytes(signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const stats = await api.transfer.stats();
        return stats.freeBytes === null
          ? err(appError('unavailable', 'free-bytes probe failed'))
          : ok(stats.freeBytes);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    async removeFile(name, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        await api.transfer.remove({ name });
        return ok(undefined);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },

    async stat(name, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      try {
        const result = await api.transfer.stat({ name });
        return ok(result);
      } catch (thrown) {
        return err(shellToAppError(thrown));
      }
    },
  };
}

/** `transfer:write` accepts ≤4MiB decoded per frame. */
const WRITE_CHUNK = 4 * 1024 * 1024;

/**
 * Renderer-side base64 for sink bytes — `btoa` handles the narrow
 * range per call so chunk size stays the working bound.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
