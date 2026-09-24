import { assert, assertEqual } from '@auqw/application/testing';
import type { PlayerEvent, QueueProjection } from '@auqw/application';
import type { StreamClient } from './web-player.ts';
import type { PrepareOutcomePayload } from '../shared/contract.ts';
import { createWebPlayerPort } from './web-player.ts';
import type { AudioLike, MediaSessionLike } from './web-player.ts';

type FakeAudio = AudioLike & { fire(type: string): void };

function fakeAudio(): FakeAudio {
  const listeners = new Map<string, Array<() => void>>();
  const audio = {
    src: '',
    currentTime: 0,
    duration: 60,
    paused: true,
    ended: false,
    volume: 1,
    play(): Promise<void> {
      audio.paused = false;
      audio.fire('playing');
      return Promise.resolve();
    },
    pause(): void {
      audio.paused = true;
      audio.fire('pause');
    },
    addEventListener(type: string, listener: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
  };
  return audio;
}

function fakeMediaSession(): MediaSessionLike & {
  actions: Map<string, (() => void) | null>;
} {
  const actions = new Map<string, (() => void) | null>();
  return {
    playbackState: 'none',
    actions,
    setActionHandler(action, handler) {
      actions.set(action, handler);
    },
  };
}

function fakeStream(overrides: Partial<StreamClient> = {}): StreamClient & {
  calls: Array<{ method: string; args: unknown }>;
} {
  const calls: Array<{ method: string; args: unknown }> = [];
  const record = (method: string) => (args: unknown) => {
    calls.push({ method, args });
    return args;
  };
  const client: StreamClient & {
    calls: Array<{ method: string; args: unknown }>;
  } = {
    calls,
    prepare: (args) => {
      record('prepare')(args);
      return Promise.resolve({
        type: 'prepared',
        stream: { handle: 'h-1', mime: 'audio/mp4' },
      });
    },
    devPrepare: (args) => {
      record('devPrepare')(args);
      return Promise.resolve({ handle: 'h-dev', mime: 'audio/mp4' });
    },
    serveUrl: (args) => {
      record('serveUrl')(args);
      return Promise.resolve({ url: 'http://127.0.0.1:9/s/tok' });
    },
    open: () => Promise.resolve({ remaining: null }),
    read: () => Promise.resolve({ data: '' }),
    close: () => Promise.resolve(undefined),
    release: (args) => {
      record('release')(args);
      return Promise.resolve(undefined);
    },
    marks: () =>
      Promise.resolve({
        prepareStartedMs: 1000,
        resolveMs: 5,
        mintMs: 8,
        attachMs: 1020,
      }),
    cancel: (args) => {
      record('cancel')(args);
      return Promise.resolve(undefined);
    },
    channel: (args) => {
      record('channel')(args);
      return Promise.reject(
        Object.assign(new Error('no test pump'), { kind: 'unavailable' }),
      );
    },
    ...overrides,
  };
  // Overriding a method must not lose the call record.
  for (const key of Object.keys(overrides) as Array<keyof StreamClient>) {
    const inner = overrides[key];
    if (inner !== undefined) {
      (client as Record<string, unknown>)[key] = (args: unknown) => {
        record(key)(args);
        return (inner as (a: unknown) => unknown)(args);
      };
    }
  }
  return client;
}

const identity = { attemptId: 'attempt-1', queueRev: 3 };

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function collect(player: { subscribe(l: (e: PlayerEvent) => void): () => void }) {
  const events: PlayerEvent[] = [];
  player.subscribe((e) => events.push(e));
  return events;
}

function twoItemProjection(
  overrides: Partial<QueueProjection> = {},
): QueueProjection {
  return {
    projectionId: 'proj-1',
    queueRev: 4,
    currentOccurrenceId: 'occ-1',
    positionMs: 0,
    mode: 'playing',
    items: [
      {
        occurrenceId: 'occ-1',
        provider: 'deezer',
        sourceRef: 't1',
        title: 'one',
        artist: null,
        artworkUrl: null,
      },
      {
        occurrenceId: 'occ-2',
        provider: 'deezer',
        sourceRef: 't2',
        title: 'two',
        artist: null,
        artworkUrl: null,
      },
    ],
    ...overrides,
  };
}

export async function run(): Promise<void> {
  // prepare → prepared event with stream + attempt.
  {
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio: fakeAudio() });
    const events = collect(player);
    const res = await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    assert(res.ok, 'prepare resolves ok');
    const prepared = events.find((e) => e.type === 'prepare');
    assert(
      prepared !== undefined &&
        prepared.type === 'prepare' &&
        prepared.outcome.type === 'prepared' &&
        prepared.outcome.stream.handle === 'h-1' &&
        prepared.identity.attemptId === 'attempt-1',
      'prepared event carries stream + identity',
    );
    assert(
      stream.calls.some(
        (c) =>
          c.method === 'prepare' &&
          typeof c.args === 'object' &&
          c.args !== null &&
          (c.args as { requestId?: string }).requestId ===
            (res.ok ? res.value : ''),
      ),
      'host sees the minted requestId',
    );
  }

  // prepare failed outcome → failed event with the host's kind.
  {
    const stream = fakeStream({
      prepare: () =>
        Promise.resolve({
          type: 'failed',
          kind: 'rate-limit',
          message: 'slow down',
        }),
    });
    const player = createWebPlayerPort({ stream, audio: fakeAudio() });
    const events = collect(player);
    await player.prepare({ provider: 'deezer', sourceRef: 'x', identity });
    await settle();
    const prepared = events.find((e) => e.type === 'prepare');
    assert(
      prepared !== undefined &&
        prepared.type === 'prepare' &&
        prepared.outcome.type === 'failed' &&
        prepared.outcome.error.kind === 'rate-limit',
      'host kind crosses into the failed event',
    );
  }

  // prepare rejection → failed event, typed error, never a throw.
  {
    const stream = fakeStream({
      prepare: () =>
        Promise.reject({ kind: 'unavailable', message: 'no bindings' }),
    });
    const player = createWebPlayerPort({ stream, audio: fakeAudio() });
    const events = collect(player);
    const res = await player.prepare({
      provider: 'deezer',
      sourceRef: 'x',
      identity,
    });
    assert(res.ok, 'rejected prepare still resolves with requestId');
    await settle();
    const prepared = events.find((e) => e.type === 'prepare');
    assert(
      prepared !== undefined &&
        prepared.type === 'prepare' &&
        prepared.outcome.type === 'failed' &&
        prepared.outcome.error.kind === 'unavailable',
      'shell error maps onto app kinds',
    );
  }

  // local provider → honest unavailable failure, no host call.
  {
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio: fakeAudio() });
    const events = collect(player);
    await player.prepare({ provider: 'local', sourceRef: '/x.mp3', identity });
    const prepared = events.find((e) => e.type === 'prepare');
    assert(
      prepared !== undefined &&
        prepared.type === 'prepare' &&
        prepared.outcome.type === 'failed' &&
        prepared.outcome.error.kind === 'unavailable',
      'local reports unavailable until Phase 4',
    );
    assert(
      !stream.calls.some((c) => c.method === 'prepare'),
      'local never reaches the host',
    );
  }

  // play → serveUrl, src set, buffering status then playing.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    const res = await player.play({
      handle: 'h-1',
      identity,
      positionMs: 1500,
    });
    assert(res.ok, 'play resolves');
    assertEqual(audio.src, 'http://127.0.0.1:9/s/tok');
    assertEqual(audio.currentTime, 1.5);
    const states = events
      .filter((e) => e.type === 'status')
      .map((e) => (e.type === 'status' ? e.state : ''));
    assert(
      states.includes('buffering') && states.includes('playing'),
      'buffering then playing statuses flow',
    );
    const phases = events.filter((e) => e.type === 'phase');
    assert(
      phases.some(
        (e) => e.type === 'phase' && e.name === 'mint' && e.sinceStartMs === 8,
      ),
      'phase marks emit as phase events',
    );
    // Epoch marks convert through prepareStartedMs — never surface raw
    // epoch millis as a duration.
    assert(
      phases.some(
        (e) =>
          e.type === 'phase' && e.name === 'attach' && e.sinceStartMs === 20,
      ),
      'epoch marks emit as since-start durations',
    );
    // pause/seek/stop honour the active identity.
    assert((await player.pause(identity)).ok, 'pause resolves');
    assert((await player.seekTo({ positionMs: 5000, identity })).ok);
    const stalePause = await player.pause({
      attemptId: 'other',
      queueRev: 3,
    });
    assert(
      !stalePause.ok && stalePause.error.kind === 'invalid-message',
      'stale identity rejects typed',
    );
    assert((await player.stop(identity)).ok, 'stop resolves');
    assertEqual(audio.src, '');
    const idle = events.findLast(
      (e) => e.type === 'status' && e.state === 'idle',
    );
    assert(idle !== undefined, 'stop emits idle status');
  }

  // ended → status ended + service-attached queue-transition inside a
  // projection: the port prepares+attaches the successor itself and the
  // emitted transition carries its fresh identity + handle.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    const projection = twoItemProjection();
    assert((await player.setQueueProjection(projection)).ok);
    await player.play({ handle: 'h-1', identity });
    audio.fire('ended');
    await settle();
    const transition = events.find((e) => e.type === 'queue-transition');
    assert(
      transition !== undefined &&
        transition.type === 'queue-transition' &&
        transition.reason === 'ended' &&
        transition.fromOccurrenceId === 'occ-1' &&
        transition.toOccurrenceId === 'occ-2' &&
        transition.projectionId === 'proj-1' &&
        transition.identity !== null &&
        transition.identity.queueRev === 4 &&
        transition.handle === 'h-1',
      'ended attaches the successor and reports its identity+handle',
    );
    assert(
      stream.calls.some(
        (c) =>
          c.method === 'prepare' &&
          typeof c.args === 'object' &&
          c.args !== null &&
          (c.args as { sourceRef?: string }).sourceRef === 't2',
      ),
      'the successor is prepared through the host',
    );
    // Media Session next/previous drive remote transitions.
    const ms = fakeMediaSession();
    const player2 = createWebPlayerPort({
      stream: fakeStream(),
      audio,
      mediaSession: ms,
    });
    const events2 = collect(player2);
    await player2.setQueueProjection(projection);
    ms.actions.get('nexttrack')?.();
    await settle();
    const remote = events2.find((e) => e.type === 'queue-transition');
    assert(
      remote !== undefined &&
        remote.type === 'queue-transition' &&
        remote.reason === 'remote-next' &&
        remote.toOccurrenceId === 'occ-2' &&
        remote.identity !== null &&
        remote.handle === 'h-1',
      'media-session next attaches + reports remote-next',
    );
  }

  // Queue rekeys: a projection for the SAME occurrence re-keys the live
  // identity, so transport calls with the new rev pass and the old rev
  // reads stale. A projection naming another occurrence must not re-key.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio });
    collect(player);
    const live = { attemptId: 'attempt-1', queueRev: 4 };
    await player.setQueueProjection(twoItemProjection());
    await player.play({ handle: 'h-1', identity: live });
    await player.setQueueProjection(twoItemProjection({ queueRev: 5 }));
    const rekeyed = await player.pause({ attemptId: 'attempt-1', queueRev: 5 });
    assert(rekeyed.ok, 're-keyed identity passes the stale guard');
    const staleRev = await player.pause({
      attemptId: 'attempt-1',
      queueRev: 4,
    });
    assert(
      !staleRev.ok && staleRev.error.kind === 'invalid-message',
      'the superseded rev is rejected',
    );
    await player.setQueueProjection(
      twoItemProjection({ currentOccurrenceId: 'occ-9', queueRev: 6 }),
    );
    const stillLive = await player.pause({
      attemptId: 'attempt-1',
      queueRev: 5,
    });
    assert(
      stillLive.ok,
      'a projection for another occurrence leaves the live rev alone',
    );
  }

  // remote-previous inside 3 s restarts the current stream in place —
  // same attempt, same handle, position 0.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const ms = fakeMediaSession();
    const player = createWebPlayerPort({ stream, audio, mediaSession: ms });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    await player.play({ handle: 'h-1', identity });
    audio.currentTime = 5;
    ms.actions.get('previoustrack')?.();
    const transition = events.find((e) => e.type === 'queue-transition');
    assert(
      transition !== undefined &&
        transition.type === 'queue-transition' &&
        transition.reason === 'remote-previous' &&
        transition.toOccurrenceId === 'occ-1' &&
        transition.identity !== null &&
        transition.identity.attemptId === 'attempt-1' &&
        transition.handle === 'h-1' &&
        transition.positionMs === 0,
      'remote-previous restarts the current stream',
    );
    assertEqual(audio.currentTime, 0);
  }

  // Tail of the queue: ended with no successor emits the null-target
  // transition the session reads as stopped.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    await player.setQueueProjection(
      twoItemProjection({
        items: [
          {
            occurrenceId: 'occ-1',
            provider: 'deezer',
            sourceRef: 't1',
            title: 'one',
            artist: null,
            artworkUrl: null,
          },
        ],
      }),
    );
    await player.play({ handle: 'h-1', identity });
    audio.fire('ended');
    await settle();
    const transition = events.find((e) => e.type === 'queue-transition');
    assert(
      transition !== undefined &&
        transition.type === 'queue-transition' &&
        transition.toOccurrenceId === null &&
        transition.identity === null &&
        transition.handle === null,
      'tail-off reports a null target',
    );
  }

  // A failed successor attach surfaces as a failed status — never an
  // illegal transition the session must reject.
  {
    const audio = fakeAudio();
    const stream = fakeStream({
      prepare: () =>
        Promise.resolve({
          type: 'failed',
          kind: 'transient',
          message: 'upstream 502',
        }),
    });
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    await player.play({ handle: 'h-1', identity });
    audio.fire('ended');
    await settle();
    assert(
      !events.some((e) => e.type === 'queue-transition'),
      'no transition on a failed attach',
    );
    const failed = events.findLast(
      (e) => e.type === 'status' && e.state === 'failed',
    );
    assert(
      failed !== undefined &&
        failed.type === 'status' &&
        failed.error?.kind === 'transient',
      'attach failure reports a failed status',
    );
  }

  // release drops the live element when the current handle dies.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio });
    collect(player);
    await player.play({ handle: 'h-1', identity });
    assert((await player.release({ handle: 'h-1', identity })).ok);
    assertEqual(audio.src, '');
    assert(
      stream.calls.some((c) => c.method === 'release'),
      'release reaches the host',
    );
  }

  // prepare returns its requestId immediately — the outcome arrives
  // later as a 'prepare' event, so a session deadline can cancel.
  {
    const audio = fakeAudio();
    let resolvePrepare:
      | ((o: PrepareOutcomePayload) => void)
      | undefined;
    const stream = fakeStream({
      prepare: () =>
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
    });
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    const res = await player.prepare({
      provider: 'deezer',
      sourceRef: 't1',
      identity,
    });
    assert(res.ok && res.value === 'wreq-1', 'requestId up front');
    assert(
      !events.some((e) => e.type === 'prepare'),
      'no outcome while the host resolves',
    );
    resolvePrepare?.({
      type: 'prepared',
      stream: { handle: 'h-1', mime: 'audio/mp4' },
    });
    await settle();
    const prepared = events.find((e) => e.type === 'prepare');
    assert(
      prepared !== undefined &&
        prepared.type === 'prepare' &&
        prepared.outcome.type === 'prepared' &&
        prepared.requestId === 'wreq-1',
      'outcome arrives as a prepare event',
    );
  }

  // An older play whose serveUrl resolves late must not retake the
  // element from a newer play that already attached.
  {
    const audio = fakeAudio();
    let resolveA: ((v: { url: string }) => void) | undefined;
    const stream = fakeStream({
      serveUrl: (args) => {
        const { handle } = args as { handle: string };
        if (handle === 'h-a') {
          return new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        return Promise.resolve({ url: `http://127.0.0.1:9/s/${handle}` });
      },
    });
    const player = createWebPlayerPort({ stream, audio });
    const pendingA = player.play({ handle: 'h-a', identity });
    await player.play({
      handle: 'h-b',
      identity: { ...identity, attemptId: 'a2' },
    });
    assertEqual(audio.src, 'http://127.0.0.1:9/s/h-b');
    resolveA?.({ url: 'http://127.0.0.1:9/s/h-a' });
    await pendingA;
    await settle();
    assertEqual(
      audio.src,
      'http://127.0.0.1:9/s/h-b',
      'stale play cannot clobber the live element',
    );
  }

  // A pause while play still awaits its serve URL must win — the late
  // completion must not start audio after pause already succeeded.
  {
    const audio = fakeAudio();
    let resolveA: ((v: { url: string }) => void) | undefined;
    const stream = fakeStream({
      serveUrl: (args) => {
        const { handle } = args as { handle: string };
        if (handle === 'h-a') {
          return new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        return Promise.resolve({ url: `http://127.0.0.1:9/s/${handle}` });
      },
    });
    const player = createWebPlayerPort({ stream, audio });
    const pendingA = player.play({ handle: 'h-a', identity });
    const paused = await player.pause(identity);
    assertEqual(paused.ok, true, 'pause succeeds while play is pending');
    resolveA?.({ url: 'http://127.0.0.1:9/s/h-a' });
    await pendingA;
    await settle();
    assertEqual(audio.src, '', 'late play cannot attach after pause');
    assertEqual(audio.paused, true, 'element stays paused');
    // A mismatched identity's pause does not invalidate the pending
    // play — the same contract `stale` applies to a live attempt.
    const identity2 = { ...identity, attemptId: 'other' };
    const pendingB = player.play({ handle: 'h-b', identity });
    await player.pause(identity2);
    resolveA?.({ url: 'http://127.0.0.1:9/s/h-a' });
    await pendingB;
    await settle();
    assertEqual(
      audio.src,
      'http://127.0.0.1:9/s/h-b',
      'stale-identity pause leaves the pending play alone',
    );
  }

  // A seek while play still awaits its serve URL must win — the late
  // completion applies the newest requested position, not the play's
  // captured one.
  {
    const audio = fakeAudio();
    let resolveA: ((v: { url: string }) => void) | undefined;
    const stream = fakeStream({
      serveUrl: (args) => {
        const { handle } = args as { handle: string };
        if (handle === 'h-a') {
          return new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        return Promise.resolve({ url: `http://127.0.0.1:9/s/${handle}` });
      },
    });
    const player = createWebPlayerPort({ stream, audio });
    const pendingA = player.play({
      handle: 'h-a',
      identity,
      positionMs: 10_000,
    });
    const seeked = await player.seekTo({ positionMs: 45_000, identity });
    assertEqual(seeked.ok, true, 'seek succeeds while play is pending');
    resolveA?.({ url: 'http://127.0.0.1:9/s/h-a' });
    await pendingA;
    await settle();
    assertEqual(
      audio.currentTime,
      45,
      'late play applies the newest seek position',
    );
  }

  // A media-key pause while play still awaits its serve URL must win —
  // it carries no identity, so it drops every pending play.
  {
    const audio = fakeAudio();
    const mediaSession = fakeMediaSession();
    let resolveA: ((v: { url: string }) => void) | undefined;
    const stream = fakeStream({
      serveUrl: (args) => {
        const { handle } = args as { handle: string };
        if (handle === 'h-a') {
          return new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        return Promise.resolve({ url: `http://127.0.0.1:9/s/${handle}` });
      },
    });
    const player = createWebPlayerPort({ stream, audio, mediaSession });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    const pendingA = player.play({ handle: 'h-a', identity });
    mediaSession.actions.get('pause')?.();
    resolveA?.({ url: 'http://127.0.0.1:9/s/h-a' });
    await pendingA;
    await settle();
    assertEqual(audio.src, '', 'late play cannot attach after media pause');
    assertEqual(audio.paused, true, 'element stays paused');
    // The killed attempt reports paused so the session reconciles —
    // play() resolving quietly would strand it in buffering.
    assert(
      events.some(
        (e) =>
          e.type === 'status' &&
          e.state === 'paused' &&
          e.identity.attemptId === identity.attemptId,
      ),
      'media pause reports the killed attempt paused',
    );
  }

  // The session re-keys the live attempt's queueRev on every queue
  // mutation — a seek issued under the newer revision while play is
  // still pending must land on that play's token.
  {
    const audio = fakeAudio();
    let resolveA: ((v: { url: string }) => void) | undefined;
    const stream = fakeStream({
      serveUrl: (args) => {
        const { handle } = args as { handle: string };
        if (handle === 'h-a') {
          return new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        return Promise.resolve({ url: `http://127.0.0.1:9/s/${handle}` });
      },
    });
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    const pendingA = player.play({ handle: 'h-a', identity });
    // Queue mutation bumps the revision — the same trigger that
    // re-keys `current` must move the pending play's token.
    await player.setQueueProjection(twoItemProjection({ queueRev: 5 }));
    const seeked = await player.seekTo({
      positionMs: 45_000,
      identity: { ...identity, queueRev: 5 },
    });
    assertEqual(seeked.ok, true, 're-keyed seek succeeds');
    resolveA?.({ url: 'http://127.0.0.1:9/s/h-a' });
    await pendingA;
    await settle();
    assertEqual(
      audio.currentTime,
      45,
      're-keyed seek position lands on the late play',
    );
    // And the attach carries the re-keyed revision, not the play's
    // captured one — every later control would read stale otherwise.
    assert(
      events.some(
        (e) =>
          e.type === 'status' &&
          e.identity.attemptId === identity.attemptId &&
          e.identity.queueRev === 5,
      ),
      'late play installs the re-keyed identity',
    );
    // Later controls under the new revision are honoured, not stale.
    assert(
      (await player.pause({ ...identity, queueRev: 5 })).ok,
      'pause under the re-keyed revision succeeds',
    );
  }

  // Two cursor moves in flight — the superseded attach releases its
  // handle and emits no transition.
  {
    const audio = fakeAudio();
    let resolveFirst:
      | ((o: PrepareOutcomePayload) => void)
      | undefined;
    const stream = fakeStream({
      prepare: (args) => {
        const { requestId } = args as { requestId: string };
        if (requestId === 'watt-1') {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          type: 'prepared',
          stream: { handle: 'h-2', mime: 'audio/mp4' },
        });
      },
    });
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    await player.play({ handle: 'h-1', identity });
    audio.fire('ended');
    audio.fire('ended');
    await settle();
    resolveFirst?.({
      type: 'prepared',
      stream: { handle: 'h-stale', mime: 'audio/mp4' },
    });
    await settle();
    const transitions = events.filter((e) => e.type === 'queue-transition');
    assertEqual(transitions.length, 1, 'one attach wins');
    assert(
      stream.calls.some(
        (c) =>
          c.method === 'release' &&
          (c.args as { handle: string }).handle === 'h-stale',
      ),
      'superseded attach releases its handle',
    );
    assertEqual(
      audio.src,
      'http://127.0.0.1:9/s/tok',
      'live attach owns the element',
    );
  }

  // serveUrl rejecting after a successful prepare releases the minted
  // handle — the registry never sees a leak.
  {
    const audio = fakeAudio();
    const stream = fakeStream({
      prepare: () =>
        Promise.resolve({
          type: 'prepared',
          stream: { handle: 'h-2', mime: 'audio/mp4' },
        }),
      serveUrl: (args) =>
        (args as { handle: string }).handle === 'h-2'
          ? Promise.reject({ kind: 'expired', message: 'gone' })
          : Promise.resolve({ url: 'http://127.0.0.1:9/s/tok' }),
    });
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    await player.play({ handle: 'h-1', identity });
    audio.fire('ended');
    await settle();
    assert(
      stream.calls.some(
        (c) =>
          c.method === 'release' &&
          (c.args as { handle: string }).handle === 'h-2',
      ),
      'post-attach failure releases the minted handle',
    );
    assert(
      !events.some((e) => e.type === 'queue-transition'),
      'no transition on a failed attach',
    );
  }

  // A stale attach's failed outcome must not emit `failed` on the
  // attempt that replaced it — the session would tear down live
  // playback on another op's verdict.
  {
    const audio = fakeAudio();
    let resolveFirst:
      | ((o: PrepareOutcomePayload) => void)
      | undefined;
    const stream = fakeStream({
      prepare: (args) => {
        const { requestId } = args as { requestId: string };
        if (requestId === 'watt-1') {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          type: 'prepared',
          stream: { handle: 'h-2', mime: 'audio/mp4' },
        });
      },
    });
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    await player.play({ handle: 'h-1', identity });
    audio.fire('ended');
    await settle();
    // A newer play supersedes the pending attach — its outcome belongs
    // to a dead op now.
    await player.play({
      handle: 'h-b',
      identity: { ...identity, attemptId: 'a2' },
    });
    events.length = 0;
    resolveFirst?.({
      type: 'failed',
      kind: 'transient',
      message: 'upstream wobble',
      attempt: {
        requestId: 'watt-1',
        steps: 0,
        httpCalls: 0,
        bytes: 0,
        fuelUsed: 0,
        elapsedMs: 0,
        httpTrace: [],
        guestLog: [],
      },
    });
    await settle();
    assert(
      !events.some((e) => e.type === 'status' && e.state === 'failed'),
      'stale attach failure never emits failed on the live stream',
    );
    assertEqual(
      audio.src,
      'http://127.0.0.1:9/s/tok',
      'live stream keeps the element',
    );
  }

  // Same-handle plays share a release marker: the stale play's own
  // settle must not clear the live play's token — a release landing
  // while it still waits invalidates it too.
  {
    const audio = fakeAudio();
    const resolvers: Array<(v: { url: string }) => void> = [];
    const stream = fakeStream({
      serveUrl: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    });
    const player = createWebPlayerPort({ stream, audio });
    const playA = player.play({ handle: 'h-1', identity });
    const playB = player.play({
      handle: 'h-1',
      identity: { ...identity, attemptId: 'a2' },
    });
    // A resolves first and is stale by generation; its cleanup must
    // leave B's marker alone.
    resolvers[0]?.({ url: 'http://127.0.0.1:9/s/h-1a' });
    await playA;
    await player.release({ handle: 'h-1', identity });
    resolvers[1]?.({ url: 'http://127.0.0.1:9/s/h-1b' });
    await playB;
    await settle();
    assertEqual(
      audio.src,
      '',
      'released pending play never attaches the element',
    );
  }

  // A live attach whose element start rejects must emit `failed` on
  // its own successor attempt — the transition already committed it,
  // so suppressing the failure strands an unusable stream.
  {
    const audio = fakeAudio();
    const stream = fakeStream({
      prepare: () =>
        Promise.resolve({
          type: 'prepared',
          stream: { handle: 'h-2', mime: 'audio/mp4' },
        }),
    });
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    await player.setQueueProjection(twoItemProjection());
    await player.play({ handle: 'h-1', identity });
    audio.play = () => Promise.reject(new Error('autoplay blocked'));
    audio.fire('ended');
    await settle();
    const failed = events.find(
      (e) => e.type === 'status' && e.state === 'failed',
    );
    assert(
      failed !== undefined && failed.type === 'status',
      'post-attach element failure emits failed',
    );
    if (failed !== undefined && failed.type === 'status') {
      assertEqual(
        failed.handle,
        'h-2',
        'failure labels the attached successor',
      );
    }
    // Roll the element back so the tail test below starts paused.
    audio.play = () => Promise.resolve();
  }

  // remote-next at the queue tail stops the element — a null target
  // while audio is live must not leave playback running.
  {
    const audio = fakeAudio();
    const mediaSession = fakeMediaSession();
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio, mediaSession });
    const events = collect(player);
    await player.setQueueProjection(
      twoItemProjection({
        items: [
          {
            occurrenceId: 'occ-1',
            provider: 'deezer',
            sourceRef: 't1',
            title: 'one',
            artist: null,
            artworkUrl: null,
          },
        ],
      }),
    );
    await player.play({ handle: 'h-1', identity });
    assert(!audio.paused, 'precondition: playing');
    mediaSession.actions.get('nexttrack')?.();
    await settle();
    const transition = events.find((e) => e.type === 'queue-transition');
    assert(
      transition !== undefined &&
        transition.type === 'queue-transition' &&
        transition.toOccurrenceId === null,
      'tail next emits the null target',
    );
    assertEqual(audio.src, '', 'element detached at the tail');
    assertEqual(mediaSession.playbackState, 'none');
  }

  // ---- MSE primary path -------------------------------------------------

  // play() prefers the byte pump: mime recorded at prepare, channel
  // invoked, element attaches the blob URL — serveUrl never called.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    const events = collect(player);
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playResult = player.play({ handle: 'h-1', identity });
    await settle(); // channel resolves → runSession's listener lands
    media.fireSourceopen();
    await settle();
    const res = await playResult;
    assert(res.ok, 'MSE-first play succeeds');
    assertEqual(audio.src, 'blob:fake-0', 'element attaches the blob URL');
    assert(
      stream.calls.some((c) => c.method === 'channel'),
      'stream:port channel invoked',
    );
    assert(
      !stream.calls.some((c) => c.method === 'serveUrl'),
      'loopback leg not used',
    );
    const playing = events.find(
      (e) => e.type === 'status' && e.state === 'playing',
    );
    assert(playing !== undefined, 'playing status emitted');
  }

  // A mime MSE can't take (or a refused attach) falls back to serveUrl.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(new FakeMedia(), { supported: () => false }),
    });
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    await player.play({ handle: 'h-1', identity });
    await settle();
    assertEqual(
      audio.src,
      'http://127.0.0.1:9/s/tok',
      'unsupported mime takes the loopback leg',
    );
    assert(
      !stream.calls.some((c) => c.method === 'channel'),
      'channel skipped for an unsupported mime',
    );
  }

  // A pump attach that never lands a segment still falls back.
  {
    const audio = fakeAudio();
    const stream = fakeStream({
      channel: () => Promise.reject(new Error('utility dead')),
    });
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(new FakeMedia()),
    });
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const res = await player.play({ handle: 'h-1', identity });
    await settle();
    assert(res.ok, 'attach failure is a fallback, not a play failure');
    assertEqual(audio.src, 'http://127.0.0.1:9/s/tok');
  }

  // seekTo routes through the MSE source while it owns the element.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playing = player.play({ handle: 'h-1', identity });
    await settle();
    media.fireSourceopen();
    await settle();
    await playing;
    // Evict the early media — a still-buffered target is an
    // element-only rewind with no pump traffic.
    const sb = media.buffer;
    assert(sb !== null);
    sb.buffered = { length: 1, start: () => 20, end: () => 30 };
    await player.seekTo({ positionMs: 5_000, identity });
    await settle();
    assert(
      port.sent.some((m) => (m as { kind?: string }).kind === 'seek'),
      'seek frame reached the pump',
    );
  }

  // A pump death AFTER the MSE source installed surfaces as a failed
  // status — the element's own error event never fires for a dead MSE
  // feed (a revoked blob URL does not detach the element).
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    const events = collect(player);
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playing = player.play({ handle: 'h-1', identity });
    await settle();
    media.fireSourceopen();
    await settle();
    await playing;
    port.feed({
      kind: 'error',
      epoch: 0,
      code: 'io-error',
      message: 'read died',
    });
    await settle();
    const failed = events.find(
      (e) => e.type === 'status' && e.state === 'failed',
    );
    assert(failed !== undefined, 'pump death emitted a failed status');
    assert(port.closed, 'dead session closed its port');
  }

  // A stop before the MSE attach settles aborts it directly — the
  // unresolved attach has no activeMse to drop, so without the
  // pending-attach registry its pump lease would outlive the dead op.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playing = player.play({ handle: 'h-1', identity });
    await settle();
    // No sourceopen, no feed — first.settle stays pending until the
    // abort settles it with MseAborted and play finishes quietly.
    await player.stop(identity);
    assert(port.closed, 'stop aborted the pending attach');
    assert((await playing).ok, 'aborted play resolves quietly');
  }

  // A new prepare supersedes the in-flight play op — the opGen bump
  // already kills its generation; its pending attach must die with
  // it or a stalled stream keeps its pump lease forever.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playing = player.play({ handle: 'h-1', identity });
    await settle();
    // Attach registered, settle pending — the next prepare kills it.
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:8',
      identity,
    });
    assert(port.closed, 'prepare aborted the pending attach');
    assert((await playing).ok, 'aborted play resolves quietly');
  }

  // An attachItem aborted mid-attach reaps the handle it minted — the
  // quiet-abort path can't leave the registry slot held forever, or
  // repeated supersessions cap the stream registry.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    collect(player);
    await player.setQueueProjection(twoItemProjection());
    // ended → attachItem prepares the successor (mints 'h-1') and
    // parks on its pending settle — channel resolved, nothing fed.
    audio.fire('ended');
    await settle();
    assert(port.closed === false, 'attach pump is live mid-attach');
    // A superseding prepare kills the op and its pending attach.
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:9',
      identity,
    });
    await settle();
    assert(port.closed, 'pump closed with the aborted attach');
    assert(
      stream.calls.some(
        (c) =>
          c.method === 'release' &&
          typeof c.args === 'object' &&
          c.args !== null &&
          (c.args as { handle?: string }).handle === 'h-1',
      ),
      'the minted-but-never-installed handle is released',
    );
  }

  // A resume position (or a seek issued while the attach was in
  // flight) must reach the MSE source after install — the pump always
  // opens at byte 0, so without the handoff the element waits on the
  // whole stream head downloading first.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playing = player.play({
      handle: 'h-1',
      identity,
      positionMs: 40_000,
    });
    await settle();
    media.fireSourceopen();
    await settle();
    await playing;
    assert(
      port.sent.some(
        (m) =>
          (m as { kind?: string }).kind === 'seek' &&
          (m as { epoch?: number }).epoch === 1,
      ),
      'initial position re-anchored the pump after install',
    );
  }

  // remote-previous restart routes through the MSE source — an
  // evicted track start must re-anchor the pump, not just the
  // element clock.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const ms = fakeMediaSession();
    const player = createWebPlayerPort({
      stream,
      audio,
      mediaSession: ms,
      mse: fakeMseFactories(media),
    });
    await player.setQueueProjection(twoItemProjection());
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playing = player.play({ handle: 'h-1', identity });
    await settle();
    media.fireSourceopen();
    await settle();
    await playing;
    // The track's start is no longer buffered — the restart must ask
    // the source for it, not just rewind the element.
    const sb = media.buffer;
    assert(sb !== null);
    sb.buffered = { length: 1, start: () => 20, end: () => 30 };
    port.sent.length = 0;
    ms.actions.get('previoustrack')?.();
    await settle();
    assert(
      port.sent.some(
        (m) =>
          (m as { kind?: string }).kind === 'seek' &&
          (m as { position?: number }).position === 0,
      ),
      'restart re-anchored the pump at byte 0',
    );
    assertEqual(audio.currentTime, 0);
  }

  // release destroys the live MSE source — its pump port closes.
  {
    const audio = fakeAudio();
    const port = new FakePort();
    const stream = fakeStream({
      channel: () => Promise.resolve(port),
    });
    const media = new FakeMedia();
    const player = createWebPlayerPort({
      stream,
      audio,
      mse: fakeMseFactories(media),
    });
    await player.prepare({
      provider: 'deezer',
      sourceRef: 'track:7',
      identity,
    });
    const playing = player.play({ handle: 'h-1', identity });
    await settle();
    media.fireSourceopen();
    await settle();
    await playing;
    await player.release({ handle: 'h-1', identity });
    assert(port.closed === true, 'release closed the pump port');
  }
}

