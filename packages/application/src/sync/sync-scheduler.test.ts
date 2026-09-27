import { CancellationSource } from '../cancellation.ts';
import type { CancellationSignal } from '../cancellation.ts';
import { appError, err, ok } from '../errors.ts';
import type { AppError, Result } from '../errors.ts';
import type { SyncPeer } from '../ports/sync-transport.ts';
import { createSyncScheduler } from './sync-scheduler.ts';
import type { SyncSchedulerDeps } from './sync-scheduler.ts';
import type {
  SyncClient,
  SyncClientStatus,
  SyncPeerView,
  SyncRoundOutcome,
} from './sync-client.ts';
import { FakeClock, FakeLog } from '../testing/fakes.ts';
import { assert, assertEqual } from '../testing/assert.ts';

function peer(fp: string): SyncPeer {
  return {
    fp,
    name: `desktop-${fp}`,
    endpoints: ['192.168.1.2:4123'],
    pairedAt: 1,
    lastSeenAt: 1,
    peerCursor: {},
  };
}

function outcome(fp: string): SyncRoundOutcome {
  return { peerFp: fp, remoteEntries: 0, sentEntries: 0, divergence: 0, rounds: 1 };
}

/**
 * Minimal SyncClient: scripted syncNow results, a pushable status
 * view, and call recording. Only the scheduler-facing surface is
 * exercised; pair/refresh/unpair/close are contract stubs.
 */
class FakeSyncClient implements SyncClient {
  peersList: SyncPeer[] = [];
  peerViews = new Map<
    string,
    {
      state: SyncPeerView['state'];
      lastError?: AppError;
      lastRound?: SyncRoundOutcome;
      syncing?: boolean;
    }
  >();
  syncNowCalls: string[] = [];
  outcomes: Result<SyncRoundOutcome>[] = [];
  /** Per-call `lastRound` reports, consumed in syncNow order. */
  lastRounds: SyncRoundOutcome[] = [];
  #listeners = new Set<(status: SyncClientStatus) => void>();

  status(): SyncClientStatus {
    return {
      deviceId: 'self',
      peers: this.peersList.map((p) => {
        const view = this.peerViews.get(p.fp);
        const out: SyncPeerView = {
          peer: p,
          state: view?.state ?? 'offline',
          syncing: view?.syncing ?? false,
          ...(view?.lastRound !== undefined
            ? { lastRound: view.lastRound }
            : {}),
        };
        return view?.lastError === undefined
          ? out
          : { ...out, lastError: view.lastError };
      }),
    };
  }

