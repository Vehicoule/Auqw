import { CancellationSource } from '../cancellation.ts';
import type { Result } from '../errors.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import type {
  QueueOccurrence,
  Recording,
  SourceRef,
} from '../domain.ts';
import { isSourceRef, LOCAL_PROVIDER } from '../domain.ts';
import type {
  ProviderPort,
  RadioPage,
  RadioSeed,
} from '../ports/provider.ts';
import type { ProviderRouter } from '../providers/provider-router.ts';
import type { IdPort } from '../ports/runtime.ts';
import type {
  StorageBatch,
  StoragePort,
} from '../ports/storage.ts';
import { QueueEngine } from '../queue/queue-engine.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import {
  isRadioPage,
  planRadioPage,
  remainingAfterCurrent,
  shouldGrowRadio,
  RADIO_DRAIN_CHASE_PAGES,
  RADIO_FETCH_AHEAD,
} from '../queue/radio-tail.ts';
import type { RadioTailRecord } from '../queue/radio-tail.ts';
import { emissionWrites } from '../sync/sync-projection.ts';
import { Serializer } from './serializer.ts';
import type { Ready, SessionHostCore } from './ready.ts';
import { syncEmitInput } from './ready.ts';
import { internalError, supersededError } from './util.ts';

/** The radio coordinator's per-service seams over SessionHostCore. */
export type RadioHost = SessionHostCore & {
  /** The dealt play order under shuffle — null when off. */
  readonly dealtOrder: (r: Ready) => readonly string[] | null;
  readonly isOnline: () => boolean;
  readonly localPlaybackFor: (recordingId: string) => string | null;
  /**
   * The live play attempt, narrowed to what seeding reads: which
   * occurrence it serves and the ref it resolved (undefined while the
   * pick is still in flight).
   */
  readonly activeAttempt: () => {
    readonly occurrenceId: string;
    readonly ref?: SourceRef;
  } | null;
  readonly playOccurrence: (
    occurrenceId: string,
  ) => Promise<Result<void>>;
};

export type RadioCoordinatorDeps = {
  readonly storage: StoragePort;
  readonly ids: IdPort;
  readonly router: ProviderRouter;
  readonly host: RadioHost;
};

/**
 * What a staged radio page produces: the section batch to commit plus
 * the in-memory apply. An omitted `batch` means nothing durable
 * changed — the apply still runs and publishes.
 */
type RadioPageStage = {
  readonly batch?: StorageBatch;
  readonly apply: (r: Ready) => {
    changed: boolean;
    firstAppended: string | undefined;
  };
};

/**
 * The radio tail's orchestration: seed/grow/arm/drain-resume. Ops
 * serialize on the radio lane; page commits ride the session's
 * storage lane through the host. Session stays the facade — it calls
 * the coordinator's hooks from #derived and the transition reconcile
 * and keeps every other domain.
 */
export class RadioCoordinator {
  readonly #storage: StoragePort;
  readonly #ids: IdPort;
  readonly #router: ProviderRouter;
  readonly #host: RadioHost;
  readonly #radioSerial = new Serializer();
  /**
   * One auto-seed attempt per tail occurrence — set when the lazy
   * radio arms itself on the queue's last item (and when the user
   * disarms while it plays), so repeated derived ticks on that
   * item never reseed in a loop. The suppression clears implicitly:
   * the next current occurrence carries a different id.
   */
  #radioAutoSeedOccurrence: string | null = null;
  /**
   * Bumped whenever an armed tail is cleared. An auto-seed queued
   * behind the radio lane aborts on a stale epoch — a user's disarm
   * or a replacement seed must never be undone by an arm scheduled
   * before it.
   */
  #radioArmEpoch = 0;

  constructor(deps: RadioCoordinatorDeps) {
    this.#storage = deps.storage;
    this.#ids = deps.ids;
    this.#router = deps.router;
    this.#host = deps.host;
  }

  /**
   * Seed a lazy radio tail from a track ref (`radio.seed`'s dual
   * payload). The seed routes to the provider that minted the ref —
   * provenance is the only honest route. The page mints recordings +
   * occurrences in one atomic write, then the tail keeps the returned
   * continuation armed. Ops serialize on the radio tail; a new seed
   * replaces the armed one.
   */
  startRadio(ref: SourceRef): Promise<Result<void>> {
    const work = this.#radioSerial.run(() => this.#startRadio(ref));
    this.#host.own(work);
    return work;
  }

