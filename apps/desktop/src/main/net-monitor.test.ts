import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import { CHANNELS } from '../shared/channels.ts';
import {
  createFetchProbe,
  createNetService,
} from './net-monitor.ts';
import type { NetSender } from './net-monitor.ts';

class CollectingSender implements NetSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  last(): unknown {
    return this.sent.at(-1)?.payload;
  }
}

/** Sender that throws on every send — stands in for a destroyed WebContents. */
class DeadSender implements NetSender {
  send(): void {
    throw new Error('web contents destroyed');
  }
}

/** Sender with a `destroyed` hook — mirrors real WebContents lifecycle. */
class DestroyableSender extends CollectingSender {
  private destroyed: (() => void) | null = null;
  on(event: 'destroyed', listener: () => void): void {
    assert(event === 'destroyed');
    this.destroyed = listener;
  }
  destroy(): void {
    this.destroyed?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flush the microtask queue so a settled probe's publish has run. */
async function flush(): Promise<void> {
  await sleep(0);
}

/** NIC-view only: diff-poll fan-out, refcount, dead-sender isolation. */
async function nicViewFanout(): Promise<void> {
  let online = true;
  const service = createNetService({
    readOnline: () => online,
    pollMs: 5,
  });
  try {
    assertDeepEqual(service.snapshot(), { online: true });

    // Attaching pushes the current state immediately.
    const a = new CollectingSender();
    const b = new CollectingSender();
    service.attach(a);
    service.attach(b);
    assertEqual(a.sent.length, 1);
    assertDeepEqual(a.sent[0], {
      channel: CHANNELS.netEvents,
      payload: { online: true },
    });

    // A transition is pushed to every attached sender.
    online = false;
    await sleep(40);
    assertEqual(a.sent.length, 2);
    assertEqual(b.sent.length, 2);
    assertDeepEqual(b.sent[1], {
      channel: CHANNELS.netEvents,
      payload: { online: false },
    });

    // No transition → no push.
    await sleep(40);
    assertEqual(a.sent.length, 2);

    // Detached senders stop receiving.
    service.detach(a);
    online = true;
    await sleep(40);
    assertEqual(a.sent.length, 2, 'detached sender gets nothing');
    assertEqual(b.sent.length, 3, 'attached sender still gets events');
    assertDeepEqual(service.snapshot(), { online: true });

    // Subscriptions are refcounted: two attaches need two detaches.
    service.attach(b);
    service.detach(b);
    online = false;
    await sleep(40);
    assertEqual(b.sent.length, 4, 'refcounted sender keeps events');
    service.detach(b);
    online = true;
    await sleep(40);
    assertEqual(b.sent.length, 4, 'fully detached sender stops');

    // A sender whose send throws is dropped without killing the poll.
    const dead = new DeadSender();
    const c = new CollectingSender();
    service.attach(dead);
    service.attach(c);
    online = false;
    await sleep(40);
    assertEqual(c.sent.length, 2, 'healthy sender unaffected by dead one');
    online = true;
    await sleep(40);
    assertEqual(c.sent.length, 3, 'poll keeps running after drop');

    // A 'destroyed' event removes the sender without an explicit detach.
    const d = new DestroyableSender();
    service.attach(d);
    d.destroy();
    online = false;
    await sleep(40);
    assertEqual(d.sent.length, 1, 'destroyed sender only got initial push');
    assertEqual(c.sent.length, 4, 'other senders still receive events');
  } finally {
    service.stop();
  }
}

/**
 * A manually settled probe: each call parks a resolver the test fires in
 * order, so probe verdicts drive the publish path deterministically.
 */
function manualProbe() {
  const pending: Array<(reachable: boolean) => void> = [];
  return {
    pending,
    probe: () =>
      new Promise<boolean>((resolve) => {
        pending.push(resolve);
      }),
    /** Settle the oldest parked probe. */
    settle(reachable: boolean): void {
      const resolve = pending.shift();
      assert(resolve !== undefined, 'no probe in flight');
      resolve(reachable);
    },
  };
}

/** Probe-gated publish: the verdict — not the NIC view — is the truth. */
async function probeVerdictGatesPublish(): Promise<void> {
  let nic = true;
  const harness = manualProbe();
  const service = createNetService({
    readOnline: () => nic,
    pollMs: 5,
    probe: harness.probe,
    probeIntervalMs: 20,
    probeRetryMs: 8,
  });
  try {
    // The construction probe is already parked; NIC view says online
    // until the first verdict lands.
    assertEqual(harness.pending.length, 1, 'boot probe fired');
    assertDeepEqual(service.snapshot(), { online: true });
    const a = new CollectingSender();
    service.attach(a);
    assertDeepEqual(a.last(), { online: true });
    harness.settle(true);
    await flush();
    assertEqual(a.sent.length, 1, 'healthy verdict republishes nothing');

    // Dead upstream with the link still up: two failing probes take the
    // surface offline — one failure alone cannot.
    await sleep(30);
    assert(harness.pending.length >= 1, 're-verify probe fired');
    harness.settle(false);
    await flush();
    assertDeepEqual(service.snapshot(), { online: true }, 'one fail tolerated');
    await sleep(15);
    harness.settle(false);
    await flush();
    assertDeepEqual(service.snapshot(), { online: false });
    assertDeepEqual(a.last(), { online: false });

    // The NIC never moved — a healed upstream is still found on the
    // retry cadence and publishes back online.
    await sleep(15);
    harness.settle(true);
    await flush();
    assertDeepEqual(service.snapshot(), { online: true });
    assertDeepEqual(a.last(), { online: true });

    // NIC dropping publishes offline immediately — no probe wait.
    nic = false;
    await sleep(15);
    assertDeepEqual(service.snapshot(), { online: false });
    assertDeepEqual(a.last(), { online: false });
    const sentBefore = a.sent.length;
    // The down-edge parks a probe in the older generation; a NIC flap
    // bumps the generation so its settle is discarded and a fresh
    // probe takes the verdict — stale state can't reverse the edge.
    nic = true;
    await sleep(15);
    assert(harness.pending.length >= 1, 'down edge re-armed a probe');
    harness.settle(true);
    await flush();
    assertDeepEqual(service.snapshot(), { online: false }, 'stale settle discarded');
    assert(harness.pending.length >= 1, 'fresh probe re-armed');
    harness.settle(true);
    await flush();
    assertDeepEqual(service.snapshot(), { online: true });
    assert(a.sent.length > sentBefore, 'rescue pushed an event');
  } finally {
    service.stop();
  }
}

/** An up-edge with a still-failing probe streak stays offline. */
async function probeStreakSurvivesNicFlap(): Promise<void> {
  let nic = true;
  const harness = manualProbe();
  const service = createNetService({
    readOnline: () => nic,
    pollMs: 5,
    probe: harness.probe,
    probeIntervalMs: 10,
    probeRetryMs: 5,
  });
  try {
    harness.settle(false);
    await sleep(20);
    harness.settle(false);
    await flush();
    assertDeepEqual(service.snapshot(), { online: false });
    // NIC flap while the streak is hot: the edge alone must not
    // republish online — only a verdict from this generation may.
    nic = false;
    await sleep(15);
    nic = true;
    await sleep(15);
    assertDeepEqual(service.snapshot(), { online: false });
    // The down-edge probe settles stale under the new generation —
    // discarded, then re-armed; its replacement decides.
    harness.settle(true);
    await flush();
    assertDeepEqual(service.snapshot(), { online: false });
    harness.settle(true);
    await flush();
    assertDeepEqual(service.snapshot(), { online: true });
  } finally {
    service.stop();
  }
}

/**
 * Sustained probe failure stretches the re-probe gap geometrically —
 * 10 → 20 → 40 → capped at probeRetryMaxMs — while a flap keeps the
 * snappy base cadence. The injected clock drives the gap math; the
 * real poll interval only delivers the ticks.
 */
async function retryBackoffStretches(): Promise<void> {
  let t = 1_000;
  let nic = true;
  const harness = manualProbe();
  const service = createNetService({
    readOnline: () => nic,
    pollMs: 5,
    probe: harness.probe,
    probeIntervalMs: 1_000_000,
    probeRetryMs: 10,
    probeRetryMaxMs: 45,
    now: () => t,
  });
  try {
    // First failure: no verdict yet — the streak is still below the
    // offline threshold, so the next probe waits only probeRetryMs.
    harness.settle(false);
    await flush();
    t += 10;
    await sleep(20);
    assertEqual(harness.pending.length, 1, 'first retry at base gap');
    harness.settle(false);
    await flush();
    assertDeepEqual(service.snapshot(), { online: false });
    // failures=2 stays at probeRetryMs — proving a flap is cheap.
    t += 9;
    await sleep(20);
    assertEqual(harness.pending.length, 0, 'base gap not yet reached');
    t += 1;
    await sleep(20);
    assertEqual(harness.pending.length, 1, 'retry fires at the gap edge');
    // failures=3 → the gap doubles to 20.
    harness.settle(false);
    await flush();
    t += 19;
    await sleep(20);
    assertEqual(harness.pending.length, 0, 'stretched gap not reached');
    t += 1;
    await sleep(20);
    assertEqual(harness.pending.length, 1);
    // failures=4 → 40.
    harness.settle(false);
    await flush();
    t += 39;
    await sleep(20);
    assertEqual(harness.pending.length, 0);
    t += 1;
    await sleep(20);
    assertEqual(harness.pending.length, 1);
    // failures=5 → the cap binds: 10·2³=80 clamps to 45.
    harness.settle(false);
    await flush();
    t += 44;
    await sleep(20);
    assertEqual(harness.pending.length, 0);
    t += 1;
    await sleep(20);
    assertEqual(harness.pending.length, 1, 'cap binds at probeRetryMaxMs');
    // A NIC edge mid-streak restarts the retry cadence at base: the
    // changed network deserves fresh fast evidence even though the
    // latched offline verdict still needs a real success to clear.
    harness.settle(false);
    await flush();
    nic = false;
    await sleep(20);
    assertEqual(harness.pending.length, 1, 'down edge re-arms a probe');
    harness.settle(false);
    await flush();
    nic = true;
    await sleep(20);
    assertEqual(harness.pending.length, 1, 'up edge re-arms a probe');
    harness.settle(false);
    await flush();
    assertDeepEqual(service.snapshot(), { online: false });
    // streak=1 in the new generation → base gap, not the old cap.
    t += 9;
    await sleep(20);
    assertEqual(harness.pending.length, 0);
    t += 1;
    await sleep(20);
    assertEqual(
      harness.pending.length,
      1,
      'a post-edge failure is back at base gap',
    );
    // Recovery publishes online and resets both streaks.
    harness.settle(true);
    await flush();
    assertDeepEqual(service.snapshot(), { online: true });
  } finally {
    service.stop();
  }
}

/** createFetchProbe: status gate, transport failure, and timeout. */
async function fetchProbeVerdicts(): Promise<void> {
  const okProbe = createFetchProbe(async () => ({ status: 204 }), {
    url: 'https://canary.test/generate_204',
    expectedStatus: 204,
  });
  assert(await okProbe(), 'expected status is reachable');
  const portalProbe = createFetchProbe(async () => ({ status: 200 }), {
    url: 'https://canary.test/generate_204',
    expectedStatus: 204,
  });
  assert(
    !(await portalProbe()),
    'a rewritten 200 is a captive portal, not internet',
  );
  const deadProbe = createFetchProbe(
    async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
    { url: 'https://canary.test/generate_204', expectedStatus: 204 },
  );
  assert(!(await deadProbe()), 'transport failure is unreachable');
  const hungProbe = createFetchProbe(
    () => new Promise<{ status: number }>(() => {}),
    {
      url: 'https://canary.test/generate_204',
      expectedStatus: 204,
      timeoutMs: 15,
    },
  );
  assert(!(await hungProbe()), 'a hung request times out unreachable');
}

export async function run(): Promise<void> {
  await nicViewFanout();
  await probeVerdictGatesPublish();
  await probeStreakSurvivesNicFlap();
  await retryBackoffStretches();
  await fetchProbeVerdicts();
}