  subscribe(listener: (status: SyncClientStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emitStatus(): void {
    const status = this.status();
    for (const listener of [...this.#listeners]) {
      listener(status);
    }
  }

  peers(): Promise<Result<readonly SyncPeer[]>> {
    return Promise.resolve(ok(this.peersList));
  }

  pair(): Promise<Result<SyncPeer>> {
    return Promise.resolve(err(appError('unsupported', 'stub')));
  }

  syncNow(fp: string, _signal?: CancellationSignal): Promise<Result<SyncRoundOutcome>> {
    this.syncNowCalls.push(fp);
    const next = this.outcomes.shift();
    const report = this.lastRounds.shift();
    if (report !== undefined) {
      const view = this.peerViews.get(fp) ?? { state: 'open' as const };
      this.peerViews.set(fp, { ...view, lastRound: report });
      this.emitStatus();
    }
    return Promise.resolve(next ?? ok(outcome(fp)));
  }

  refreshPeer(): Promise<Result<null>> {
    return Promise.resolve(ok(null));
  }

  refreshPeers(): Promise<Result<void>> {
    return Promise.resolve(ok(undefined));
  }

  dropSession(): void { }

  unpair(): Promise<Result<void>> {
    return Promise.resolve(ok(undefined));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function rig(opts: Partial<SyncSchedulerDeps> = {}): {
  client: FakeSyncClient;
  clock: FakeClock;
  scheduler: ReturnType<typeof createSyncScheduler>;
} {
  const client = new FakeSyncClient();
  const clock = new FakeClock(0);
  const scheduler = createSyncScheduler({
    client,
    clock,
    log: new FakeLog(),
    ...opts,
  });
  return { client, clock, scheduler };
}

async function pump(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

async function onLaunchRoundPerPeer(): Promise<void> {
  const { client, clock, scheduler } = rig();
  client.peersList = [peer('fp-a'), peer('fp-b')];
  scheduler.start();
  await pump();
  // peers() resolves → both peers scheduled at delay 0 → advance.
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.join(','), 'fp-a,fp-b', 'one launch round each');
  scheduler.stop();
}

async function debouncedOnChange(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 750 });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');

  scheduler.notifyLocalWrites();
  scheduler.notifyLocalWrites();
  scheduler.notifyLocalWrites();
  clock.advance(400);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'debounce holds below 750ms');
  clock.advance(400);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'one coalesced round');
  scheduler.stop();
}

async function reconnectBackoff(): Promise<void> {
  const { client, clock, scheduler } = rig({
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'offline' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1);

  // Failed round → reconnect at base 1s.
  client.outcomes = [err(appError('transient', 'socket died'))];
  scheduler.notifyLocalWrites();
  clock.advance(750);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'debounced round ran');
  await pump();
  // It failed → reconnect scheduled at ~1s; a second failure doubles.
  client.outcomes = [err(appError('transient', 'still down'))];
  clock.advance(1_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'reconnect round at base');
  clock.advance(1_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'backoff doubled to 2s');
  clock.advance(1_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 4, 'doubled backoff fired');
  scheduler.stop();
}

async function sessionDropReconnect(): Promise<void> {
  const { client, clock, scheduler } = rig({
    reconnectBaseMs: 2_000,
    debounceMs: 500,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1);

  // The client drops the session with a retryable verdict — the
  // scheduler reconnects on the ladder without any writes arriving.
  client.peerViews.set('fp-a', {
    state: 'offline',
    lastError: appError('transient', 'socket closed'),
  });
  client.emitStatus();
  await pump();
  clock.advance(1_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'backoff holds below 2s');
  clock.advance(1_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'reconnect fired at 2s');
  scheduler.stop();
}

async function connectivityEdges(): Promise<void> {
  let isOnline = true;
  const { client, clock, scheduler } = rig({
    isOnline: () => isOnline,
    debounceMs: 500,
  });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1);

  // Offline cancels a pending round; the recovery edge refires it.
  scheduler.notifyLocalWrites();
  clock.advance(100);
  isOnline = false;
  scheduler.notifyConnectivity(false);
  clock.advance(1_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'offline round cancelled');
  isOnline = true;
  scheduler.notifyConnectivity(true);
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'recovery edge converged');
  scheduler.stop();
}

async function unpairedPeerDrops(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  // Unpair: the peer vanishes from the status view.
  client.peersList = [];
  client.emitStatus();
  scheduler.notifyLocalWrites();
  clock.advance(1_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'no rounds for an unpaired peer');
  scheduler.stop();
}

async function unpairMidRoundCancelsAndNeverReschedules(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round done');
  // An exchange the unpair lands inside of.
  client.syncNowCalls.length = 0;
  let capturedSignal: CancellationSignal | undefined;
  let resolveRound: (r: Result<SyncRoundOutcome>) => void = () => { };
  client.syncNow = (fp, signal) => {
    client.syncNowCalls.push(fp);
    capturedSignal = signal;
    return new Promise((resolve) => {
      resolveRound = resolve;
    });
  };
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'round in flight');
  // Unpair mid-round: the exchange is cancelled and the track drops.
  client.peersList = [];
  client.emitStatus();
  assert(capturedSignal?.cancelled === true, 'unpair cancels the round');
  // A retryable failure arriving after the unpair must not arm a
  // reconnect — the peer is gone, the track must not resurrect.
  resolveRound(err(appError('transient', 'dropped mid-exchange')));
  await pump();
  clock.advance(120_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'no retry for an unpaired peer');
  scheduler.stop();
}

