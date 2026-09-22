import type {
  CancellationSignal,
  MediaTransferPort,
  Result,
  TransferSink,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';
import type { AuqwApi } from '../shared/contract.ts';
import { shellToAppError } from './ipc-errors.ts';
import { raced } from './race.ts';

/**
 * `MediaTransferPort` over the `transfer:*` IPC surface — the desktop
 * half of the download file plane. The engine (`DownloadManager` +
 * `runTransfer`) drives fetch/Range/policy renderer-side; this adapter
 * is the sink plumbing underneath it: begin → write* → commit/finalize
 * with the utility owning `.part` staging and the atomic rename.
 *
 * Cancellation is observed: the signal is polled before each call,
 * every IPC call races the signal so a cancel doesn't out-wait a
 * parked utility op, a sink minted after a mid-`begin` cancel is
 * reaped, and a live sink subscribes so a cancel aborts it
 * utility-side even while the engine isn't driving a call.
 */
export function createDesktopTransfer(api: AuqwApi): MediaTransferPort {
  const ifCancelled = (signal: CancellationSignal): Result<never> | null =>
    signal.cancelled ? err(appError('cancelled', 'cancelled')) : null;

  /** Race a read-only IPC call against the caller's signal. */
  const settle = async <T>(
    call: Promise<T>,
    signal: CancellationSignal,
  ): Promise<Result<T>> => {
    const outcome = await raced(call, signal);
    if (outcome.t === 'cancelled') {
      return err(appError('cancelled', 'cancelled'));
    }
    if (outcome.t === 'failed') {
      return err(shellToAppError(outcome.thrown));
    }
    return ok(outcome.value);
  };

  class DesktopSink implements TransferSink {
    #id: string;
    #signal: CancellationSignal;
    #closed = false;
    #cancelled = false;

    constructor(id: string, signal: CancellationSignal) {
      this.#id = id;
      this.#signal = signal;
      // A cancel while the sink is live aborts the utility side —
      // the engine may not issue another call for the signal to ride.
      const unsubscribe = signal.subscribe(() => {
        unsubscribe();
        this.#cancelled = true;
        this.#closed = true;
        void api.transfer
          .abort({ sinkId: this.#id, keep: true })
          .catch(() => undefined);
      });
      if (this.#closed) {
        unsubscribe();
      }
    }

    /** The signal's own error beats the released/raw-shell shape. */
    #closedResult(): Result<never> {
      return err(
        this.#cancelled
          ? appError('cancelled', 'cancelled')
          : appError('released', 'sink is closed'),
      );
    }

    #settleError(thrown: unknown): Result<never> {
      return err(
        this.#cancelled
          ? appError('cancelled', 'cancelled')
          : shellToAppError(thrown),
      );
    }

    async write(bytes: Uint8Array): Promise<Result<void>> {
      if (this.#closed) {
        return this.#closedResult();
      }
      try {
        // Bytes cross as base64 — `transfer:write` caps the frame at
        // 4MiB decoded; larger writes split at the seam. A cancel
        // mid-loop aborts the sink utility-side; bail typed instead
        // of writing on against the dead handle.
        for (let off = 0; off < bytes.length; off += WRITE_CHUNK) {
          if (this.#cancelled) {
            return err(appError('cancelled', 'cancelled'));
          }
          const chunk = bytes.subarray(
            off,
            Math.min(off + WRITE_CHUNK, bytes.length),
          );
          const sent = await raced(
            api.transfer.write({
              sinkId: this.#id,
              data: toBase64(chunk),
            }),
            this.#signal,
          );
          if (sent.t === 'cancelled') {
            return err(appError('cancelled', 'cancelled'));
          }
          if (sent.t === 'failed') {
            return this.#settleError(sent.thrown);
          }
        }
        return ok(undefined);
      } catch (thrown) {
        return this.#settleError(thrown);
      }
    }

    async commit(): Promise<Result<number>> {
      const result = await raced(
        api.transfer.commit({ sinkId: this.#id }),
        this.#signal,
      );
      if (result.t === 'cancelled') {
        return err(appError('cancelled', 'cancelled'));
      }
      if (result.t === 'failed') {
        return this.#settleError(result.thrown);
      }
      return ok(result.value.offset);
    }

    async finalize(expected: string | null): Promise<Result<string>> {
      const result = await raced(
        api.transfer.finalize({ sinkId: this.#id, expected }),
        this.#signal,
      );
      this.#closed = true;
      if (result.t === 'cancelled') {
        return err(appError('cancelled', 'cancelled'));
      }
      if (result.t === 'failed') {
        return this.#settleError(result.thrown);
      }
      return ok(result.value.digest);
    }

    async abort(keep: boolean): Promise<Result<void>> {
      const result = await raced(
        api.transfer.abort({ sinkId: this.#id, keep }),
        this.#signal,
      );
      this.#closed = true;
      if (result.t === 'cancelled') {
        return err(appError('cancelled', 'cancelled'));
      }
      if (result.t === 'failed') {
        return err(shellToAppError(result.thrown));
      }
      return ok(undefined);
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
      return settle(api.transfer.ensureDir(), signal);
    },

    async begin(input, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      const call = api.transfer.begin({
        destPath: input.destPath,
        resumeAtBytes: input.resumeAtBytes,
      });
      const outcome = await raced(call, signal);
      if (outcome.t === 'cancelled') {
        // The begin can still land utility-side after the caller
        // settles — reap the minted sink when it does.
        void call.then(
          ({ sinkId }) =>
            api.transfer
              .abort({ sinkId, keep: false })
              .catch(() => undefined),
          () => undefined,
        );
        return err(appError('cancelled', 'cancelled'));
      }
      if (outcome.t === 'failed') {
        return err(shellToAppError(outcome.thrown));
      }
      const { sinkId } = outcome.value;
      if (signal.cancelled) {
        // Cancellation landed between the race settling and the sink
        // subscription — release the just-minted sink.
        await api.transfer
          .abort({ sinkId, keep: false })
          .catch(() => undefined);
        return err(appError('cancelled', 'cancelled'));
      }
      return ok(makeSink(sinkId, signal));
    },

    async sweepPartials(keepPaths, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      const res = await settle(
        api.transfer.sweepPartials({ keepPaths }),
        signal,
      );
      return res.ok ? ok(res.value.swept) : res;
    },

    async usage(signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      const res = await settle(api.transfer.stats(), signal);
      return res.ok ? ok(res.value.bytes) : res;
    },

    async freeBytes(signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      const res = await settle(api.transfer.stats(), signal);
      if (!res.ok) {
        return res;
      }
      return res.value.freeBytes === null
        ? err(appError('unavailable', 'free-bytes probe failed'))
        : ok(res.value.freeBytes);
    },

    async removeFile(name, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      return settle(api.transfer.remove({ name }), signal);
    },

    async stat(name, signal) {
      const cancelled = ifCancelled(signal);
      if (cancelled !== null) {
        return cancelled;
      }
      return settle(api.transfer.stat({ name }), signal);
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
