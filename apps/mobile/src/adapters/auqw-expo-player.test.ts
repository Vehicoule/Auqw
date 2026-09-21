import type {
  AttemptTrace,
  PlayerEvent,
  QueueProjection,
} from '@auqw/application';
import { assert, assertDeepEqual, assertEqual } from '@auqw/application/testing';
import type {
  AuqwExpoPhaseMarkEvent,
  AuqwExpoPlaybackStatusEvent,
  AuqwExpoPlayerLike,
  AuqwExpoPrepareOutcomeEvent,
  AuqwExpoQueueTransitionEvent,
  AuqwExpoSubscription,
} from './auqw-expo-surface.ts';
import { createAuqwExpoPlayer } from './auqw-expo-player.ts';

const IDENTITY = { attemptId: 'att-1', queueRev: 3 };

function trace(requestId: string): AttemptTrace {
  return {
    requestId,
    steps: 2,
    httpCalls: 1,
    bytes: 64,
    fuelUsed: 10,
    elapsedMs: 20,
    httpTrace: [
      {
        method: 'GET',
        url: 'https://redacted.example/path',
        status: 200,
        bytes: 64,
        elapsedMs: 5,
      },
    ],
    guestLog: [{ level: 'info', message: 'done' }],
  };
}

class FakePlayerModule implements AuqwExpoPlayerLike {
  calls: { method: string; args: readonly unknown[] }[] = [];
  failures = new Map<string, unknown>();
  removals = 0;
  #listeners = new Map<string, Set<(event: never) => void>>();

  #call<T>(method: string, args: readonly unknown[], result: T): Promise<T> {
    this.calls.push({ method, args });
    if (this.failures.has(method)) {
      return Promise.reject(this.failures.get(method));
    }
    return Promise.resolve(result);
  }

  prepare(
    provider: string,
    sourceRef: string,
    attemptId: string,
    queueRev: number,
  ): Promise<string> {
    return this.#call(
      'prepare',
      [provider, sourceRef, attemptId, queueRev],
      'req-1',
    );
  }

  prepareLocal(path: string, mime?: string | null): Promise<string> {
    return this.#call('prepareLocal', [path, mime ?? null], 'lf-1');
  }

  play(
    handle: string,
    attemptId: string,
    queueRev: number,
    positionMs?: number,
  ): Promise<void> {
    return this.#call(
      'play',
      [handle, attemptId, queueRev, positionMs],
      undefined,
    );
  }

  pause(): Promise<void> {
    return this.#call('pause', [], undefined);
  }

  seekTo(positionMs: number): Promise<void> {
    return this.#call('seekTo', [positionMs], undefined);
  }

  stop(): Promise<void> {
    return this.#call('stop', [], undefined);
  }

  cancelPrepare(requestId: string): Promise<void> {
    return this.#call('cancelPrepare', [requestId], undefined);
  }

  releaseStream(handle: string): Promise<void> {
    return this.#call('releaseStream', [handle], undefined);
  }

  setQueueProjection(projection: QueueProjection): Promise<void> {
    return this.#call('setQueueProjection', [projection], undefined);
  }

  #listen(
    channel: string,
    listener: (event: never) => void,
  ): AuqwExpoSubscription {
    let set = this.#listeners.get(channel);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(channel, set);
    }
    set.add(listener);
    return {
      remove: () => {
        set.delete(listener);
        this.removals += 1;
      },
    };
  }

  addPrepareOutcomeListener(
    listener: (event: AuqwExpoPrepareOutcomeEvent) => void,
  ): AuqwExpoSubscription {
    return this.#listen('prepare', listener);
  }

  addPlaybackStatusListener(
    listener: (event: AuqwExpoPlaybackStatusEvent) => void,
  ): AuqwExpoSubscription {
    return this.#listen('status', listener);
  }

  addPhaseMarkListener(
    listener: (event: AuqwExpoPhaseMarkEvent) => void,
  ): AuqwExpoSubscription {
    return this.#listen('phase', listener);
  }

  addQueueTransitionListener(
    listener: (event: AuqwExpoQueueTransitionEvent) => void,
  ): AuqwExpoSubscription {
    return this.#listen('transition', listener);
  }

  emitPrepare(event: AuqwExpoPrepareOutcomeEvent): void {
    this.#emit('prepare', event);
  }

  emitStatus(event: AuqwExpoPlaybackStatusEvent): void {
    this.#emit('status', event);
  }

  emitPhase(event: AuqwExpoPhaseMarkEvent): void {
    this.#emit('phase', event);
  }

  emitTransition(event: AuqwExpoQueueTransitionEvent): void {
    this.#emit('transition', event);
  }

  listenerCount(channel: string): number {
    return this.#listeners.get(channel)?.size ?? 0;
  }

  #emit(channel: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(channel) ?? [])]) {
      (listener as (e: unknown) => void)(event);
    }
  }
}