async function manualSuccessClearsStaleFloor(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round done');
  // A rate-limit verdict lands a 30 s floor and arms the reconnect.
  client.peerViews.set('fp-a', {
    state: 'offline',
    lastError: appError('rate-limit', 'slow down', 30_000),
  });
  client.emitStatus();
  await pump();
  // A manual syncNow dials — the client publishes 'open' at connect
  // time, before the exchange's verdict. A bare open is NOT a
  // completed round: the floor must stand through it.
  client.peerViews.set('fp-a', { state: 'open' });
  client.emitStatus();
  // The real client publishes the round's counters one hop early —
  // inside the still-syncing window — then the op drains carrying
  // the SAME lastRound object. Freshness vs the previous emission
  // cannot see the landing; the scheduler tracks its identity.
  const landed = outcome('fp-a');
  client.peerViews.set('fp-a', {
    state: 'open',
    syncing: true,
    lastRound: landed,
  });
  client.emitStatus();
  await pump();
  // The exchange lands clean: the op drains and the verdict-bearing
  // emission reports the completed round — the floor is obsolete now
  // and its armed wake dies with it.
  client.peerViews.set('fp-a', { state: 'open', lastRound: landed });
  client.emitStatus();
  await pump();
  // A write now debounces at 500 ms — not the obsolete 30 s floor.
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'write debounces once the stale floor clears',
  );
  clock.advance(60_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'no resurrected wake at the old floor',
  );
  scheduler.stop();
}

async function connectOpenKeepsRateLimitFloor(): Promise<void> {
  const { client, clock, scheduler } = rig({
    debounceMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A rate-limit verdict lands a 30 s floor (expiry t=30_000) and
  // arms the reconnect there.
  client.peerViews.set('fp-a', {
    state: 'offline',
    lastError: appError('rate-limit', 'slow down', 30_000),
  });
  client.emitStatus();
  await pump();
  clock.advance(1_000);
  // A manual syncNow dials mid-wait: 'open' publishes at connect,
  // before the exchange's verdict is known. The floor must survive
  // it — a write inside the window still waits.
  client.peerViews.set('fp-a', { state: 'open' });
  client.emitStatus();
  client.peerViews.set('fp-a', { state: 'open', syncing: true });
  client.emitStatus();
  await pump();
  scheduler.notifyLocalWrites();
  clock.advance(500); // t=1_500
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    1,
    'write cannot slip inside the floor on a bare connect',
  );
  // The manual round fails with a FRESH 30 s verdict — counters land
  // a hop early inside the syncing window, then the verdict-bearing
  // drain publishes them with the error: the floor re-arms to 31_500.
  const failed = outcome('fp-a');
  client.peerViews.set('fp-a', {
    state: 'open',
    syncing: true,
    lastRound: failed,
  });
  client.emitStatus();
  client.peerViews.set('fp-a', {
    state: 'open',
    lastError: appError('rate-limit', 'still slow', 30_000),
    lastRound: failed,
  });
  client.emitStatus();
  await pump();
  // The wakes armed at the old expiry fire at t=30_000, see the new
  // floor, and reschedule — nothing runs inside the peer's wait.
  clock.advance(28_500); // t=30_000
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    1,
    'old-expiry wake defers to the fresh verdict floor',
  );
  clock.advance(1_500); // t=31_500
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'retry lands at the fresh verdict floor',
  );
  scheduler.stop();
}

