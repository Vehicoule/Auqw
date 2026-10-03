import { QueueEngine } from './queue-engine.ts';
import type { QueueOccurrence, QueueOrigin } from '../domain.ts';
import { appError } from '../errors.ts';
import { assert, assertEqual, assertDeepEqual } from '../testing/assert.ts';

function occ(id: string, recording = 'r'): QueueOccurrence {
  return { occurrenceId: id, recordingId: recording, selectedRef: null };
}

function engineWith(ids: readonly string[]): QueueEngine {
  const engine = new QueueEngine();
  for (const id of ids) {
    engine.enqueue(occ(id));
  }
  return engine;
}

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function directTests(): void {
  // Constructor validation.
  const base = {
    revision: 0,
    occurrences: [occ('a')],
    currentOccurrenceId: 'a' as string | null,
    positionMs: 0,
    mode: 'paused' as const,
  };
  assert(
    throws(
      () =>
        new QueueEngine({
          ...base,
          occurrences: [occ('a'), occ('a')],
          currentOccurrenceId: 'a',
        }),
    ),
    'duplicate occurrence ids must throw',
  );
  assert(
    throws(() => new QueueEngine({ ...base, currentOccurrenceId: 'missing' })),
    'nonmember current must throw',
  );
  assert(
    throws(
      () =>
        new QueueEngine({
          revision: -1,
          occurrences: [],
          currentOccurrenceId: null,
          positionMs: 0,
          mode: 'stopped',
        }),
    ),
    'negative revision must throw',
  );

  // Illegal states: null current carries no position/mode/error.
  const idle = {
    revision: 0,
    occurrences: [occ('a')],
    currentOccurrenceId: null as string | null,
    positionMs: 0,
    mode: 'stopped' as const,
  };
  assert(
    throws(() => new QueueEngine({ ...idle, positionMs: 5 })),
    'null current with position must throw',
  );
  assert(
    throws(() => new QueueEngine({ ...idle, mode: 'paused' })),
    'null current with paused mode must throw',
  );
  assert(
    throws(
      () =>
        new QueueEngine({
          ...idle,
          blockedError: appError('transient', 'x'),
        }),
    ),
    'null current with blockedError must throw',
  );
  assert(
    throws(() => new QueueEngine({ ...base, mode: 'stopped' })),
    'selected occurrence cannot be stopped',
  );
  assert(
    throws(
      () =>
        new QueueEngine({
          ...base,
          mode: 'playing',
          blockedError: appError('transient', 'x'),
        }),
    ),
    'blockedError requires paused mode',
  );
  // Legal: selected + paused + blockedError restores a blocked queue.
  const legalBlocked = new QueueEngine({
    ...base,
    blockedError: appError('expired-resource', 'gone'),
  });
  assertEqual(legalBlocked.snapshot().blockedError?.kind, 'expired-resource');

  // The constructor's origin contract.
  assert(
    throws(
      () =>
        new QueueEngine({
          ...base,
          origin: { kind: 'search', query: 'q'.repeat(257) },
        }),
    ),
    'out-of-bounds origin must throw',
  );

  // setOrigin holds the same contract — a rejected stamp mutates
  // nothing, otherwise every later snapshot fails isQueueSnapshot.
  {
    const e = engineWith(['a']);
    const lib: QueueOrigin = { kind: 'library' };
    e.setOrigin(lib);
    assertDeepEqual(e.snapshot().origin, lib, 'the origin stamps');
    const rev = e.snapshot().revision;
    assert(
      throws(() => e.setOrigin({ kind: 'search', query: 'q'.repeat(257) })),
      'setOrigin rejects an out-of-bounds query',
    );
    assert(
      throws(
        () => e.setOrigin({ kind: 'nonsense' } as unknown as QueueOrigin),
      ),
      'setOrigin rejects an unknown kind',
    );
    assertDeepEqual(
      e.snapshot().origin,
      lib,
      'a rejected stamp leaves the stored origin untouched',
    );
    assertEqual(
      e.snapshot().revision,
      rev,
      'a rejected stamp does not tick',
    );
    e.setOrigin(undefined);
    assertEqual(
      e.snapshot().origin,
      undefined,
      'setOrigin(undefined) clears the stamp',
    );
  }

  // next selects once, stops at the end with no wrap.
  {
    const e = engineWith(['a', 'b']);
    e.select('a', true);
    e.next();
    assertEqual(e.snapshot().currentOccurrenceId, 'b');
    assertEqual(e.snapshot().mode, 'playing');
    e.next();
    assertEqual(e.snapshot().currentOccurrenceId, null);
    assertEqual(e.snapshot().positionMs, 0);
    assertEqual(e.snapshot().mode, 'stopped');
    const rev = e.snapshot().revision;
    e.next();
    assertEqual(e.snapshot().revision, rev, 'next past end is a no-op');
    assertEqual(e.snapshot().currentOccurrenceId, null, 'no wrap');
  }

  // previous: >3000ms restarts the current occurrence.
  {
    const e = engineWith(['a', 'b']);
    e.select('b', true);
    e.observePosition(4000);
    e.previous();
    assertEqual(e.snapshot().currentOccurrenceId, 'b');
    assertEqual(e.snapshot().positionMs, 0);
    e.observePosition(500);
    e.previous();
    assertEqual(e.snapshot().currentOccurrenceId, 'a');
    e.previous();
    assertEqual(e.snapshot().currentOccurrenceId, 'a', 'first stays first');
    assertEqual(e.snapshot().positionMs, 0);
    const rev = e.snapshot().revision;
    e.previous();
    assertEqual(
      e.snapshot().revision,
      rev,
      'previous at first with pos 0 is a no-op',
    );
  }

  // select is a true no-op when nothing would change.
  {
    const e = engineWith(['a']);
    e.select('a', false);
    const rev = e.snapshot().revision;
    e.select('a', false);
    assertEqual(e.snapshot().revision, rev, 'identical select is a no-op');
    e.select('a', true);
    assertEqual(e.snapshot().mode, 'playing', 'select still re-modes');
  }

  // remove current picks the post-removal successor, preserving mode.
  {
    const playing = engineWith(['a', 'b', 'c']);
    playing.select('b', true);
    playing.remove('b');
    assertEqual(playing.snapshot().currentOccurrenceId, 'c');
    assertEqual(playing.snapshot().mode, 'playing');

    const paused = engineWith(['a', 'b', 'c']);
    paused.select('b', false);
    paused.remove('b');
    assertEqual(paused.snapshot().currentOccurrenceId, 'c');
    assertEqual(paused.snapshot().mode, 'paused', 'paused removal never starts');

    const tail = engineWith(['a', 'b']);
    tail.select('b', true);
    tail.remove('b');
    assertEqual(tail.snapshot().currentOccurrenceId, null);
    assertEqual(tail.snapshot().mode, 'stopped');

    const other = engineWith(['a', 'b']);
    other.select('b', false);
    other.remove('a');
    assertEqual(other.snapshot().currentOccurrenceId, 'b');
    assertEqual(other.snapshot().occurrences.length, 1);
  }

  // clear drops every occurrence to the legal empty state — marks
  // and the blocked verdict go with the members.
  {
    const e = engineWith(['a', 'b', 'c']);
    e.select('b', true);
    e.markUnplayable(appError('expired-resource', 'gone'));
    e.clear();
    const snap = e.snapshot();
    assertEqual(snap.occurrences.length, 0);
    assertEqual(snap.currentOccurrenceId, null);
    assertEqual(snap.mode, 'stopped');
    assertEqual(snap.positionMs, 0);
    assertEqual(snap.blockedError, undefined);
    assertEqual(e.unplayableIds.size, 0, 'marks prune with members');
    const rev = snap.revision;
    e.clear();
    assertEqual(
      e.snapshot().revision,
      rev,
      'clear on empty is a no-op',
    );
  }

  // clearExceptCurrent keeps the cursor row playing — pending items
  // and history flush, marks prune to the survivor.
  {
    const e = engineWith(['a', 'b', 'c', 'd']);
    e.select('c', true);
    e.markUnplayable(appError('transient', 'skip me'));
    e.next(); // c stays marked behind the cursor; d lands paused
    e.play(); // resume — d is the playing current
    e.observePosition(900);
    e.clearExceptCurrent();
    const snap = e.snapshot();
    assertEqual(
      snap.occurrences.map((o) => o.occurrenceId).join(','),
      'd',
    );
    assertEqual(snap.currentOccurrenceId, 'd');
    assertEqual(snap.mode, 'playing');
    assertEqual(snap.positionMs, 900, 'position survives the flush');
    assertEqual(
      e.isUnplayable('c'),
      false,
      'a dropped row loses its mark',
    );
    const single = e.snapshot().revision;
    e.clearExceptCurrent();
    assertEqual(
      e.snapshot().revision,
      single,
      'one-item queue is a no-op',
    );
  }

  // clearExceptCurrent on a blocked current keeps the paused verdict
  // so the retry path still names its error; on a drained queue it
  // clears outright.
  {
    const blocked = engineWith(['a', 'b']);
    blocked.select('a', true);
    blocked.markUnplayable(appError('expired-resource', 'gone'));
    blocked.clearExceptCurrent();
    const snap = blocked.snapshot();
    assertEqual(snap.occurrences.length, 1);
    assertEqual(snap.mode, 'paused');
    assertEqual(snap.blockedError?.kind, 'expired-resource');
    assertEqual(blocked.isUnplayable('a'), true);

    const drained = engineWith(['a', 'b']);
    drained.select('a', true);
    drained.next();
    drained.next(); // cursor null — all pending
    drained.clearExceptCurrent();
    assertEqual(drained.snapshot().occurrences.length, 0);
    assertEqual(drained.snapshot().mode, 'stopped');
  }

  // move preserves current occurrence and position.
  {
    const e = engineWith(['a', 'b', 'c']);
    e.select('a', true);
    e.observePosition(1500);
    e.move('a', 2);
    assertEqual(e.snapshot().currentOccurrenceId, 'a');
    assertEqual(e.snapshot().positionMs, 1500);
    assertEqual(
      e.snapshot().occurrences.map((o) => o.occurrenceId).join(','),
      'b,c,a',
    );
    const rev = e.snapshot().revision;
    e.move('a', 2);
    assertEqual(e.snapshot().revision, rev, 'move to same index is a no-op');
  }

  // markUnplayable keeps current, pauses, records typed error; next clears.
  {
    const e = engineWith(['a', 'b']);
    e.select('a', true);
    e.markUnplayable(appError('expired-resource', 'gone'));
    assertEqual(e.snapshot().mode, 'paused');
    assertEqual(e.snapshot().currentOccurrenceId, 'a');
    assertEqual(e.snapshot().blockedError?.kind, 'expired-resource');
    const rev = e.snapshot().revision;
    e.markUnplayable(appError('expired-resource', 'gone'));
    assertEqual(e.snapshot().revision, rev, 'same blocked error is a no-op');
    e.markUnplayable(appError('transient', 'different'));
    assertEqual(e.snapshot().blockedError?.kind, 'transient');
    e.next();
    assertEqual(e.snapshot().currentOccurrenceId, 'b');
    assertEqual(e.snapshot().blockedError, undefined);
  }

  // markFailed records the same pause+verdict with NO forward-skip
  // flag — weather is not a reason to step over a playable row.
  {
    const e = engineWith(['a', 'b', 'c']);
    e.select('b', true);
    e.markFailed(appError('transient', 'weather'));
    const snap = e.snapshot();
    assertEqual(snap.mode, 'paused');
    assertEqual(snap.currentOccurrenceId, 'b');
    assertEqual(snap.blockedError?.kind, 'transient');
    assertEqual(e.isUnplayable('b'), false, 'no forward-skip flag');
    const rev = snap.revision;
    e.markFailed(appError('transient', 'weather'));
    assertEqual(e.snapshot().revision, rev, 'same blocked error is a no-op');
    e.previous();
    assertEqual(e.snapshot().currentOccurrenceId, 'a');
    e.next();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'b',
      'an unflagged failed row stays in the forward walk',
    );
    // The same-verdict dedupe is flag-aware: markUnplayable on the
    // same blocked error still flags instead of silently degrading.
    const f = engineWith(['x']);
    f.select('x', true);
    f.markFailed(appError('transient', 'weather'));
    f.markUnplayable(appError('transient', 'weather'));
    assertEqual(f.isUnplayable('x'), true, 'same verdict can escalate');
  }

  // fork() carries the session-scoped failed marks a snapshot
  // rebuild would drop; an explicit carry prunes non-members; a
  // bare snapshot rebuild (restore) intentionally starts clean.
  {
    const e = engineWith(['a', 'b', 'c']);
    e.select('a', true);
    e.markUnplayable(appError('expired-resource', 'gone'));
    e.next(); // a stays marked after the cursor moves on
    const draft = e.fork();
    assertEqual(draft.isUnplayable('a'), true, 'fork carries failed marks');
    draft.enqueue(occ('d'));
    assertEqual(draft.isUnplayable('a'), true, 'marks survive a draft edit');
    const bare = new QueueEngine(e.snapshot());
    assertEqual(
      bare.isUnplayable('a'),
      false,
      'snapshot round-trip starts unmarked',
    );
    const pruned = new QueueEngine(e.snapshot(), new Set(['a', 'ghost']));
    assertEqual(pruned.isUnplayable('a'), true);
    assertEqual(
      pruned.isUnplayable('ghost'),
      false,
      'carry prunes non-member ids',
    );
    assertEqual(pruned.unplayableIds.size, 1);
  }

  // observePosition never ticks; no current or identical position
  // is a no-op.
  {
    const e = engineWith(['a']);
    e.observePosition(100);
    assertEqual(e.snapshot().positionMs, 0, 'no current: position stays 0');
    assertEqual(e.snapshot().revision, 1, 'no current: no revision');
    e.select('a', false);
    const before = e.snapshot().revision;
    e.observePosition(100);
    assertEqual(e.snapshot().positionMs, 100);
    assertEqual(
      e.snapshot().revision,
      before,
      'observed ticks never change intent revision',
    );
    e.observePosition(100);
    assertEqual(e.snapshot().revision, before);

    // seekTo requires a current occurrence and ticks exactly once.
    e.seekTo(500);
    assertEqual(e.snapshot().positionMs, 500);
    assertEqual(e.snapshot().revision, before + 1, 'seek ticks once');
    e.seekTo(500);
    assertEqual(e.snapshot().revision, before + 1, 'same seek is a no-op');
    const idle = new QueueEngine();
    idle.seekTo(10);
    assertEqual(
      idle.snapshot().revision,
      0,
      'seek without current is a no-op',
    );
  }

  // setSelectedRef: identical is a no-op, otherwise replaces + ticks.
  {
    const e = engineWith(['a']);
    const ref = { provider: 'p', kind: 'track' as const, id: 'v1' };
    const rev0 = e.snapshot().revision;
    e.setSelectedRef('a', null);
    assertEqual(e.snapshot().revision, rev0, 'same ref is a no-op');
    e.setSelectedRef('a', ref);
    assertEqual(e.snapshot().revision, rev0 + 1);
    assertEqual(e.snapshot().occurrences[0]?.selectedRef?.id, 'v1');
    const rev1 = e.snapshot().revision;
    e.setSelectedRef('a', { ...ref });
    assertEqual(e.snapshot().revision, rev1, 'equal ref is a no-op');
    assert(
      throws(() => e.setSelectedRef('a', { ...ref, id: '' })),
      'invalid ref throws',
    );
  }

  // play() on a blocked item is the explicit Retry action.
  {
    const e = engineWith(['a']);
    e.select('a', false);
    e.markUnplayable(appError('expired-resource', 'gone'));
    e.play();
    assertEqual(e.snapshot().mode, 'playing');
    assertEqual(e.snapshot().blockedError, undefined);
    const rev = e.snapshot().revision;
    e.play();
    assertEqual(e.snapshot().revision, rev, 'play while playing is a no-op');
  }

  // restorePaused: paused with current, stopped without, clears errors.
  {
    const e = engineWith(['a']);
    e.select('a', false);
    e.markUnplayable(appError('transient', 'x'));
    e.restorePaused();
    assertEqual(e.snapshot().mode, 'paused');
    assertEqual(e.snapshot().blockedError, undefined);
    const rev = e.snapshot().revision;
    e.restorePaused();
    assertEqual(e.snapshot().revision, rev, 'clean restore is a no-op');
    const empty = new QueueEngine();
    empty.restorePaused();
    assertEqual(empty.snapshot().mode, 'stopped');
    assertEqual(empty.snapshot().revision, 0, 'no-op restore does not tick');
  }

  // play/pause only tick when they change state.
  {
    const e = engineWith(['a']);
    const rev0 = e.snapshot().revision;
    e.play();
    assertEqual(e.snapshot().revision, rev0, 'play with no current is a no-op');
    e.select('a', false);
    e.play();
    assertEqual(e.snapshot().mode, 'playing');
    e.pause();
    assertEqual(e.snapshot().mode, 'paused');
    const snap = e.snapshot();
    e.pause();
    assertEqual(
      e.snapshot().revision,
      snap.revision,
      'second pause is a no-op',
    );
  }

  // Indices must be safe integers when supplied.
  {
    const e = engineWith(['a']);
    assert(throws(() => e.enqueue(occ('b'), 1.5)), 'fractional index throws');
    assert(throws(() => e.move('a', Number.NaN)), 'NaN toIndex throws');
    assert(
      throws(() => e.move('a', Number.POSITIVE_INFINITY)),
      'infinite toIndex throws',
    );
  }

  // Revision saturates at MAX_SAFE_INTEGER atomically: the thrown
  // command leaves the whole snapshot identical.
  {
    const e = new QueueEngine({
      revision: Number.MAX_SAFE_INTEGER,
      occurrences: [occ('a')],
      currentOccurrenceId: 'a',
      positionMs: 12,
      mode: 'paused',
    });
    const before = e.snapshot();
    assert(throws(() => e.enqueue(occ('b'))), 'enqueue overflow throws');
    assertDeepEqual(e.snapshot(), before);
    assert(throws(() => e.select('a', true)), 'select overflow throws');
    assertDeepEqual(e.snapshot(), before);
    assert(throws(() => e.next()), 'next overflow throws');
    assertDeepEqual(e.snapshot(), before);
    assert(throws(() => e.previous()), 'previous overflow throws');
    assertDeepEqual(e.snapshot(), before);
    assert(throws(() => e.remove('a')), 'remove overflow throws');
    assertDeepEqual(e.snapshot(), before);
    assert(
      throws(() => e.setSelectedRef('a', { provider: 'p', kind: 'track', id: 'x' })),
      'setSelectedRef overflow throws',
    );
    assertDeepEqual(e.snapshot(), before);
    assert(throws(() => e.play()), 'play overflow throws');
    assertDeepEqual(e.snapshot(), before);
    assert(throws(() => e.seekTo(99)), 'seek overflow throws');
    assertDeepEqual(e.snapshot(), before);
    assert(
      throws(() => e.markUnplayable(appError('transient', 'x'))),
      'markUnplayable overflow throws',
    );
    assertDeepEqual(e.snapshot(), before);
    // A real move and a restorePaused need different shapes.
    const e2 = new QueueEngine({
      revision: Number.MAX_SAFE_INTEGER,
      occurrences: [occ('a'), occ('b')],
      currentOccurrenceId: 'a',
      positionMs: 0,
      mode: 'playing',
    });
    const before2 = e2.snapshot();
    assert(throws(() => e2.move('a', 1)), 'move overflow throws');
    assertDeepEqual(e2.snapshot(), before2);
    assert(throws(() => e2.pause()), 'pause overflow throws');
    assertDeepEqual(e2.snapshot(), before2);
    assert(throws(() => e2.restorePaused()), 'restore overflow throws');
    assertDeepEqual(e2.snapshot(), before2);
    e.observePosition(100); // observed positions still update
    assertEqual(e.snapshot().positionMs, 100);
  }

  // Deep snapshot immutability: mutating inputs/snapshots cannot
  // affect the engine.
  {
    const mutable = occ('a');
    const e = new QueueEngine();
    e.enqueue(mutable);
    const snap = e.snapshot();
    assert(Object.isFrozen(snap));
    assert(Object.isFrozen(snap.occurrences));
    assert(Object.isFrozen(snap.occurrences[0]));
    const input = { ...mutable, selectedRef: null };
    input.recordingId = 'mutated';
    assertEqual(
      e.snapshot().occurrences[0]?.recordingId,
      'r',
      'input mutation must not leak',
    );
    const withRef: QueueOccurrence = {
      occurrenceId: 'b',
      recordingId: 'r2',
      selectedRef: { provider: 'p', kind: 'track', id: 'i' },
    };
    e.enqueue(withRef);
    withRef.selectedRef = null;
    const s2 = e.snapshot();
    assertEqual(
      s2.occurrences[1]?.selectedRef?.id,
      'i',
      'ref mutation must not leak',
    );
    assert(Object.isFrozen(s2.occurrences[1]?.selectedRef));
  }

  // Duplicate recording ids remain independently addressable.
  {
    const e = new QueueEngine();
    e.enqueue(occ('x1', 'dup'));
    e.enqueue(occ('x2', 'dup'));
    e.select('x2', false);
    assertEqual(e.snapshot().currentOccurrenceId, 'x2');
    e.remove('x1');
    assertEqual(e.snapshot().currentOccurrenceId, 'x2');
  }

  // Failed occurrences keep a session mark: next() steps over them,
  // previous() still lands, a play-intent landing clears the mark,
  // and remove() prunes it so a fresh occurrence under the id isn't
  // skipped.
  {
    const e = new QueueEngine();
    for (const id of ['f1', 'f2', 'f3', 'f4']) {
      e.enqueue(occ(id, `r-${id}`));
    }
    const dead = appError('unavailable', 'dead');
    e.select('f1', true);
    e.next();
    e.markUnplayable(dead); // f2 fails → paused + blocked + flagged
    e.previous();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'f1',
      'explicit backward intent still lands on a live row',
    );
    e.next();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'f3',
      'next() steps over the flagged row instead of parking',
    );
    e.previous();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'f2',
      'previous() still honors a step back onto the failed row',
    );
    e.select('f2', true); // retry intent clears the mark
    e.next();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'f3',
      'a cleared mark lets next() land where it points',
    );
    e.markUnplayable(dead); // f3 fails
    e.select('f4', false); // a paused landing keeps the mark
    e.select('f1', false);
    e.next();
    assertEqual(e.snapshot().currentOccurrenceId, 'f2');
    e.next();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'f4',
      'the mark survives unflagged moves until a play clears it',
    );
    // Removing a flagged row prunes the mark — a re-enqueued
    // occurrence under the same id is a fresh entry.
    e.remove('f3');
    e.enqueue(occ('f3', 'r-f3')); // tail: [f1, f2, f4, f3]
    e.select('f1', true);
    e.next();
    e.next();
    e.next();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'f3',
      'a re-enqueued id carries no stale mark',
    );
    // play() on a blocked current is the retry path — it clears too.
    e.markUnplayable(dead); // f3 fails again
    e.select('f1', true);
    e.select('f3', false); // land paused — still flagged
    e.play(); // retry intent on the flagged current
    e.select('f1', false);
    e.next();
    assertEqual(e.snapshot().currentOccurrenceId, 'f2');
    e.next();
    assertEqual(e.snapshot().currentOccurrenceId, 'f4');
    e.next();
    assertEqual(
      e.snapshot().currentOccurrenceId,
      'f3',
      'play() cleared the mark like any play intent',
    );
  }
}

