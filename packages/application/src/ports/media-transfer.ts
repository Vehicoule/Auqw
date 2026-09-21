import type { CancellationSignal } from '../cancellation.ts';
import type { Result } from '../errors.ts';

/**
 * What `begin` hands back: an append-only sink for one transfer.
 * `write` appends bytes; `commit` is the durability point — after it
 * returns ok the offset is resumable across restarts. `finalize`
 * verifies the checksum and atomically renames `.part` to the final
 * name; `abort` ends the sink, keeping or cleaning the partial file
 * deterministically.
 */
export interface TransferSink {
  write(bytes: Uint8Array): Promise<Result<void>>;
  /**
   * Durability point: bytes written so far are committed and the
   * returned offset is a valid resume point. Implementations may
   * flush/fsync here; the port never throws by contract.
   */
  commit(): Promise<Result<number>>;
  /**
   * Verify `sha256Hex` over the full file (or the adapter's own
   * integrity record) and atomically move `.part` to the final name.
   * A checksum mismatch fails `invalid-response` and keeps `.part`.
   */
  finalize(sha256Hex: string): Promise<Result<void>>;
  /**
   * End the transfer. `keep: true` retains the `.part` file for a
   * later resume; `false` deletes it.
   */
  abort(keep: boolean): Promise<Result<void>>;
}

/**
 * Download file-plane port (slice 3): owns the `downloads/`
 * directory, `.part` staging, resume offsets, and usage accounting.
 * Downloaded files are user-managed data — the port NEVER evicts
 * them; only explicit `abort`/`finalize` paths touch a transfer.
 * Wire policy (ranges, re-mints) lives in `downloads/transfer-policy.ts`.
 *
 * Path convention: `destPath` is a bare file name relative to the
 * port's managed directory, NOT an absolute path — implementations
 * confine writes to their own directory.
 */
export interface MediaTransferPort {
  /** Directory management: create the managed dir if absent. */
  ensureDir(signal: CancellationSignal): Promise<Result<void>>;
  /**
   * Open (or create) the `.part` sibling of `destPath` for a
   * transfer. `resumeAtBytes > 0` resumes in place — the sink appends
   * after the existing committed prefix; a missing/short `.part`
   * starts at 0 honestly.
   */
  begin(
    input: { destPath: string; resumeAtBytes: number },
    signal: CancellationSignal,
  ): Promise<Result<TransferSink>>;
  /**
   * Delete stale `.part` files left by an interrupted process that
   * have no owning transfer row. Returns the reclaimed byte count.
   */
  sweepPartials(
    keepPaths: readonly string[],
    signal: CancellationSignal,
  ): Promise<Result<number>>;
  /** Total bytes the managed directory currently holds. */
  usage(signal: CancellationSignal): Promise<Result<number>>;
  /** Bytes free on the volume that holds the managed dir. */
  freeBytes(signal: CancellationSignal): Promise<Result<number>>;
  /**
   * Delete a finalized file (e.g. a removed download or a stale
   * `available` row whose file vanished is handled by the manager).
   * Idempotent: a missing file is ok.
   */
  removeFile(name: string, signal: CancellationSignal): Promise<Result<void>>;
  /**
   * File-exists check for startup integrity: does the finalized file
   * for `name` exist with `bytes` size?
   */
  stat(
    name: string,
    signal: CancellationSignal,
  ): Promise<Result<{ exists: boolean; bytes: number | null }>>;
}