async function launchRoundPreemptsHydrationDebounce(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  // Unhydrated client: peers() emits the restored peers before the
  // call resolves — onStatus reads them as new pairings and arms a
  // write-debounce wake per peer. The launch fan-out must preempt
  // that timer, not stand behind it a full trailing edge.
  client.peers = () => {
    client.peersList = [peer('fp-a')];
    client.peerViews.set('fp-a', { state: 'open' });
    client.emitStatus();
    return Promise.resolve(ok(client.peersList));
  };
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round fires now');
  clock.advance(10_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    1,
    'hydration debounce was preempted, not doubled',
  );
  scheduler.stop();
}

async function reconnectSurvivesLaunchFanout(): Promise<void> {
  const { client, clock, scheduler } = rig({ reconnectBaseMs: 2_000 });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  // peers() stays pending while the session drops mid-read — the
  // offline emit arms the reconnect ladder before the fan-out lands.
  // The launch round must stand behind it, not replace it.
  let resolvePeers: (r: Result<readonly SyncPeer[]>) => void = () => { };
  client.peers = () =>
    new Promise((resolve) => {
      resolvePeers = resolve;
    });
  scheduler.start();
  client.peerViews.set('fp-a', {
    state: 'offline',
    lastError: appError('transient', 'socket closed'),
  });
  client.emitStatus();
  await pump();
  resolvePeers(ok(client.peersList));
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    0,
    'launch fan-out stands behind the armed reconnect',
  );
  clock.advance(2_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    1,
    'reconnect fires at its ladder wait',
  );
  scheduler.stop();
}

async function staleVerdictDoesNotSlideFloor(): Promise<void> {
  const { client, clock, scheduler } = rig();
  client.peersList = [peer('fp-a'), peer('fp-b')];
  // fp-a's failed round completed BEFORE the scheduler subscribed —
  // its verdict is already history, so seeding start() consumes it:
  // the first unrelated republish must not restart a fresh floor.
  client.peerViews.set('fp-a', {
    state: 'open',
    lastError: appError('rate-limit', 'slow down', 30_000),
    lastRound: outcome('fp-a'),
  });
  client.peerViews.set('fp-b', { state: 'open' });
  scheduler.start();
  client.emitStatus();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(
    client.syncNowCalls.join(','),
    'fp-a,fp-b',
    'stale verdict cannot floor the launch round',
  );
  clock.advance(30_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'no retry at the stale verdict expiry',
  );
  scheduler.stop();
}

async function stopHaltsEverything(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 100 });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  scheduler.stop();
  clock.advance(10_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 0, 'nothing fires after stop');
}

async function nudgeMidRoundIsDirty(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  // A round running while a nudge lands → one follow-up, not two.
  client.syncNowCalls.length = 0;
  let resolveRound: (r: Result<SyncRoundOutcome>) => void = () => { };
  client.syncNow = (fp) => {
    client.syncNowCalls.push(fp);
    return new Promise((resolve) => {
      resolveRound = resolve;
    });
  };
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'round in flight');
  scheduler.notifyLocalWrites();
  resolveRound(ok(outcome('fp-a')));
  await pump();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'dirty follow-up ran once');
  scheduler.stop();
}

async function newPeerFirstRound(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 0, 'no peers at start');
  // A pairing lands mid-session: the peer appears in the next status
  // emission — its first round must run without another trigger.
  client.peersList = [peer('fp-b')];
  client.peerViews.set('fp-b', { state: 'open' });
  client.emitStatus();
  await pump();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.join(','), 'fp-b', 'new peer synced once');
  scheduler.stop();
}

async function intermediateOpenKeepsBackoff(): Promise<void> {
  const { client, clock, scheduler } = rig({
    debounceMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'offline' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A round that dials (publishes 'open' mid-flight, like the real
  // client) then fails the exchange — the intermediate open must
  // NOT reset the reconnect ladder.
  client.syncNow = (fp) => {
    client.syncNowCalls.push(fp);
    client.peerViews.set(fp, { state: 'open' });
    client.emitStatus();
    client.peerViews.set(fp, {
      state: 'offline',
      lastError: appError('transient', 'page timed out'),
    });
    client.emitStatus();
    return Promise.resolve(err(appError('transient', 'page timed out')));
  };
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'debounced round ran');
  // First failure → reconnect at base 1s.
  clock.advance(999);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'backoff holds below 1s');
  clock.advance(1);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'reconnect at base');
  // Second consecutive failure → doubled to 2s despite the
  // intermediate open status each round emitted.
  clock.advance(1_999);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'ladder doubled to 2s');
  clock.advance(1);
  await pump();
  assertEqual(client.syncNowCalls.length, 4, 'doubled backoff fired');
  scheduler.stop();
}