function collect(player: ReturnType<typeof createAuqwExpoPlayer>): {
  events: PlayerEvent[];
  unsubscribe: () => void;
} {
  const events: PlayerEvent[] = [];
  const unsubscribe = player.subscribe((event) => events.push(event));
  return { events, unsubscribe };
}

// 1. Every method forwards arguments and resolves ok.
async function methodForwarding(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const prepared = await player.prepare({
    provider: 'youtube-music',
    sourceRef: 'vid12345678',
    identity: IDENTITY,
  });
  assert(prepared.ok && prepared.value === 'req-1', 'prepare resolves id');
  assertDeepEqual(module.calls[0]?.args, [
    'youtube-music',
    'vid12345678',
    'att-1',
    3,
  ]);
  assert(
    (
      await player.play({
        handle: 'h1',
        identity: IDENTITY,
        positionMs: 500,
      })
    ).ok,
  );
  assertDeepEqual(module.calls[1]?.args, ['h1', 'att-1', 3, 500]);
  assert((await player.pause(IDENTITY)).ok);
  assert((await player.seekTo({ positionMs: 100, identity: IDENTITY })).ok);
  assertDeepEqual(module.calls[3]?.args, [100]);
  assert((await player.stop(IDENTITY)).ok);
  assert(
    (await player.cancelPrepare({ requestId: 'r9', identity: IDENTITY }))
      .ok,
  );
  assertDeepEqual(module.calls[5]?.args, ['r9']);
  assert((await player.release({ handle: 'h1', identity: IDENTITY })).ok);
  assertDeepEqual(module.calls[6]?.args, ['h1']);
  const projection: QueueProjection = {
    projectionId: 'p1',
    queueRev: 4,
    currentOccurrenceId: 'o1',
    positionMs: 0,
    mode: 'playing',
    items: [
      {
        occurrenceId: 'o1',
        provider: 'youtube-music',
        sourceRef: 'vid12345678',
        title: 'T',
        artist: 'A',
        artworkUrl: null,
      },
    ],
  };
  assert((await player.setQueueProjection(projection)).ok);
  assertDeepEqual(module.calls[7]?.args[0], projection);
}

// 2. Every method maps native rejections to typed errors, never throws.
async function rejectionWrapping(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const methods: readonly {
    name: string;
    invoke: () => Promise<{ ok: boolean }>;
  }[] = [
      {
        name: 'prepare',
        invoke: () =>
          player.prepare({
            provider: 'p',
            sourceRef: 's',
            identity: IDENTITY,
          }),
      },
      {
        name: 'play',
        invoke: () => player.play({ handle: 'h', identity: IDENTITY }),
      },
      { name: 'pause', invoke: () => player.pause(IDENTITY) },
      {
        name: 'seekTo',
        invoke: () => player.seekTo({ positionMs: 0, identity: IDENTITY }),
      },
      { name: 'stop', invoke: () => player.stop(IDENTITY) },
      {
        name: 'cancelPrepare',
        invoke: () =>
          player.cancelPrepare({ requestId: 'r', identity: IDENTITY }),
      },
      {
        name: 'releaseStream',
        invoke: () => player.release({ handle: 'h', identity: IDENTITY }),
      },
      {
        name: 'setQueueProjection',
        invoke: () =>
          player.setQueueProjection({
            projectionId: 'p',
            queueRev: 0,
            currentOccurrenceId: null,
            positionMs: 0,
            mode: 'stopped',
            items: [],
          }),
      },
    ];
  for (const { name, invoke } of methods) {
    module.failures.set(name, new Error(`${name} blew up`));
    const result = await invoke();
    assert(!result.ok, `${name} rejection is a typed error`);
    module.failures.delete(name);
  }
}

