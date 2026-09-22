import { assert, assertEqual } from '@auqw/application/testing';
import type { PlayerEvent, QueueProjection } from '@auqw/application';
import type { StreamClient } from './web-player.ts';
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

function collect(player: { subscribe(l: (e: PlayerEvent) => void): () => void }) {
  const events: PlayerEvent[] = [];
  player.subscribe((e) => events.push(e));
  return events;
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

  // ended → status ended + queue-transition 'ended' inside a projection.
  {
    const audio = fakeAudio();
    const stream = fakeStream();
    const player = createWebPlayerPort({ stream, audio });
    const events = collect(player);
    const projection: QueueProjection = {
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
    };
    assert((await player.setQueueProjection(projection)).ok);
    await player.play({ handle: 'h-1', identity });
    audio.fire('ended');
    const transition = events.find((e) => e.type === 'queue-transition');
    assert(
      transition !== undefined &&
        transition.type === 'queue-transition' &&
        transition.reason === 'ended' &&
        transition.fromOccurrenceId === 'occ-1' &&
        transition.toOccurrenceId === 'occ-2' &&
        transition.projectionId === 'proj-1',
      'ended advances the projection cursor',
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
    const remote = events2.find((e) => e.type === 'queue-transition');
    assert(
      remote !== undefined &&
        remote.type === 'queue-transition' &&
        remote.reason === 'remote-next' &&
        remote.toOccurrenceId === 'occ-2',
      'media-session next reports remote-next',
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
}
