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
  peerViews = new Map<string, { state: SyncPeerView['state']; lastError?: AppError }>();
  syncNowCalls: string[] = [];
  outcomes: Result<SyncRoundOutcome>[] = [];
  #listeners = new Set<(status: SyncClientStatus) => void>();

  status(): SyncClientStatus {
    return {
      deviceId: 'self',
      peers: this.peersList.map((p) => {
        const view = this.peerViews.get(p.fp);
        const out: SyncPeerView = {
          peer: p,
          state: view?.state ?? 'offline',
          syncing: false,
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
    return Promise.resolve(next ?? ok(outcome(fp)));
  }

  refreshPeer(): Promise<Result<null>> {
    return Promise.resolve(ok(null));
  }

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
  // A capped round that moved the custody cursor books one bounded
  // continuation — it resumes from the persisted page. The next
  // round stalls with the cursor unmoved → terminal, no spin.
  let capped = 0;
  client.syncNow = (fp) => {
    client.syncNowCalls.push(fp);
    capped += 1;
    if (capped === 1) {
      client.peersList = client.peersList.map((p) =>
        p.fp === fp ? { ...p, peerCursor: { desk: 9 } } : p,
      );
      client.emitStatus();
    }
    return Promise.resolve(
      err(appError('budget-exceeded', 'page cap reached')),
    );
  };
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

export async function run(): Promise<void> {
  await onLaunchRoundPerPeer();
  await debouncedOnChange();
  await writeBurstTrailingEdge();
  await writeStandsBehindBackoff();
  await pageCapProgressContinues();
  await reconnectBackoff();
  await sessionDropReconnect();
  await connectivityEdges();
  await unpairedPeerDrops();
  await stopHaltsEverything();
  await nudgeMidRoundIsDirty();
  await newPeerFirstRound();
  await intermediateOpenKeepsBackoff();
  await recoveryEdgeConsumesDirty();
  await replacedTimerStaysCancelable();
}