// 3. Kind mapping: coded rejections map to taxonomy kinds; seam-only
// kinds (released/superseded/evicted/expired/not-found) survive as
// their legal app kinds; unknowns degrade to internal.
async function kindMapping(): Promise<void> {
  const cases: readonly (readonly [string, unknown, string])[] = [
    ['released', { kind: 'released' }, 'released'],
    ['superseded', { kind: 'superseded' }, 'superseded'],
    ['evicted', { kind: 'evicted' }, 'evicted'],
    ['expired', { kind: 'expired' }, 'expired'],
    ['not-found', { kind: 'not-found' }, 'not-found'],
    ['streams-capped', { kind: 'streams-capped' }, 'streams-capped'],
    ['transient', { kind: 'transient' }, 'transient'],
    ['rate-limit', { kind: 'rate-limit' }, 'rate-limit'],
    ['cancelled', { kind: 'cancelled' }, 'cancelled'],
    ['unknown-kind', { kind: 'weird' }, 'internal'],
    ['plain Error', new Error('boom'), 'internal'],
    ['coded Error', Object.assign(new Error('b'), { code: 'expired' }), 'expired'],
    ['non-error thrown', 'a string', 'internal'],
    ['null thrown', null, 'internal'],
  ];
  for (const [name, thrown, expected] of cases) {
    const module = new FakePlayerModule();
    module.failures.set('pause', thrown);
    const player = createAuqwExpoPlayer(module);
    const result = await player.pause(IDENTITY);
    assert(!result.ok, `${name} is an error`);
    assertEqual(result.error.kind, expected, `${name} kind`);
    assertEqual(
      typeof result.error.message === 'string' &&
      result.error.message.length > 0,
      true,
      `${name} message`,
    );
  }
}

// 4. Prepare events: prepared + failed, identity echoed intact.
async function prepareEvents(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  module.emitPrepare({
    requestId: 'r1',
    attemptId: 'att-x',
    queueRev: 7,
    outcome: {
      type: 'prepared',
      stream: {
        handle: 'h1',
        mime: 'audio/mp4',
        itag: 140,
        contentLength: 1024,
        expiresAtMs: 999,
        bitrateKbps: 128,
      },
      attempt: trace('r1'),
    },
  });
  assertEqual(events.length, 1);
  const prepared = events[0];
  assert(prepared?.type === 'prepare', 'prepare event type');
  assertEqual(prepared.requestId, 'r1');
  assertDeepEqual(prepared.identity, { attemptId: 'att-x', queueRev: 7 });
  assert(prepared.outcome.type === 'prepared');
  assertEqual(prepared.outcome.stream.handle, 'h1');
  assertEqual(prepared.outcome.stream.itag, 140);
  assertDeepEqual(prepared.outcome.attempt, trace('r1'));

  module.emitPrepare({
    requestId: 'r2',
    attemptId: 'att-x',
    queueRev: 8,
    outcome: {
      type: 'failed',
      kind: 'superseded',
      message: 'newer attempt',
      attempt: trace('r2'),
    },
  });
  assertEqual(events.length, 2);
  const failed = events[1];
  assert(failed?.type === 'prepare' && failed.outcome.type === 'failed');
  assertEqual(failed.outcome.error.kind, 'superseded');
  assertEqual(failed.outcome.error.message, 'newer attempt');

  // A prepared outcome with a malformed stream becomes a typed
  // failure rather than a corrupt event.
  module.emitPrepare({
    requestId: 'r3',
    attemptId: 'att-x',
    queueRev: 8,
    outcome: {
      type: 'prepared',
      stream: { handle: '', mime: 'audio/mp4' },
      attempt: trace('r3'),
    },
  });
  assertEqual(events.length, 3);
  const malformed = events[2];
  assert(malformed?.type === 'prepare' && malformed.outcome.type === 'failed');
  assertEqual(malformed.outcome.error.kind, 'invalid-response');
}

