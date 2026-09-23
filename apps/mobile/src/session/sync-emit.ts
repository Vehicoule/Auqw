import { ok, type Result } from '@auqw/application';
import type {
  CancellationSignal,
  LocalWrite,
} from '@auqw/application';

/**
 * Serializes emission into the sync change log.
 *
 * Emission order IS the log order: without a single tail, a racing
 * pre-surface flush and a fresh edit could reorder writes on the same
 * record. Writes made before the engine surface exists buffer here
 * (drop-oldest bound) and flush through one localChangeBatch once the
 * surface lands — a platform that never becomes syncable (iOS, web
 * build) sheds the tail instead of growing memory forever.
 */
export type SyncEmit = (
  writes: readonly LocalWrite[],
  signal?: CancellationSignal,
) => Promise<Result<unknown>>;

export function createSyncEmit(opts: {
  /** Null while the engine surface is still coming up. */
  surface(): {
    localChangeBatch(
      writes: readonly LocalWrite[],
      signal?: CancellationSignal,
    ): Promise<Result<unknown>>;
  } | null;
  /** Buffer bound while surface is null — drop-oldest past it. */
  maxBuffered?: number;
}): SyncEmit {
  const maxBuffered = opts.maxBuffered ?? 2_048;
  const buffered: LocalWrite[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const locked = async (
    writes: readonly LocalWrite[],
    signal?: CancellationSignal,
  ): Promise<Result<unknown>> => {
    const surface = opts.surface();
    if (surface === null) {
      buffered.push(...writes);
      if (buffered.length > maxBuffered) {
        buffered.splice(0, buffered.length - maxBuffered);
      }
      return ok(undefined);
    }
    const pending = buffered.splice(0);
    const stamped = await surface.localChangeBatch(
      pending.length > 0 ? [...pending, ...writes] : writes,
      signal,
    );
    if (!stamped.ok) {
      // localChangeBatch is atomic — a failed result means NOTHING
      // submitted reached the log: requeue the whole batch in order
      // (buffered prefix first, then this call's writes) or the fresh
      // writes drop until a restart recovers them (Review #46
      // round-11). The caller may retry the same writes — re-stamping
      // is idempotent.
      buffered.unshift(...pending, ...writes);
      if (buffered.length > maxBuffered) {
        buffered.splice(0, buffered.length - maxBuffered);
      }
    }
    return stamped;
  };
  return (writes, signal) => {
    const run = tail.then(() => locked(writes, signal));
    tail = run.catch(() => undefined);
    return run;
  };
}
