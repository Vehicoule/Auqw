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
 * utility-side even while the engine isn't driving a call. An op
 * reporting `cancelled` settles only after the shared teardown lands,
 * so callers never learn "cancelled" while the utility still owns the
 * file handle.
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
    #unsubscribe: () => void;
    /**
     * The one utility-side teardown: the signal listener, an explicit
     * `abort()`, and every op that reports `cancelled` share it — an
     * op settles only after it resolves, so a caller never learns
     * "cancelled" while the utility still holds the file handle (a
     * `removeFile` racing an open handle fails on Windows and strands
     * the download row in `removing`). The first armer's `keep` wins.
     */
    #teardown: Promise<Result<void>> | null = null;

    constructor(id: string, signal: CancellationSignal) {
      this.#id = id;
      this.#signal = signal;
      // A cancel while the sink is live aborts the utility side —
      // the engine may not issue another call for the signal to ride.
      // The subscription drops when the sink closes: a finalized sink
      // must not fire a stray abort on a later cancel. The field is a
      // no-op until subscribe returns so a synchronously-fired
      // (already-cancelled) signal can't hit an unassigned member.
      this.#unsubscribe = () => undefined;
      this.#unsubscribe = signal.subscribe(() => {
        this.#unsubscribe();
        this.#cancelled = true;
        this.#closed = true;
        // Armed, not awaited — the promise is what cancelled ops
        // settle behind; utility-side it queues behind the in-flight
        // op on the sink's chain.
        void this.#remoteAbort(true);
      });
      if (this.#closed) {
        this.#unsubscribe();
      }
    }

    /** Arm or join the shared utility-side abort. */
    #remoteAbort(keep: boolean): Promise<Result<void>> {
      this.#teardown ??= api.transfer
        .abort({ sinkId: this.#id, keep })
        .then(
          () => ok(undefined),
          (thrown) => this.#settleError(thrown),
        );
      return this.#teardown;
    }

    /** Cancelled paths settle only after teardown lands. */
    async #afterTeardown(): Promise<void> {
      if (this.#teardown !== null) {
        await this.#teardown;
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
        await this.#afterTeardown();
        return this.#closedResult();
      }
      try {
        // Bytes cross as base64 — `transfer:write` caps the frame at
        // 4MiB decoded; larger writes split at the seam. A cancel
        // mid-loop aborts the sink utility-side; bail typed instead
        // of writing on against the dead handle.
        for (let off = 0; off < bytes.length; off += WRITE_CHUNK) {
          if (this.#cancelled) {
            await this.#afterTeardown();
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
            await this.#afterTeardown();
            return err(appError('cancelled', 'cancelled'));
          }
          if (sent.t === 'failed') {
            await this.#afterTeardown();
            return this.#settleError(sent.thrown);
          }
        }
        return ok(undefined);
      } catch (thrown) {
        await this.#afterTeardown();
        return this.#settleError(thrown);
      }
    }

    async commit(): Promise<Result<number>> {
      const result = await raced(
        api.transfer.commit({ sinkId: this.#id }),
        this.#signal,
      );
      if (result.t === 'cancelled') {
        await this.#afterTeardown();
        return err(appError('cancelled', 'cancelled'));
      }
      if (result.t === 'failed') {
        await this.#afterTeardown();
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
      this.#unsubscribe();
      if (result.t === 'cancelled') {
        await this.#afterTeardown();
        return err(appError('cancelled', 'cancelled'));
      }
      if (result.t === 'failed') {
        await this.#afterTeardown();
        return this.#settleError(result.thrown);
      }
      return ok(result.value.digest);
    }

    async abort(keep: boolean): Promise<Result<void>> {
      // Shares the signal-armed teardown — never races the cancelled
      // signal, so the caller settles only after the utility released
      // the sink. On a still-open sink this IS the arming call.
      const result = await this.#remoteAbort(keep);
      this.#closed = true;
      this.#unsubscribe();
      return result;
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