async function recoveryEdgeConsumesDirty(): Promise<void> {
  let isOnline = true;
  const { client, clock, scheduler } = rig({
    isOnline: () => isOnline,
    debounceMs: 500,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // Writes arrive while offline — dirty marks them; the recovery
  // edge's immediate round covers them, so no second round follows.
  isOnline = false;
  scheduler.notifyConnectivity(false);
  scheduler.notifyLocalWrites();
  await pump();
  isOnline = true;
  scheduler.notifyConnectivity(true);
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'immediate recovery round');
  clock.advance(10_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'consumed dirty books no redundant follow-up',
  );
  scheduler.stop();
}

async function replacedTimerStaysCancelable(): Promise<void> {
  let isOnline = true;
  const { client, clock, scheduler } = rig({
    isOnline: () => isOnline,
    debounceMs: 500,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // Arm a debounced timer, then go offline → its sleeper resolves
  // cancelled. A replacement armed by the recovery edge must not be
  // clobbered by the dead sleeper clearing track.timer.
  scheduler.notifyLocalWrites();
  clock.advance(100);
  isOnline = false;
  scheduler.notifyConnectivity(false);
  isOnline = true;
  scheduler.notifyConnectivity(true);
  await pump();
  // Offline again before the replacement fires: a clobbered
  // reference would leave the live sleeper uncancellable.
  isOnline = false;
  scheduler.notifyConnectivity(false);
  clock.advance(10_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'replaced timer stayed dead');
  assertEqual(clock.pendingSleepers, 0, 'no orphaned sleeper');
  scheduler.stop();
}

async function writeBurstTrailingEdge(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [peer('fp-a')];
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // Trailing edge: a write mid-window re-arms the wake — the burst
  // converges ~500ms after the LAST write, not the first.
  scheduler.notifyLocalWrites();
  clock.advance(400);
  scheduler.notifyLocalWrites();
  clock.advance(400);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    1,
    'late write re-armed the wake',
  );
  clock.advance(200);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'one round once the burst went quiet',
  );
  scheduler.stop();
}

async function writeStandsBehindBackoff(): Promise<void> {
  const { client, clock, scheduler } = rig({
    debounceMs: 500,
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A failed round books a backoff wake at +2s. A write inside that
  // window must not re-arm it to the debounce edge — the failing
  // route keeps its ladder.
  client.outcomes = [err(appError('transient', 'socket died'))];
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'debounced round failed');
  scheduler.notifyLocalWrites();
  clock.advance(1_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'write cannot shortcut the backoff',
  );
  clock.advance(1_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    3,
    'backoff wake fires at its own edge',
  );
  scheduler.stop();
}

async function pageCapProgressContinues(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A capped round that still moved entries books one bounded
  // continuation — here a phone-only upload, where the desktop's
  // custody cursor never moves. The next round moves nothing →
  // terminal, no spin.
  client.outcomes = [
    err(appError('budget-exceeded', 'page cap reached')),
    err(appError('budget-exceeded', 'page cap reached')),
  ];
  client.lastRounds = [
    {
      peerFp: 'fp-a',
      remoteEntries: 0,
      sentEntries: 9,
      divergence: 0,
      rounds: 64,
    },
    {
      peerFp: 'fp-a',
      remoteEntries: 0,
      sentEntries: 0,
      divergence: 0,
      rounds: 1,
    },
  ];
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'capped round ran');
  clock.advance(499);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'continuation holds to the debounce',
  );
  clock.advance(1);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    3,
    'progressed cap booked a follow-up',
  );
  clock.advance(10_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    3,
    'stalled cap stays terminal',
  );
  scheduler.stop();
}

