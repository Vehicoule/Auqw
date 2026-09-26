import { CancellationSource } from '../cancellation.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import { isSafeNonNegative } from '../domain.ts';
import type { SyncClient, SyncClientStatus } from './sync-client.ts';

/**
 * Application-level sync scheduling (docs/specs/sync.md): the client
 * owns one round's wire work; this owns *when* rounds happen —
 *   - on-launch: one round per known peer at start()
 *   - on-change: a debounced round after committed local writes
 *   - reconnect: capped exponential backoff after a dropped session
 *   - connectivity: pending rounds cancel offline, reschedule on edge
 *
 * Rounds never overlap per peer: a nudge arriving mid-round marks
 * the peer dirty and a follow-up runs after the round lands. All
 * timers ride ClockPort.sleep through per-peer cancel sources, so
 * stop() and unpairing abandon scheduled work immediately.
 */
export type SyncSchedulerDeps = {
  readonly client: SyncClient;
  readonly clock: ClockPort;
  readonly log: LogPort;
  /**
   * Live connectivity read; when absent the scheduler assumes the
   * network is up (the desktop's caller has no such port — its
   * sync transport is the server it hosts, and kicks fan out at
   * session accept instead).
   */
  readonly isOnline?: () => boolean;
  /** Trailing-edge debounce for on-change rounds. Default 750 ms. */
  readonly debounceMs?: number;
  /** First reconnect delay after a dropped session. Default 2 s. */
  readonly reconnectBaseMs?: number;
  /** Reconnect backoff cap. Default 60 s. */
  readonly reconnectMaxMs?: number;
};

export interface SyncScheduler {
  /** On-launch sync: fan out one round per known peer, then stay live. */
  start(): void;
  /** Local writes committed to the engine log — converge soon. */
  notifyLocalWrites(): void;
  /** Connectivity edge: false cancels pending rounds, true reschedules. */
  notifyConnectivity(online: boolean): void;
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_RECONNECT_BASE_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

type PeerTrack = {
  /** Pending scheduled round — cancelled when rescheduled or stopped. */
  timer: CancellationSource | null;
  /**
   * The pending wake is a write-debounce: a later write re-arms it
   * (trailing edge). Reconnect and one-shot wakes stand — a write
   * must not pull a backoff round earlier than the ladder set it.
   */
  debouncing: boolean;
  /** A nudge arrived while a round was in flight. */
  dirty: boolean;
  /** Current reconnect delay; doubles on each failed round. */
  backoffMs: number;
  /** A scheduler-owned round is in flight. */
  running: boolean;
};

export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  /** Last status() emission — peer list and live views. */
  let views: SyncClientStatus | null = null;
  const tracks = new Map<string, PeerTrack>();
  /** Cancels every scheduled timer and in-flight round on stop(). */
  let lifecycle = new CancellationSource();
  const owned = new Set<Promise<unknown>>();
  let unsubscribe: (() => void) | null = null;
  let running = false;

  function safeNow(): number | null {
    let now: number;
    try {
      now = deps.clock.nowMs();
    } catch {
      return null;
    }
    return isSafeNonNegative(now) ? now : null;
  }

  function online(): boolean {
    try {
      return deps.isOnline?.() ?? true;
    } catch {
      return false;
    }
  }

  function own(work: Promise<unknown>): void {
    owned.add(work);
    void work.then(
      () => {
        owned.delete(work);
      },
      () => {
        owned.delete(work);
      },
    );
  }

  /** Bounded, nonfatal, sanitized logging: never peer endpoints. */
  function warn(message: string): void {
    const atMs = safeNow();
    if (atMs === null) {
      return;
    }
    own(deps.log.write({ level: 'warn', message, atMs }));
  }

  function trackFor(fp: string): PeerTrack {
    let track = tracks.get(fp);
    if (track === undefined) {
      track = {
        timer: null,
        debouncing: false,
        dirty: false,
        backoffMs: reconnectBaseMs,
        running: false,
      };
      tracks.set(fp, track);
    }
    return track;
  }