// ---- MSE fakes ------------------------------------------------------------

/** The minimal webm fixture — one cluster, cues appended at the tail. */
function mseWebm(): Uint8Array {
  const el = (id: number[], payload: number[]): number[] => [
    ...id,
    0x80 + payload.length,
    ...payload,
  ];
  const head = el([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, 0x77]);
  const info = el(
    [0x15, 0x49, 0xa9, 0x66],
    el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
  );
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00, 0xaa]);
  const body = [...info, ...cluster];
  return new Uint8Array([
    ...head,
    ...[0x18, 0x53, 0x80, 0x67, 0x80 + body.length],
    ...body,
  ]);
}

class FakePort {
  sent: unknown[] = [];
  closed = false;
  private fed = false;
  private listeners = new Set<(m: unknown) => void>();
  send(message: unknown): void {
    this.sent.push(message);
    if (
      !this.fed &&
      (message as { kind?: string }).kind === 'grant'
    ) {
      // A real pump answers the first credit with bytes — re-grants
      // after that are the session's own credit refresh, not new reads.
      this.fed = true;
      const bytes = mseWebm();
      queueMicrotask(() => {
        this.feed({
          kind: 'data',
          position: 0,
          epoch: 0,
          bytes,
        });
        this.feed({ kind: 'eof', epoch: 0 });
      });
    }
  }
  onMessage(listener: (m: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
  }
  feed(frame: unknown): void {
    for (const l of [...this.listeners]) l(frame);
  }
}

class FakeMedia {
  readyState = 'closed';
  duration = 0;
  ended = false;
  buffer: FakeBuffer | null = null;
  private listeners = new Map<string, Array<() => void>>();
  addSourceBuffer(): FakeBuffer {
    this.buffer = new FakeBuffer();
    this.buffer.media = this;
    return this.buffer;
  }
  endOfStream(): void {
    this.ended = true;
    this.readyState = 'ended';
  }
  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fireSourceopen(): void {
    this.readyState = 'open';
    for (const l of this.listeners.get('sourceopen') ?? []) l();
  }
}

class FakeBuffer {
  updating = false;
  media: FakeMedia | null = null;
  buffered = {
    length: 0,
    start: () => 0,
    end: () => 0,
  };
  private listeners = new Map<string, Array<() => void>>();
  appendBuffer(): void {
    // An append on an ended source re-opens it (MSE spec).
    if (this.media !== null && this.media.readyState === 'ended') {
      this.media.ended = false;
      this.media.readyState = 'open';
      const media = this.media;
      queueMicrotask(() => media.fireSourceopen());
    }
    this.updating = true;
    this.buffered = { length: 1, start: () => 0, end: () => 30 };
    queueMicrotask(() => {
      this.updating = false;
      for (const l of this.listeners.get('updateend') ?? []) l();
    });
  }
  remove(): void {}
  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
}

function fakeMseFactories(
  media: FakeMedia,
  opts: {
    supported?: (mime: string) => boolean;
  } = {},
): {
  isTypeSupported: (mime: string) => boolean;
  createSource: () => FakeMedia;
  createObjectURL: () => string;
  revokeObjectURL: () => void;
} {
  let seq = 0;
  return {
    isTypeSupported: opts.supported ?? (() => true),
    createSource: () => media,
    createObjectURL: () => `blob:fake-${seq++}`,
    revokeObjectURL: () => undefined,
  } as {
    isTypeSupported: (mime: string) => boolean;
    createSource: () => FakeMedia;
    createObjectURL: () => string;
    revokeObjectURL: () => void;
  };
}