async function stopStartAcrossInFlightRound(): Promise<void> {
  const { client, clock, scheduler } = rig({ debounceMs: 500 });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A round still in flight across stop() → start(): the restart's
  // launch fan-out collapses into dirty (a round is running), and
  // the stale resolution drains under the new lifecycle — one
  // follow-up, no duplicate wakes, no lost write.
  let resolveRound: (r: Result<SyncRoundOutcome>) => void = () => { };
  client.syncNow = (fp) => {
    client.syncNowCalls.push(fp);
    return new Promise((resolve) => {
      resolveRound = resolve;
    });
  };
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'round in flight');
  scheduler.stop();
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'restart does not double-run the in-flight peer',
  );
  // The stale round resolves ok under the dead lifecycle — the
  // pending write still earns exactly one round on the new one.
  client.syncNow = (fp) => {
    client.syncNowCalls.push(fp);
    return Promise.resolve(ok(outcome(fp)));
  };
  resolveRound(ok(outcome('fp-a')));
  await pump();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'dirty follow-up ran once');
  clock.advance(10_000);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'no stale wake follows');
  scheduler.stop();
}

async function cleanCloseReconnects(): Promise<void> {
  const { client, clock, scheduler } = rig({
    debounceMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A clean socket close publishes offline with no verdict — the
  // peer was live, so the ladder still reconnects it.
  client.peerViews.set('fp-a', { state: 'offline' });
  client.emitStatus();
  await pump();
  clock.advance(999);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'backoff holds below base');
  clock.advance(1);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'clean close reconnects');
  // A peer that never opened must not take this path: it still earns
  // its first round via the new-peer branch, but the clean-close
  // ladder needs a live→offline transition — absent that, no churn.
  client.peersList = [peer('fp-a'), peer('fp-b')];
  client.peerViews.set('fp-b', { state: 'offline' });
  client.emitStatus();
  await pump();
  clock.advance(500);
  await pump();
  assertEqual(
    client.syncNowCalls.filter((fp) => fp === 'fp-b').length,
    1,
    'new peer still earns its first round',
  );
  clock.advance(10_000);
  await pump();
  assertEqual(
    client.syncNowCalls.filter((fp) => fp === 'fp-b').length,
    1,
    'never-opened peer does not reconnect-loop',
  );
  scheduler.stop();
}

async function unreachableDialReconnects(): Promise<void> {
  const { client, clock, scheduler } = rig({
    debounceMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'offline' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // The desktop is off: the dial lands 'unavailable' — non-retryable
  // in the taxonomy, but a transport-absent peer earns the ladder.
  client.outcomes = [
    err(appError('unavailable', 'sync: no usable endpoints')),
  ];
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'unreachable round ran');
  clock.advance(999);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'backoff holds below base');
  clock.advance(1);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'unreachable peer reconnects');
  // The reconnect succeeded — the ladder reset books nothing more.
  clock.advance(10_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    3,
    'a landed reconnect ends the ladder',
  );
  scheduler.stop();
}

async function rateLimitHintFloorsBackoff(): Promise<void> {
  const { client, clock, scheduler } = rig({
    debounceMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A rate-limit asks for 30 s — the 1 s ladder step floors at the
  // peer's own hint instead of retrying early.
  client.outcomes = [err(appError('rate-limit', 'slow down', 30_000))];
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'rate-limited round ran');
  clock.advance(29_999);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'ladder cannot duck the hint');
  clock.advance(1);
  await pump();
  assertEqual(client.syncNowCalls.length, 3, 'retry lands after the asked wait');
  scheduler.stop();
}