  /**
   * Did the peer's last completed round move entries in either
   * direction? `lastRound` records the exchange even when the round
   * failed — the custody cursor alone can't see a phone-only upload.
   */
  function lastRoundMoved(fp: string): boolean {
    const view = views?.peers.find((v) => v.peer.fp === fp);
    const round = view?.lastRound;
    return (
      round !== undefined && round.remoteEntries + round.sentEntries > 0
    );
  }

  /**
   * Arms the peer's next round at `delayMs` — the only timer-placing
   * path. 'stand' keeps a pending wake (it fires soon and a round
   * exports everything pending at fire time); 'replace' cancels it
   * (backoff and recovery move the wake); 'debounce' is the
   * trailing-edge write wake — it re-arms a pending debounce so a
   * write burst fires once when it goes quiet, but stands behind a
   * reconnect or one-shot wake. Nudges during an in-flight round or
   * while offline mark dirty so a follow-up still runs.
   */
  function schedule(
    fp: string,
    delayMs: number,
    mode: 'stand' | 'replace' | 'debounce',
  ): void {
    if (!running || lifecycle.signal.cancelled) {
      return;
    }
    const track = trackFor(fp);
    if (track.running || !online()) {
      track.dirty = true;
      return;
    }
    if (track.timer !== null) {
      const rearm =
        mode === 'replace' ||
        (mode === 'debounce' && track.debouncing);
      if (!rearm) {
        return;
      }
      track.timer.cancel();
      track.timer = null;
      track.debouncing = false;
    }
    const timer = new CancellationSource();
    track.timer = timer;
    track.debouncing = mode === 'debounce';
    const work = (async () => {
      const slept = await deps.clock.sleep(delayMs, timer.signal);
      // Only OUR sleep clears the slot — a replacement armed while
      // this one was in flight must stay cancelable.
      if (track.timer === timer) {
        track.timer = null;
        track.debouncing = false;
      }
      if (!slept.ok || lifecycle.signal.cancelled) {
        return;
      }
      await runRound(fp);
    })();
    own(work);
  }

  async function runRound(fp: string): Promise<void> {
    const track = trackFor(fp);
    if (track.running || lifecycle.signal.cancelled || !online()) {
      track.dirty = true;
      return;
    }
    track.running = true;
    /** Reconnect delay when the round failed retryably. */
    let reconnectMs: number | null = null;
    /** A page-capped round that still moved entries continues once. */
    let progressed = false;
    try {
      const result = await deps.client.syncNow(fp, lifecycle.signal);
      if (result.ok) {
        track.backoffMs = reconnectBaseMs;
      } else if (result.error.kind === 'cancelled') {
        // Our own lifecycle cancel — no verdict to schedule on.
      } else {
        warn(`sync round failed: ${result.error.kind}`);
        if (result.error.retryable) {
          // Reconnect backoff: double per consecutive failure, capped.
          reconnectMs = track.backoffMs;
          track.backoffMs = Math.min(track.backoffMs * 2, reconnectMaxMs);
        } else if (
          result.error.kind === 'budget-exceeded' &&
          lastRoundMoved(fp)
        ) {
          // The page cap cut a still-moving exchange: custody persists
          // per page, so the follow-up resumes where this round left
          // off in both directions. A stalled round moved nothing —
          // no continuation, and the chain can never spin.
          progressed = true;
        }
      }
    } finally {
      track.running = false;
    }
    if (reconnectMs !== null) {
      // The reconnect round exports whatever accumulated, so pending
      // writes are covered by it rather than a second debounced wake.
      schedule(fp, reconnectMs, 'replace');
      return;
    }
    if (progressed) {
      // The continuation drains the rest of the backlog AND whatever
      // landed mid-round — consume the flag so no third wake books.
      track.dirty = false;
      schedule(fp, debounceMs, 'replace');
      return;
    }
    if (track.dirty) {
      track.dirty = false;
      schedule(fp, debounceMs, 'replace');
    }
  }

