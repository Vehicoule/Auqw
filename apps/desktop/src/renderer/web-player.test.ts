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
  return {
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
      Promise.resolve({ resolveMs: 5, mintMs: 8, attachMs: 20 }),
    cancel: (args) => {
      record('cancel')(args);
      return Promise.resolve(undefined);
    },
    ...overrides,
  };
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
}