  /**
   * Disarm the radio tail. Queued occurrences are untouched — the
   * queue simply stops growing.
   */
  stopRadio(): Result<void> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    this.clearRadio(r);
    // The disarm also counts as the auto-seed verdict for the item
    // it landed on — the tail must not silently reseed under it.
    this.#radioAutoSeedOccurrence =
      r.queue.snapshot().currentOccurrenceId;
    this.#host.publish();
    return ok(undefined);
  }

  /**
   * Drops the tail record and cancels any in-flight continuation;
   * stale fetch results are rejected by record identity, never
   * applied.
   */
  clearRadio(r: Ready): void {
    // The epoch bumps even with no record: an auto-arm queued on
    // the radio lane behind another op must still die when a stop
    // or disarm lands before it starts.
    this.#radioArmEpoch += 1;
    const record = r.radio;
    if (record === null) {
      return;
    }
    record.source?.cancel();
    r.radio = null;
  }

  async #startRadio(ref: SourceRef): Promise<Result<void>> {
    const ready = this.#host.requireReady();
    if (!ready.ok) {
      return ready;
    }
    const r = ready.value;
    if (!isSourceRef(ref)) {
      return err(appError('invalid-response', 'invalid radio seed'));
    }
    if (ref.kind !== 'track') {
      // Track-seeded at first release (providers.md).
      return err(
        appError('not-applicable', 'radio seeds are track refs'),
      );
    }
    const routed = this.#router.providerForRef(ref, 'radio.seed');
    if (!routed.ok) {
      return err(routed.error);
    }
    this.clearRadio(r);
    const record: RadioTailRecord = {
      seedRef: ref,
      providerId: routed.value.id,
      continuation: null,
      status: 'growing',
      error: undefined,
      fetching: true,
      source: null,
      // A tail may only resurrect playback it was armed during — a
      // seed issued on an idle queue appends for later instead.
      resumeOnDrain: r.queue.snapshot().mode === 'playing',
      dupPages: 0,
    };
    r.radio = record;
    this.#host.publish();
    const seeded = await this.#radioCall(
      routed.value,
      { sourceRef: ref },
      record,
    );
    record.fetching = false;
    if (r.radio !== record || this.#host.disposed()) {
      // Superseded or cleared while the seed was in flight — same
      // honesty rule as superseded playback attempts.
      return err(appError('superseded', 'radio seed superseded'));
    }
    if (!seeded.ok) {
      // A failed seed never armed a radio: the state stays absent
      // and the typed error is the caller's.
      r.radio = null;
      this.#host.publish();
      return err(seeded.error);
    }
    const staged = await this.#commitRadioPage(record, seeded.value);
    if (!staged.ok) {
      // The commit's awaits gave a reseed room to swap `r.radio` to a
      // newer record — only our own failed seed clears it.
      if (r.radio === record) {
        r.radio = null;
        this.#host.publish();
      }
      return err(staged.error);
    }
    record.continuation = seeded.value.continuation;
    if (record.continuation === null) {
      record.status = 'ended';
    }
    this.#host.publish();
    // Resume before deriving: a drained queue that just gained items
    // must see the playhead move first, else the chase hook would
    // fire another fetch it no longer needs.
    this.resumeDrainedQueue(r, record, staged.value.firstAppended);
    if (staged.value.changed) {
      this.#host.derived();
    }
    return ok(undefined);
  }

  /**
   * Lazy fetch-ahead: called from the session's derived pass (every
   * queue transition) and the native transition reconcile — never
   * from a timer. The predicate lives in queue/radio-tail.ts; the
   * fetch serializes on the radio tail so at most one continuation
   * is in flight.
   */
  maybeGrowRadio(): void {
    const r = this.#host.ready();
    if (r === null || this.#host.disposed()) {
      return;
    }
    const record = r.radio;
    const snap = r.queue.snapshot();
    if (
      record === null ||
      !shouldGrowRadio(record, snap, this.#host.dealtOrder(r) ?? undefined)
    ) {
      return;
    }
    // Radio growth spends the network — skip when offline.
    if (!this.#host.isOnline()) {
      return;
    }
    record.fetching = true;
    this.#host.publish();
    const work = this.#radioSerial.run(() => this.#growRadio(record));
    this.#host.own(work);
  }

  async #growRadio(
    record: RadioTailRecord,
    whileDrained = false,
  ): Promise<void> {
    const r = this.#host.ready();
    if (r === null || r.radio !== record) {
      return;
    }
    // Re-check the trigger's predicate: queued behind other radio
    // ops the window may already be filled — a stale trigger is a
    // no-op, not a wasted fetch. The trigger published `fetching`;
    // clearing it needs a publish so the flag never reads as a
    // stuck spinner.
    const snap = r.queue.snapshot();
    // The drained chase runs only while the queue still waits — a
    // user landing on other content ends it.
    const windowOpen = whileDrained
      ? snap.currentOccurrenceId === null && record.resumeOnDrain
      : snap.currentOccurrenceId !== null &&
      remainingAfterCurrent(snap, this.#host.dealtOrder(r) ?? undefined) <
        RADIO_FETCH_AHEAD;
    if (
      record.status !== 'growing' ||
      record.continuation === null ||
      !windowOpen
    ) {
      record.fetching = false;
      this.#host.publish();
      // A fetch-ahead queued before a drain aborts here: the window
      // closed because the queue is now empty, not because the tail
      // finished. Hand back to the drained-queue chase or the armed
      // continuation strands with nothing in flight.
      if (snap.currentOccurrenceId === null) {
        this.resumeDrainedQueue(r, record, undefined);
      }
      return;
    }
    // The continuation token's issuer is the only honest target —
    // route by the seed's provenance, not the settings slot.
    const routed = this.#router.providerForRef(record.seedRef, 'radio.seed');
    if (!routed.ok) {
      record.fetching = false;
      record.status = 'failed';
      record.error = routed.error;
      this.#host.publish();
      return;
    }
    const result = await this.#radioCall(
      routed.value,
      { continuation: record.continuation },
      record,
    );
    record.fetching = false;
    if (r.radio !== record || this.#host.disposed()) {
      return;
    }
    if (!result.ok) {
      if (result.error.kind === 'cancelled') {
        return;
      }
      // Honest stop: the tail fails terminal — no retry loop, the
      // queue simply plays out what it has.
      record.status = 'failed';
      record.error = result.error;
      this.#host.publish();
      return;
    }
    const staged = await this.#commitRadioPage(record, result.value);
    if (!staged.ok) {
      record.status = 'failed';
      record.error = staged.error;
      this.#host.publish();
      return;
    }
    record.continuation = result.value.continuation;
    if (record.continuation === null) {
      record.status = 'ended';
    }
    this.#host.publish();
    // Resume before deriving — see #startRadio.
    this.resumeDrainedQueue(r, record, staged.value.firstAppended);
    if (staged.value.changed) {
      // derived() re-evaluates the window: a page that still leaves
      // the tail short chains the next continuation immediately.
      this.#host.derived();
    }
  }

  /**
   * One bounded provider call for the tail. The cancellation source
   * lives on the record so clears can cancel it, and is tracked for
   * dispose-time cancel too.
   */
  async #radioCall(
    provider: ProviderPort,
    input: RadioSeed,
    record: RadioTailRecord,
  ): Promise<Result<RadioPage>> {
    const source = new CancellationSource();
    record.source = source;
    const untrack = this.#host.trackSource(source);
    try {
      const deadlineMs = this.#host.deadline();
      const context = this.#host.newContext('radio', deadlineMs, source.signal);
      return await this.#host.withDeadline(
        () => provider.radioSeed(input, context),
        deadlineMs,
        source,
      );
    } finally {
      untrack();
      if (record.source === source) {
        record.source = null;
      }
    }
  }

  /**
   * Stages a fetched page against library + queue: validates the wire
   * shape (one corrupt item fails the whole page), dedupes and
   * mints/merges via `planRadioPage`, then enqueues the survivors on
   * a draft engine. Pure — the recordings write and the queue move
   * commit together, all items or none, before the mirror updates.
   */
  #stageRadioPage(r: Ready, page: RadioPage): Result<RadioPageStage> {
    if (!isRadioPage(page)) {
      return err(
        appError('invalid-response', 'radio page failed validation'),
      );
    }
    const now = this.#host.safeNow();
    if (now === null) {
      return err(internalError());
    }
    const plan = planRadioPage(
      r.recordings,
      r.queue.snapshot().occurrences,
      page.candidates,
      this.#ids,
      r.settings.playbackProvider,
      now,
    );
    const recordingsChanged = plan.recordings !== r.recordings;
    const draft = r.queue.fork();
    try {
      for (const occurrence of plan.occurrences) {
        draft.enqueue(occurrence);
      }
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
    const firstAppended = plan.occurrences[0]?.occurrenceId;
    if (!recordingsChanged && plan.occurrences.length === 0) {
      return ok({
        apply: () => ({ changed: false, firstAppended: undefined }),
      });
    }
    const recordings = plan.recordings;
    const queue = draft.snapshot();
    return ok({
      batch: { recordings, queue },
      apply: (rr) => {
        rr.recordings = [...recordings];
        rr.queue = draft;
        return { changed: true, firstAppended };
      },
    });
  }

  /**
   * Auto-arm: reaching the queue's LAST occurrence seeds the lazy
   * tail from the playing track, so a finite queue rolls into a
   * radio mix instead of ending (playing a single track arms it
   * immediately). Any existing tail — growing, ended, or failed —
   * blocks it: a terminal tail stays terminal until an explicit seed
   * replaces it, and auto-arm must never resurrect a failed mix.
   * One attempt per occurrence; a disarm or a superseding seed
   * invalidates a queued attempt via the arm epoch. Failures stay
   * logged — an auto-seed is speculative, never user-visible.
   */
  maybeArmRadio(): void {
    const r = this.#host.ready();
    if (r === null || this.#host.disposed()) {
      return;
    }
    const snap = r.queue.snapshot();
    if (
      snap.mode !== 'playing' ||
      snap.currentOccurrenceId === null ||
      // The tail the cursor will actually run off — dealt space
      // under shuffle, canonical otherwise.
      remainingAfterCurrent(snap, this.#host.dealtOrder(r) ?? undefined) !== 0 ||
      this.#radioAutoSeedOccurrence === snap.currentOccurrenceId ||
      r.radio !== null
    ) {
      return;
    }
    if (!this.#host.isOnline()) {
      // Offline is weather — connectivityChanged() re-derives.
      return;
    }
    // One attempt per tail position — the marker holds even when the
    // queued work finds nothing seedable: that verdict is sticky, not
    // weather.
    this.#radioAutoSeedOccurrence = snap.currentOccurrenceId;
    const armedFor = snap.currentOccurrenceId;
    const epoch = this.#radioArmEpoch;
    const work = this.#radioSerial.run(async () => {
      const cur = this.#host.ready();
      if (
        cur === null ||
        this.#host.disposed() ||
        this.#radioArmEpoch !== epoch ||
        cur.radio !== null
      ) {
        // Cleared or reseeded while queued — the later decision wins.
        return ok(undefined);
      }
      // Re-evaluate at run time: the tail may have moved while this
      // arm was queued (a stop is caught by the epoch; a cursor move
      // reseeds from the item actually on the tail).
      const live = cur.queue.snapshot();
      if (
        live.mode !== 'playing' ||
        live.currentOccurrenceId === null ||
        remainingAfterCurrent(live, this.#host.dealtOrder(cur) ?? undefined) !== 0
      ) {
        // The cursor left the tail before this arm ran — the
        // occurrence was never judged, so a later return to it may
        // still arm.
        if (this.#radioAutoSeedOccurrence === armedFor) {
          this.#radioAutoSeedOccurrence = null;
        }
        return ok(undefined);
      }
      const liveOccurrence = live.occurrences.find(
        (o) => o.occurrenceId === live.currentOccurrenceId,
      );
      const liveRecording = cur.recordings.find(
        (rec) => rec.id === liveOccurrence?.recordingId,
      );
      if (liveOccurrence === undefined || liveRecording === undefined) {
        return ok(undefined);
      }
      // An attempt for the tail item that hasn't resolved its ref
      // yet is weather: stored-order fallback would seed a different
      // version than the one playing. #startAttempt re-fires the
      // arm when `attempt.ref` lands.
      const liveAttempt = this.#host.activeAttempt();
      if (
        liveAttempt !== null &&
        liveAttempt.occurrenceId === live.currentOccurrenceId &&
        liveAttempt.ref === undefined
      ) {
        if (this.#radioAutoSeedOccurrence === armedFor) {
          this.#radioAutoSeedOccurrence = null;
        }
        return ok(undefined);
      }
      const ref = this.#radioSeedRef(liveOccurrence, liveRecording);
      if (ref === null) {
        // Judged: nothing seedable — the verdict sticks.
        this.#radioAutoSeedOccurrence = live.currentOccurrenceId;
        return ok(undefined);
      }
      if (!this.#host.isOnline()) {
        // Connectivity dropped between trigger and run — release the
        // marker so the reconnect #derived re-arms this occurrence.
        if (this.#radioAutoSeedOccurrence === armedFor) {
          this.#radioAutoSeedOccurrence = null;
        }
        return ok(undefined);
      }
      this.#radioAutoSeedOccurrence = live.currentOccurrenceId;
      const seeded = await this.#startRadio(ref);
      if (!seeded.ok) {
        const kind = seeded.error.kind;
        // superseded/cancelled are routine churn — the arm was
        // replaced or the serial cancelled mid-flight; the state
        // already reflects it, so a warn would be noise. Genuine
        // failures stay logged: an auto-seed is speculative, never
        // user-visible.
        if (kind !== 'superseded' && kind !== 'cancelled') {
          this.#host.logWarn(`auto radio seed failed: ${kind}`);
        }
      }
      return seeded;
    });
    this.#host.own(work);
  }

  /**
   * Pick the seed ref for a queue occurrence: the live attempt's
   * resolved ref decides — the pick may have chosen an effective
   * mapping over the stored order, and the seed must follow the
   * version actually playing. A non-local playing ref whose provider
   * can't seed radio is a verdict, not a fallback: substituting a
   * different provider's ref would mix from another version. Local
   * playback has no provider identity, so its ref falls through to
   * the recording's catalog identity — the pinned ref, then stored
   * order. Each candidate must route to a `radio.seed` provider.
   */
  #radioSeedRef(
    occurrence: QueueOccurrence,
    recording: Recording,
  ): SourceRef | null {
    const active = this.#host.activeAttempt();
    if (
      active !== null &&
      active.occurrenceId === occurrence.occurrenceId &&
      active.ref !== undefined
    ) {
      const playing = active.ref;
      // Local playback has no provider identity: the recording's
      // catalog refs remain the honest seed source.
      if (playing.provider !== LOCAL_PROVIDER) {
        // The resolved ref is the version playing — when its provider
        // can't seed radio there is no faithful substitute, and a
        // different provider's ref would mix from another version.
        if (playing.kind !== 'track') {
          return null;
        }
        return this.#router.providerForRef(playing, 'radio.seed').ok
          ? playing
          : null;
      }
    }
    const candidates: (SourceRef | null)[] = [
      occurrence.selectedRef,
      ...recording.sourceRefs,
    ];
    for (const candidate of candidates) {
      if (candidate === null || candidate.kind !== 'track') {
        continue;
      }
      if (this.#router.providerForRef(candidate, 'radio.seed').ok) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * A disarm landing while a page's commit waits on storage must
   * never let the page reach the queue — or the durable doc. The
   * record check runs inside the segment before staging (a disarm
   * queued ahead drops the commit entirely) and again after the
   * commit await: a rejected page skips the sync emission and the
   * in-memory apply, then the SAME segment — which still owns the
   * storage tail, so nothing can have committed in between — issues
   * a compensating commit that rewrites the live, page-free queue
   * and recordings at a fresh queue revision. Writing the freshest
   * mirror keeps mutations queued during the await durable (their
   * own segments later no-op on the revision check), and bumping
   * `queueCommittedRev` onto that new lineage keeps the next queue
   * write from being skipped.
   */
  async #commitRadioPage(
    record: RadioTailRecord,
    page: RadioPage,
  ): Promise<
    Result<{ changed: boolean; firstAppended: string | undefined }>
  > {
    const generation = this.#host.ready();
    const source = new CancellationSource();
    const untrack = this.#host.trackSource(source);
    try {
      return await this.#host.enqueueStorage(async () => {
        const r = this.#host.ready();
        if (generation === null || r !== generation) {
          return err(supersededError());
        }
        if (r.radio !== record) {
          return ok({ changed: false, firstAppended: undefined });
        }
        const staged = this.#stageRadioPage(r, page);
        if (!staged.ok) {
          return err(staged.error);
        }
        const inner = staged.value;
        if (inner.batch === undefined) {
          const outcome = inner.apply(r);
          this.#host.publish();
          return ok(outcome);
        }
        const batch = inner.batch;
        const deadlineMs = this.#host.deadline();
        const context = this.#host.newContext('persist', deadlineMs, source.signal);
        const committed = await this.#host.withDeadline(
          () => this.#storage.commit(batch, context),
          deadlineMs,
          source,
        );
        if (!committed.ok) {
          r.persistenceError = committed.error;
          this.#host.publish();
          return err(committed.error);
        }
        if (batch.queue !== undefined) {
          r.queueCommittedRev = Math.max(
            r.queueCommittedRev,
            batch.queue.revision,
          );
        }
        r.persistenceError = undefined;
        if (r.radio === record) {
          this.#host.emitSync(emissionWrites(syncEmitInput(r), batch));
          const outcome = inner.apply(r);
          this.#host.publish();
          return ok(outcome);
        }
        // The page committed but the disarm already ran — the mirror
        // never applied it, so live sections are the inverse image.
        // The revert revision must clear BOTH counters: mutations
        // queued during the commit already raised the live engine
        // past `queueCommittedRev`, so minting off the committed
        // counter alone could hand the fresh engine a revision at or
        // below the content it carries — a later write then re-uses a
        // durable revision and the persist guard skips it.
        const liveQueue = r.queue.snapshot();
        const revertedQueue: QueueSnapshot = {
          ...liveQueue,
          revision:
            Math.max(r.queueCommittedRev, liveQueue.revision) + 1,
        };
        const revertBatch: StorageBatch = {
          queue: revertedQueue,
          recordings: [...r.recordings],
        };
        const revertDeadlineMs = this.#host.deadline();
        const revertContext = this.#host.newContext(
          'persist',
          revertDeadlineMs,
          source.signal,
        );
        const reverted = await this.#host.withDeadline(
          () => this.#storage.commit(revertBatch, revertContext),
          revertDeadlineMs,
          source,
        );
        if (!reverted.ok) {
          r.persistenceError = reverted.error;
          this.#host.publish();
          return err(reverted.error);
        }
        r.queueCommittedRev = revertedQueue.revision;
        // Peers never saw the page — emit only the revert delta.
        this.#host.emitSync(emissionWrites(syncEmitInput(r), revertBatch));
        // The mirror keeps its live content and adopts the fresh
        // revision so queued commands stay on the durable lineage.
        r.queue = new QueueEngine(revertedQueue, r.queue.unplayableIds);
        // The engine was swapped wholesale — projections and the
        // tail hooks still reference the pre-swap instance.
        this.#host.derived();
        this.#host.publish();
        return ok({ changed: false, firstAppended: undefined });
      });
    } finally {
      untrack();
    }
  }

  /**
   * A page landing on a drained queue: the tail was armed while
   * playing (`resumeOnDrain`) and playback ran out of occurrences
   * before the fetch landed — resume at the first appended item.
   * The record-identity check keeps a disarm sticky: `stop()` and
   * `stopRadio()` drop the record, so a stopped queue never
   * resurrects when an in-flight page lands.
   */
  resumeDrainedQueue(
    r: Ready,
    record: RadioTailRecord,
    firstAppended: string | undefined,
  ): void {
    if (
      this.#host.disposed() ||
      r.radio !== record ||
      r.queue.snapshot().currentOccurrenceId !== null
    ) {
      return;
    }
    if (firstAppended !== undefined) {
      record.dupPages = 0;
      if (!record.resumeOnDrain) {
        return;
      }
      // A resumed occurrence whose bytes aren't owned fires a
      // candidates/resolve chain that can only fail offline — stay
      // armed instead of burning the attempt; the next landed page
      // retries once connectivity is back. Owned bytes (downloads,
      // local files) still resume: that's the offline-honest path.
      const appended = r.queue
        .snapshot()
        .occurrences.find((o) => o.occurrenceId === firstAppended);
      if (
        !this.#host.isOnline() &&
        this.#host.localPlaybackFor(appended?.recordingId ?? '') === null
      ) {
        return;
      }
      this.#host.own(
        this.#host.playOccurrence(firstAppended).then((res) => {
          if (!res.ok) {
            this.#host.logWarn(`radio resume failed: ${res.error.kind}`);
          }
        }),
      );
      return;
    }
    // The page landed on a drained queue and appended nothing — the
    // continuation may still hold fresh items, so chase it within a
    // bound. Without this a duplicate-only page strands a playing
    // queue's tail forever.
    if (
      !record.resumeOnDrain ||
      record.status !== 'growing' ||
      record.continuation === null ||
      record.fetching ||
      record.dupPages >= RADIO_DRAIN_CHASE_PAGES ||
      !this.#host.isOnline()
    ) {
      return;
    }
    record.dupPages += 1;
    record.fetching = true;
    this.#host.publish();
    const work = this.#radioSerial.run(() => this.#growRadio(record, true));
    this.#host.own(work);
  }
}