  function onStatus(status: SyncClientStatus): void {
    views = status;
    const seen = new Set<string>();
    for (const view of status.peers) {
      seen.add(view.peer.fp);
      // A peer absent from the tracks appeared after start() — a
      // fresh pairing — and the launch fan-out never covered it;
      // its first round converges edits that predate the pair.
      const isNew = !tracks.has(view.peer.fp);
      const track = trackFor(view.peer.fp);
      if (isNew) {
        schedule(view.peer.fp, debounceMs, 'stand');
      }
      if (view.state === 'open') {
        // 'open' during a scheduler-owned round is that round's
        // intermediate dial status — syncNow publishes it before
        // the exchange resolves — so the round's own result decides
        // the ladder. Resetting here would pin every live-but-
        // failing peer to the base delay forever.
        if (!track.running) {
          track.backoffMs = reconnectBaseMs;
        }
        if (track.dirty && !track.running) {
          track.dirty = false;
          schedule(view.peer.fp, debounceMs, 'replace');
        }
      } else if (
        view.state === 'offline' &&
        view.lastError !== undefined &&
        view.lastError.retryable &&
        !track.running &&
        track.timer === null
      ) {
        // A session the client dropped (dead socket, keepalive miss)
        // reconnects on the backoff ladder — non-retryable verdicts
        // (auth-required, peer revoked) wait for the peer list to
        // change instead of hammering a dead route.
        const wait = track.backoffMs;
        track.backoffMs = Math.min(track.backoffMs * 2, reconnectMaxMs);
        schedule(view.peer.fp, wait, 'stand');
      }
    }
    // An unpaired peer drops its track — pending timers die with it.
    for (const [fp, track] of [...tracks]) {
      if (!seen.has(fp)) {
        track.timer?.cancel();
        tracks.delete(fp);
      }
    }
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      // A fresh source: start() after stop() re-arms instead of
      // inheriting a cancelled lifecycle that dead-arms schedule().
      lifecycle = new CancellationSource();
      unsubscribe = deps.client.subscribe(onStatus);
      views = deps.client.status();
      for (const view of views.peers) {
        trackFor(view.peer.fp);
      }
      // On-launch round per known peer — the custody read is the
      // source of truth for devices that predate this status view.
      own(
        deps.client
          .peers(lifecycle.signal)
          .then((peers) => {
            if (!peers.ok || lifecycle.signal.cancelled) {
              return;
            }
            for (const peer of peers.value) {
              schedule(peer.fp, 0, 'stand');
            }
          })
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    },

    notifyLocalWrites(): void {
      if (views === null) {
        return;
      }
      for (const view of views.peers) {
        // Trailing edge: each write re-arms the wake — a burst
        // converges in one round once it goes quiet.
        schedule(view.peer.fp, debounceMs, 'debounce');
      }
    },

    notifyConnectivity(isOnline: boolean): void {
      if (isOnline) {
        // Recovery edge: reset every ladder and converge now —
        // peers with pending work fire immediately, the rest get a
        // round anyway since a dropped session's last writes may
        // never have landed.
        for (const [fp, track] of tracks) {
          track.backoffMs = reconnectBaseMs;
          if (!track.running) {
            // The immediate round exports everything the flag stood
            // for — consume it so a successful round doesn't book a
            // redundant second pass. schedule() re-marks dirty if
            // the online read races back down.
            track.dirty = false;
            schedule(fp, 0, 'replace');
          } else {
            track.dirty = true;
          }
        }
        return;
      }
      // Offline: pending rounds would only fail against a dead
      // network — cancel the timers; the dirty flags stay so the
      // recovery edge still converges.
      for (const track of tracks.values()) {
        if (track.timer !== null) {
          track.timer.cancel();
          track.timer = null;
          track.debouncing = false;
          track.dirty = true;
        }
      }
    },

    stop(): void {
      running = false;
      unsubscribe?.();
      unsubscribe = null;
      lifecycle.cancel();
      for (const track of tracks.values()) {
        track.timer?.cancel();
        track.timer = null;
        track.debouncing = false;
      }
    },
  };
}