// Deterministic xorshift32.
function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function snapshotEqual(
  a: ReturnType<QueueEngine['snapshot']>,
  b: ReturnType<QueueEngine['snapshot']>,
): boolean {
  try {
    assertDeepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function propertyHarness(): void {
  const COMMANDS = 10;
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = xorshift32(seed);
    const engine = new QueueEngine();
    let counter = 0;
    const pickId = (): string | null => {
      const occurrences = engine.snapshot().occurrences;
      if (occurrences.length === 0) {
        return null;
      }
      return occurrences[rand() % occurrences.length]?.occurrenceId ?? null;
    };

    for (let step = 0; step < 300; step += 1) {
      const before = engine.snapshot();
      const cmd = rand() % COMMANDS;
      const id = pickId();
      const currentBefore = before.currentOccurrenceId;
      const positionBefore = before.positionMs;

      switch (cmd) {
        case 0: {
          counter += 1;
          engine.enqueue(
            occ(`o${counter}`, `r${counter % 3}`),
            rand() % (before.occurrences.length + 1),
          );
          break;
        }
        case 1:
          if (id !== null) {
            engine.select(id, rand() % 2 === 0);
          }
          break;
        case 2:
          engine.next();
          break;
        case 3:
          engine.previous();
          break;
        case 4:
          if (id !== null) {
            engine.remove(id);
          }
          break;
        case 5:
          if (id !== null) {
            engine.move(id, (rand() % 12) - 2);
          }
          break;
        case 6:
          engine.play();
          break;
        case 7:
          engine.pause();
          break;
        case 8:
          engine.observePosition(rand() % 10_000);
          break;
        case 9:
          engine.markUnplayable(appError('transient', 'x'));
          break;
        default:
          break;
      }

      const after = engine.snapshot();

      // Unique occurrence ids.
      const ids = after.occurrences.map((o) => o.occurrenceId);
      assertEqual(
        new Set(ids).size,
        ids.length,
        `seed ${seed} step ${step}: duplicate occurrence ids`,
      );

      // Current is null or a member.
      if (after.currentOccurrenceId !== null) {
        assert(
          ids.includes(after.currentOccurrenceId),
          `seed ${seed} step ${step}: current not a member`,
        );
      }

      // Legal states: null current carries no position/mode/error;
      // a blocked error implies current + paused.
      if (after.currentOccurrenceId === null) {
        assertEqual(after.positionMs, 0, 'null current must have pos 0');
        assertEqual(after.mode, 'stopped', 'null current must be stopped');
        assertEqual(
          after.blockedError,
          undefined,
          'null current must not be blocked',
        );
      }
      if (after.blockedError !== undefined) {
        assert(after.currentOccurrenceId !== null, 'blocked needs current');
        assertEqual(after.mode, 'paused', 'blocked must be paused');
      }

      // Safe nonnegative revision/position; revision moves by 0 or 1.
      assert(Number.isSafeInteger(after.revision) && after.revision >= 0);
      assert(Number.isSafeInteger(after.positionMs) && after.positionMs >= 0);
      assert(
        after.revision === before.revision ||
        after.revision === before.revision + 1,
        `seed ${seed} step ${step}: revision jumped`,
      );

      // An unchanged full snapshot means an unchanged revision.
      if (snapshotEqual(before, after)) {
        assertEqual(
          after.revision,
          before.revision,
          `seed ${seed} step ${step}: identical snapshot changed revision`,
        );
      }

      // Paused edits never become playing unless the command was
      // play() or select(autoplay).
      if (before.mode === 'paused' && after.mode === 'playing') {
        assert(
          cmd === 6 || cmd === 1,
          `seed ${seed} step ${step}: paused -> playing via cmd ${cmd}`,
        );
      }

      // move never changes current id or position.
      if (cmd === 5 && id !== null) {
        assertEqual(
          after.currentOccurrenceId,
          currentBefore,
          `seed ${seed} step ${step}: move changed current`,
        );
        assertEqual(
          after.positionMs,
          positionBefore,
          `seed ${seed} step ${step}: move changed position`,
        );
      }
    }
  }
}

export function run(): void {
  directTests();
  propertyHarness();
}
