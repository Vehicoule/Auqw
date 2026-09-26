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

export async function run(): Promise<void> {
  await onLaunchRoundPerPeer();
  await debouncedOnChange();
  await reconnectBackoff();
  await sessionDropReconnect();
  await connectivityEdges();
  await unpairedPeerDrops();
  await stopHaltsEverything();
  await nudgeMidRoundIsDirty();
}