async function rateLimitFloorSurvivesRecovery(): Promise<void> {
  const { client, clock, scheduler } = rig({
    debounceMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a')];
  client.peerViews.set('fp-a', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 1, 'launch round ran');
  // A 30 s floor lands from the failed round at t=500 (expiry
  // t=30_500). A connectivity flap inside the floor must not fire
  // an early recovery round.
  client.outcomes = [err(appError('rate-limit', 'slow down', 30_000))];
  scheduler.notifyLocalWrites();
  clock.advance(500);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'rate-limited round ran');
  scheduler.notifyConnectivity(false);
  scheduler.notifyConnectivity(true);
  clock.advance(1_000);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    2,
    'recovery edge stands behind the floor',
  );
  clock.advance(28_999);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'floor not yet reached');
  clock.advance(1);
  await pump();
  assertEqual(
    client.syncNowCalls.length,
    3,
    'recovery round lands at the floor',
  );
  scheduler.stop();
}

async function republishedVerdictDoesNotSlideFloor(): Promise<void> {
  let isOnline = true;
  const { client, clock, scheduler } = rig({
    isOnline: () => isOnline,
    debounceMs: 500,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
  });
  client.peersList = [peer('fp-a'), peer('fp-b')];
  client.peerViews.set('fp-a', { state: 'open' });
  client.peerViews.set('fp-b', { state: 'open' });
  scheduler.start();
  await pump();
  clock.advance(0);
  await pump();
  assertEqual(client.syncNowCalls.length, 2, 'launch rounds ran');
  // fp-a drops at t=0 with a 30 s rate-limit verdict → floor 30_000.
  client.peerViews.set('fp-a', {
    state: 'offline',
    lastError: appError('rate-limit', 'slow down', 30_000),
  });
  client.emitStatus();
  await pump();
  // Offline cancels fp-a's armed retry; the floor survives on the
  // track.
  isOnline = false;
  scheduler.notifyConnectivity(false);
  await pump();
  // An unrelated peer's emission republishes fp-a's unchanged
  // offline verdict — the floor must not slide to now+hint (50 s).
  clock.advance(20_000);
  client.peerViews.set('fp-b', { state: 'offline' });
  client.emitStatus();
  await pump();
  isOnline = true;
  scheduler.notifyConnectivity(true);
  await pump();
  clock.advance(9_999);
  await pump();
  assertEqual(
    client.syncNowCalls.filter((fp) => fp === 'fp-a').length,
    1,
    'republished verdict does not slide the floor',
  );
  clock.advance(1);
  await pump();
  assertEqual(
    client.syncNowCalls.filter((fp) => fp === 'fp-a').length,
    2,
    'fp-a retry lands at the original expiry',
  );
  scheduler.stop();
}

export async function run(): Promise<void> {
  await onLaunchRoundPerPeer();
  await debouncedOnChange();
  await writeBurstTrailingEdge();
  await unreachableDialReconnects();
  await rateLimitHintFloorsBackoff();
  await rateLimitFloorSurvivesRecovery();
  await republishedVerdictDoesNotSlideFloor();
  await writeStandsBehindBackoff();
  await pageCapProgressContinues();
  await stopStartAcrossInFlightRound();
  await reconnectBackoff();
  await sessionDropReconnect();
  await connectivityEdges();
  await unpairedPeerDrops();
  await unpairMidRoundCancelsAndNeverReschedules();
  await manualSuccessClearsStaleFloor();
  await connectOpenKeepsRateLimitFloor();
  await launchRoundPreemptsHydrationDebounce();
  await reconnectSurvivesLaunchFanout();
  await staleVerdictDoesNotSlideFloor();
  await stopHaltsEverything();
  await nudgeMidRoundIsDirty();
  await newPeerFirstRound();
  await intermediateOpenKeepsBackoff();
  await recoveryEdgeConsumesDirty();
  await replacedTimerStaysCancelable();
  await cleanCloseReconnects();
}