// 5. Status events: all states, identity echoed, error mapped.
async function statusEvents(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  const states = [
    'idle',
    'buffering',
    'ready',
    'playing',
    'paused',
    'ended',
    'failed',
  ] as const;
  for (const [index, state] of states.entries()) {
    module.emitStatus({
      handle: 'h1',
      attemptId: 'att-s',
      queueRev: index,
      state,
      positionMs: index * 100,
      ...(state === 'playing' ? { durationMs: 200_000 } : {}),
      ...(state === 'failed'
        ? { error: { kind: 'evicted', message: 'cache evicted' } }
        : {}),
    });
  }
  assertEqual(events.length, states.length);
  for (const [index, state] of states.entries()) {
    const event = events[index];
    assert(event?.type === 'status', `status ${state}`);
    assertEqual(event.state, state);
    assertEqual(event.positionMs, index * 100);
    assertDeepEqual(event.identity, { attemptId: 'att-s', queueRev: index });
  }
  assertEqual(events[3]?.type === 'status' && events[3].durationMs, 200_000);
  const failed = events[6];
  assert(failed?.type === 'status' && failed.error !== undefined);
  assertEqual(failed.error.kind, 'evicted');
  assertEqual(failed.error.message, 'cache evicted');
}

// 6. Phase marks map with identity echo.
async function phaseEvents(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  module.emitPhase({
    handle: 'h1',
    attemptId: 'att-p',
    queueRev: 11,
    name: 'firstByte',
    atMs: 1_700_000_000_000,
    sinceStartMs: 42,
  });
  assertEqual(events.length, 1);
  const event = events[0];
  assert(event?.type === 'phase');
  assertDeepEqual(event.identity, { attemptId: 'att-p', queueRev: 11 });
  assertEqual(event.name, 'firstByte');
  assertEqual(event.atMs, 1_700_000_000_000);
  assertEqual(event.sinceStartMs, 42);
}

// 7. Queue transitions pass through with identity preserved.
async function transitionEvents(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  module.emitTransition({
    projectionId: 'proj-1',
    projectedQueueRev: 9,
    fromOccurrenceId: 'o1',
    toOccurrenceId: 'o2',
    reason: 'ended',
    positionMs: 0,
    identity: { attemptId: 'att-n', queueRev: 9 },
    handle: 'h2',
  });
  assertEqual(events.length, 1);
  const event = events[0];
  assert(event?.type === 'queue-transition');
  assertEqual(event.projectionId, 'proj-1');
  assertEqual(event.projectedQueueRev, 9);
  assertEqual(event.fromOccurrenceId, 'o1');
  assertEqual(event.toOccurrenceId, 'o2');
  assertEqual(event.reason, 'ended');
  assertDeepEqual(event.identity, { attemptId: 'att-n', queueRev: 9 });
  assertEqual(event.handle, 'h2');

  module.emitTransition({
    projectionId: 'proj-1',
    projectedQueueRev: 9,
    fromOccurrenceId: 'o2',
    toOccurrenceId: null,
    reason: 'remote-next',
    positionMs: 0,
    identity: null,
    handle: null,
  });
  assertEqual(events.length, 2);
  const tail = events[1];
  assert(tail?.type === 'queue-transition');
  assertEqual(tail.toOccurrenceId, null);
  assertEqual(tail.identity, null);
  assertEqual(tail.handle, null);
}

// 8. Malformed events are dropped, never synthesized.
async function malformedEventsDropped(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  module.emitStatus({
    handle: 'h1',
    attemptId: '',
    queueRev: 1,
    state: 'playing',
    positionMs: 0,
  });
  module.emitStatus({
    handle: 'h1',
    attemptId: 'a',
    queueRev: 1,
    state: 'bogus' as never,
    positionMs: 0,
  });
  module.emitStatus({
    handle: 'h1',
    attemptId: 'a',
    queueRev: 1,
    state: 'playing',
    positionMs: -1,
  });
  module.emitPrepare({
    requestId: 'r1',
    attemptId: 'a',
    queueRev: 1,
    outcome: { type: 'bogus' } as never,
  });
  module.emitTransition({
    projectionId: 'p',
    projectedQueueRev: 1,
    fromOccurrenceId: 'o',
    toOccurrenceId: null,
    reason: 'bogus' as never,
    positionMs: 0,
    identity: null,
    handle: null,
  });
  module.emitPhase({
    handle: 'h',
    attemptId: 'a',
    queueRev: 1,
    name: '',
    atMs: 1,
    sinceStartMs: 1,
  });
  assertEqual(events.length, 0, 'all malformed events dropped');
}

