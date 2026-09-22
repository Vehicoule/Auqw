import type { CancellationSignal } from '../cancellation.ts';
import type { Result } from '../errors.ts';

/**
 * The merge engine the LAN transport drives. The transport owns the
 * wire — framing, handshake, device registry, AEAD session — and hands
 * this port opaque delta *documents*: what a delta IS and how it merges
 * is the engine's domain (change-log merge per docs/specs/sync.md), not
 * the transport's. `since` is an opaque cursor minted by the engine and
 * returned verbatim; the transport stores nothing derived from it.
 *
 * Per the port convention, these never throw — failures come back as
 * `Result` so the transport can put the typed error on the wire.
 * `signal` carries per-session cancellation: when a peer drops mid-op
 * the transport cancels it, letting the engine stop merge work nobody
 * will read. Optional so trivial engines can ignore it.
 */
export interface SyncEngine {
  /**
   * Emit the delta document covering everything the engine knows after
   * `since`; an empty `since` means a full snapshot.
   */
  exportDelta(
    since: string,
    signal?: CancellationSignal,
  ): Promise<Result<unknown>>;
  /**
   * Fold a peer's delta document into local state on behalf of
   * `deviceId` — the registry id from pairing, so the engine can scope
   * change-log attribution per device.
   */
  applyDelta(
    delta: unknown,
    deviceId: string,
    signal?: CancellationSignal,
  ): Promise<Result<unknown>>;
}
