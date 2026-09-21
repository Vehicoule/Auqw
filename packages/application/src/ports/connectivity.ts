import type { Result } from '../errors.ts';

/** Point-in-time network state the scheduler consults. */
export type ConnectivitySnapshot = {
  /** Any usable network right now (validated upstream if available). */
  online: boolean;
  /**
   * The active connection is metered (cellular / data-saver). When
   * `online` is false this is best-effort — do not infer a policy.
   */
  metered: boolean;
};

/**
 * Network-state port (slice 3): a snapshot plus change events. The
 * Kotlin side is a ConnectivityManager NetworkCallback inside
 * auqw-expo — no new dependency. `subscribe` listeners run on change
 * edges only; a throwing listener must not break fan-out.
 */
export interface ConnectivityPort {
  /** The freshest known state — never blocks on a probe. */
  snapshot(): Promise<Result<ConnectivitySnapshot>>;
  /**
   * Subscribe to change edges. Returns an unsubscribe function.
   * The current state is NOT replayed on subscribe.
   */
  subscribe(
    listener: (snapshot: ConnectivitySnapshot) => void,
  ): () => void;
}