// 9. Subscribe attaches all four listeners once; unsubscribe removes.
async function subscribeLifecycle(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { unsubscribe } = collect(player);
  assertEqual(module.listenerCount('prepare'), 1);
  assertEqual(module.listenerCount('status'), 1);
  assertEqual(module.listenerCount('phase'), 1);
  assertEqual(module.listenerCount('transition'), 1);
  const second = collect(player);
  assertEqual(module.listenerCount('status'), 1, 'still one native sub');
  module.emitStatus({
    handle: 'h',
    attemptId: 'a',
    queueRev: 1,
    state: 'playing',
    positionMs: 0,
  });
  assertEqual(second.events.length, 1, 'fan-out to both subscribers');
  second.unsubscribe();
  unsubscribe();
  assertEqual(module.removals, 4, 'all four native subs removed');
  assertEqual(module.listenerCount('status'), 0);
  // Double-unsubscribe is a no-op.
  unsubscribe();
  assertEqual(module.removals, 4);
}

// 10. provider:'local' prepares bypass the plugin host: prepareLocal
// mints the handle, the synthesized prepared outcome carries it, and
// cancelPrepare on the local request id never reaches the module.
async function localPreparePath(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  const requestId = await player.prepare({
    provider: 'local',
    sourceRef: 'file:///data/dl-1',
    identity: IDENTITY,
  });
  assert(requestId.ok, 'local prepare resolves');
  assertDeepEqual(module.calls[0]?.method, 'prepareLocal');
  assertDeepEqual(module.calls[0]?.args, ['file:///data/dl-1', null]);
  const prepared = events[0];
  assert(
    prepared !== undefined &&
      prepared.type === 'prepare' &&
      prepared.outcome.type === 'prepared' &&
      prepared.outcome.stream.handle === 'lf-1',
    'synthesized prepared outcome carries lf handle',
  );
  assert(
    (
      await player.play({
        handle: 'lf-1',
        identity: IDENTITY,
        positionMs: 0,
      })
    ).ok,
  );
  assert(
    (
      await player.cancelPrepare({
        requestId: requestId.value,
        identity: IDENTITY,
      })
    ).ok,
    'local cancelPrepare is a no-op',
  );
  assert(
    module.calls.every((c) => c.method !== 'cancelPrepare'),
    'cancelPrepare never reached the module',
  );
}

// 11. A bad local sourceRef emits a failed outcome, never throws.
async function localPrepareBadRef(): Promise<void> {
  const module = new FakePlayerModule();
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  const requestId = await player.prepare({
    provider: 'local',
    sourceRef: '',
    identity: IDENTITY,
  });
  assert(requestId.ok, 'prepare still resolves a request id');
  const failed = events[0];
  assert(
    failed !== undefined &&
      failed.type === 'prepare' &&
      failed.outcome.type === 'failed' &&
      failed.outcome.error.kind === 'invalid-response',
    'bad local ref reports failed outcome',
  );
  assert(module.calls.length === 0, 'no native call for bad ref');
}

// 12. prepareLocal rejection emits a failed outcome, typed error.
async function localPrepareFailure(): Promise<void> {
  const module = new FakePlayerModule();
  module.failures.set('prepareLocal', new Error('ENOENT'));
  const player = createAuqwExpoPlayer(module);
  const { events } = collect(player);
  const requestId = await player.prepare({
    provider: 'local',
    sourceRef: 'file:///gone.mp3',
    identity: IDENTITY,
  });
  assert(requestId.ok, 'prepare still resolves a request id');
  const failed = events[0];
  assert(
    failed !== undefined &&
      failed.type === 'prepare' &&
      failed.outcome.type === 'failed',
    'prepareLocal rejection reports failed outcome',
  );
}

const TESTS: readonly (readonly [string, () => Promise<void>])[] = [
  ['methodForwarding', methodForwarding],
  ['rejectionWrapping', rejectionWrapping],
  ['kindMapping', kindMapping],
  ['prepareEvents', prepareEvents],
  ['statusEvents', statusEvents],
  ['phaseEvents', phaseEvents],
  ['transitionEvents', transitionEvents],
  ['malformedEventsDropped', malformedEventsDropped],
  ['subscribeLifecycle', subscribeLifecycle],
  ['localPreparePath', localPreparePath],
  ['localPrepareBadRef', localPrepareBadRef],
  ['localPrepareFailure', localPrepareFailure],
];

export async function run(): Promise<void> {
  for (const [name, fn] of TESTS) {
    try {
      await fn();
    } catch (thrown) {
      throw new Error(`auqw-expo-player test failed: ${name}`, {
        cause: thrown,
      });
    }
  }
}
