import { CancellationSource } from '../cancellation.ts';
import type {
  CancellationSignal,
  OperationContext,
} from '../cancellation.ts';
import type { Result } from '../errors.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import type {
  EntityKind,
  LikeEntityKind,
  SourceMapping,
  SourceRef,
} from '../domain.ts';
import {
  hasExactKeys,
  isArtworkRef,
  isEntityRef,
  isFiniteNumber,
  isLike,
  isOptSafeNonNegative,
  isOptString,
  isRecord,
  isSafeNonNegative,
  isSourceMapping,
  isString,
  isTrackRef,
} from '../domain.ts';
import { PLAY_HISTORY_RETENTION_MS } from '../library/history.ts';
import {
  isCandidateSnapshot,
  isMatchResolution,
  isPlayEvent,
} from '../library/library.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { LogPort } from '../ports/log.ts';
import type { IdPort } from '../ports/runtime.ts';
import { HybridClock, compareStamp, isHlcStamp } from './hlc.ts';
import type { HlcStamp } from './hlc.ts';
import {
  KEY_SEP,
  compareEntryTs,
  entryKey,
  jsonEquals,
} from './entry-order.ts';

/**
 * The slice-4 merge engine for phone↔desktop library sync (sync.md).
 * Pure TypeScript — no transport, pairing, or platform concerns.
 *
 * Model: every client keeps an append-only change log of
 * `{kind, recordId, field, value, hlc, deviceId, tombstone, seq}`
 * entries. Each record is a set of independently merged fields; each
 * field holds its live candidates — entries stamped newer than the
 * record's winning tombstone — and the merge rule picks the winner
 * over that set ('lww' newest stamp; 'max' largest numeric value;
 * 'sum' a per-device component counter — play counts, where taking
 * the max would silently lose concurrent increments — see
 * hlc.ts for the stamp scheme). A record-level tombstone entry
 * (field '*') kills every live candidate stamped at or below it and
 * loses to newer tombstones; a dead entry never resurfaces, but a
 * live one always can for 'max'/'sum' fields, which is what keeps
 * the merge convergent under any arrival order. `seq` is the
 * emitting device's own emission ordinal — it exists so receivers
 * can track contiguous per-device progress (a scalar stamp watermark
 * would falsely claim knowledge below relay gaps; see SyncCursor).
 * A seq the exporter drops for retention is listed in the delta's
 * `skipped` map so receivers can fold it as known-absent — without
 * it a permanently-filtered seq would stall every later page.
 *
 * Predictable over clever: whenever an entry displaces a live value or
 * loses to a newer one, the loser is preserved in a bounded divergence
 * history — listable for diagnostics and restorable as a fresh local
 * write via `restoreLoser`.
 *
 * What syncs is a whitelist (FIELD_RULES): every owned-data class, one
 * record kind each — recordings (+ their source-ref and mapping-claim
 * presence records), likes, entities, entity refs, playlists, playlist
 * entries, play events, play counts, match reviews, and a settings
 * subset (theme, storefront, provider selections, quality tier,
 * prefetch — exactly the sync.md list). Anything outside the whitelist
 * never enters a delta and is rejected on apply, which is how media,
 * session state, diagnostics, and per-device budgets stay out.
 *
 * Scope note: the engine owns the log, the merge, and the divergence
 * record. It does NOT mutate domain state — callers apply `applied`
 * outcomes to their own storage, and log each local edit here after
 * committing it. Persistence of the log itself rides the SyncLogStore
 * port; each platform backs it later (sync_change_log, data.md).
 */

// ---- record kinds ---------------------------------------------------------

const SYNC_RECORD_KINDS = [
  'recording',
  'recordingSourceRef',
  'recordingMapping',
  'like',
  'entity',
  'entitySourceRef',
  'playlist',
  'playlistEntry',
  'playEvent',
  'playCount',
  'matchReview',
  'settings',
] as const;

export type SyncRecordKind = (typeof SYNC_RECORD_KINDS)[number];

const SYNC_RECORD_KIND_SET: ReadonlySet<string> = new Set(SYNC_RECORD_KINDS);

function isSyncRecordKind(value: unknown): value is SyncRecordKind {
  return (
    typeof value === 'string' && SYNC_RECORD_KIND_SET.has(value)
  );
}

/** The record-wide delete marker: a tombstone entry always uses it. */
export const TOMBSTONE_FIELD = '*';

/** The singleton settings record's id. */
export const SETTINGS_RECORD_ID = 'settings';

/**
 * Record ids are kind-local. Presence-style records key on domain
 * identity so the same claim carries the same id on every device:
 * likes by (entityKind, targetId), a recording's source refs by
 * (recordingId, provider, kind, id), mapping claims by
 * (recordingId, ref, status, matchedAtMs) — matching the identity
 * `corrections` uses when undo removes a claim.
 *
 * Ids are length-prefixed concatenations: `len:component` is
 * unambiguous to parse, so the encoding is injective — separator or
 * quote bytes inside component data can never alias two distinct
 * claims onto one sync record. Unlike JSON it adds ~3 chars per
 * component, keeping worst-case ids inside MAX_RECORD_ID.
 */
function encodeRecordId(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

export function likeRecordId(
  entityKind: LikeEntityKind,
  targetId: string,
): string {
  return encodeRecordId([entityKind, targetId]);
}

export function sourceRefRecordId(
  recordingId: string,
  ref: SourceRef,
): string {
  return encodeRecordId([recordingId, ref.provider, ref.kind, ref.id]);
}

export function mappingRecordId(
  recordingId: string,
  mapping: SourceMapping,
): string {
  return encodeRecordId([
    recordingId,
    mapping.ref.provider,
    mapping.ref.kind,
    mapping.ref.id,
    mapping.status,
    String(mapping.matchedAtMs),
  ]);
}

/**
 * Set key identifying one synced record — matches the materialized
 * view's (kind, recordId) pair space. Callers building the
 * key→fields map for `Session.emitUnsynced` key records with this.
 */
export function syncedRecordKey(
  kind: SyncRecordKind,
  recordId: string,
): string {
  return `${kind}${KEY_SEP}${recordId}`;
}

/**
 * `materialize()` ordering: each parent record sorts ADJACENT to the
 * records its row needs to materialize, not merely before all
 * dependents (Review #46 round-9). A recording's row is only valid
 * with a source ref, so kinds that share a parent id interleave
 * under that id — a byte-paged rebuild then holds at most one
 * family's records pending at a page boundary instead of every
 * recording waiting on the ref region (and evicting under the
 * pending bound past ~2048). Tier-1 kinds (likes, playlist entries,
 * play events, reviews, settings) reference parents only through
 * their fields, so they sort after every complete family.
 */
const MATERIALIZE_GROUPED_KINDS: ReadonlySet<SyncRecordKind> = new Set([
  'recording',
  'recordingSourceRef',
  'recordingMapping',
  'playCount',
  'entity',
  'entitySourceRef',
  'playlist',
]);

/**
 * The parent id a grouped record belongs to: its own id for parent
 * kinds, the first decoded component for composite ids (a source ref
 * or mapping id embeds the recording id; an entity source ref embeds
 * the entity id). playCount ids ARE the recording id already.
 */
function materializeGroup(kind: SyncRecordKind, recordId: string): string {
  if (
    kind === 'recordingSourceRef' ||
    kind === 'recordingMapping' ||
    kind === 'entitySourceRef'
  ) {
    return decodeRecordId(recordId)?.[0] ?? recordId;
  }
  return recordId;
}

export function entitySourceRefRecordId(
  entityId: string,
  provider: string,
): string {
  return encodeRecordId([entityId, provider]);
}

/**
 * Inverse of `encodeRecordId`: parses the `len:component` stream back
 * into its exact parts. Returns null on any malformed shape — a bad
 * length prefix, a truncated component, or a dangling separator —
 * since only a well-formed id can decode to identity parts.
 */
export function decodeRecordId(recordId: string): readonly string[] | null {
  const parts: string[] = [];
  let pos = 0;
  while (pos < recordId.length) {
    const colon = recordId.indexOf(':', pos);
    if (colon < 0) {
      return null;
    }
    const rawLen = recordId.slice(pos, colon);
    if (rawLen.length === 0 || !/^\d+$/.test(rawLen)) {
      return null;
    }
    const len = Number.parseInt(rawLen, 10);
    if (!Number.isSafeInteger(len) || len < 0) {
      return null;
    }
    const start = colon + 1;
    if (start + len > recordId.length) {
      return null;
    }
    parts.push(recordId.slice(start, start + len));
    pos = start + len;
  }
  return parts;
}

// ---- wire types -----------------------------------------------------------

/**
 * One change-log row — sync.md's `{recordId, field, value, timestamp,
 * tombstone}` plus the emitting `deviceId` (needed to break stamp
 * ties into a total order) and `kind` (the whitelist gate). On a
 * tombstone, `field` is `TOMBSTONE_FIELD` and `value` is null.
 */
export type ChangeEntry = {
  readonly kind: SyncRecordKind;
  readonly recordId: string;
  readonly field: string;
  readonly value: unknown;
  readonly tombstone: boolean;
  readonly hlc: HlcStamp;
  readonly deviceId: string;
  /**
   * Emission ordinal of the emitting device — 1-based position in its
   * own emitted stream, assigned only after the entry lands durably in
   * the origin's own log (a failed append burns nothing). Because the
   * origin emits every seq it mints, seqs form a gap-free stream:
   * receivers can track a *contiguous* per-device watermark instead of
   * a scalar high-water mark, which is the only cursor that is safe
   * under arbitrary relay subsets and retention-filtered exports.
   */
  readonly seq: number;
};

/** A local write: one field set, or a record-wide delete. */
export type LocalWrite =
  | {
    readonly kind: SyncRecordKind;
    readonly recordId: string;
    readonly field: string;
    readonly value: unknown;
  }
  | {
    readonly kind: SyncRecordKind;
    readonly recordId: string;
    readonly tombstone: true;
  };

/**
 * Per-source-device contiguous watermark: `cursor[device]` is the
 * largest emission seq the holder has observed *without gaps* from
 * that device — i.e. it has every entry the device emitted up to it.
 * A delta exports entries with `seq` strictly above the requester's
 * cursor per source device. A scalar high-water mark is unsafe under
 * relay: a relayed subset (or a retention-dropped playEvent) would
 * advance the mark past entries the holder never saw, and later
 * exports would suppress them forever. Contiguity costs a stalled
 * cursor while a hole is unfilled — chattier, never lossy.
 */
export type SyncCursor = Readonly<Record<string, number>>;

/** The versioned, JSON-serializable delta document on the wire. */
export type SyncDelta = {
  readonly formatVersion: 1;
  readonly senderDeviceId: string;
  /** The sender's full contiguous watermark at export time. */
  readonly cursor: SyncCursor;
  readonly entries: readonly ChangeEntry[];
  /**
   * True when entries remained above the request cursor beyond this
   * doc's bound — the receiver keeps re-requesting with its own
   * (newly advanced) cursor until a doc arrives with `more: false`.
   * Export is always bounded so an emitted doc can never be rejected
   * by its own envelope validator.
   */
  readonly more: boolean;
  /**
   * Retention-dropped emission seqs per source device — the seqs the
   * exporter filtered out for being beyond the play-history window,
   * up to the largest seq this doc ships for that device. Receivers
   * fold them as known-absent so their contiguous cursor can cross
   * the hole: without them a permanently-dropped seq would stall
   * every later page forever. A skipped seq is the exporter's claim,
   * not data — if the entry arrives later via another peer it still
   * applies normally.
   */
  readonly skipped: Record<string, readonly number[]>;
};

// ---- divergence history ---------------------------------------------------

type DivergenceSide = {
  readonly deviceId: string;
  readonly hlc: HlcStamp;
  readonly tombstone: boolean;
  readonly value: unknown;
};

/**
 * One preserved loser: a value (or delete) that lost the merge on
 * this device. `origin` says where the loser was written — 'local'
 * means "your edit was overwritten", 'remote' means a synced edit
 * lost to local state. `seq` is a device-local append order the
 * store uses for bounded pruning.
 */
export type DivergenceEntry = {
  readonly historyId: string;
  readonly seq: number;
  readonly kind: SyncRecordKind;
  readonly recordId: string;
  readonly field: string;
  readonly loser: DivergenceSide;
  readonly winner: DivergenceSide;
  readonly observedMs: number;
  readonly origin: 'local' | 'remote';
};

type DivergenceFilter = {
  readonly kind?: SyncRecordKind;
  readonly recordId?: string;
};

// ---- outcomes -------------------------------------------------------------

/**
 * What one entry did to the merge:
 * - `applied`: the entry won; `displaced` lists previous winners it
 *   knocked out (field writes) or live fields a tombstone deleted.
 * - `superseded`: the entry lost; `winner` is the current winner (a
 *   field entry or the record's tombstone) the caller can restore.
 * - `duplicate`: already in the log; nothing changed.
 * - `rejected`: malformed or non-whitelisted — never enters the log.
 *   `index` is the delta position since there is no valid entry.
 */
export type MergeOutcome =
  | {
    readonly type: 'applied';
    readonly entry: ChangeEntry;
    readonly displaced: readonly ChangeEntry[];
    /**
     * Post-merge materialized fields for the entry's record (every
     * surviving field, not just this entry's). The projector must
     * trust this over inferring record state from entries alone —
     * a delayed tombstone that lost to newer fields leaves fields
     * alive here. Empty `fields` means the record is fully deleted.
     */
    readonly record?: MaterializedRecord;
  }
  | {
    readonly type: 'superseded';
    readonly entry: ChangeEntry;
    readonly winner: ChangeEntry;
  }
  | { readonly type: 'duplicate'; readonly entry: ChangeEntry }
  | { readonly type: 'rejected'; readonly index: number; readonly reason: string };

type LocalChangeResult = {
  readonly entry: ChangeEntry;
  readonly outcome: MergeOutcome;
};

export type ApplyResult = {
  readonly senderDeviceId: string;
  /** Entries new to this device, now durable in the log. */
  readonly entries: readonly ChangeEntry[];
  /** Per-entry outcome in canonical merge order (rejects first). */
  readonly outcomes: readonly MergeOutcome[];
  /** Loser rows written by this apply. */
  readonly divergence: readonly DivergenceEntry[];
  /** This device's watermark after the apply. */
  readonly cursor: SyncCursor;
};

/** A record's surviving fields — the merged view of one record. */
export type MaterializedRecord = {
  readonly kind: SyncRecordKind;
  readonly recordId: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

// ---- persistence seam -----------------------------------------------------

export type SyncLogSnapshot = {
  /** Every change entry this device has accepted, in append order. */
  readonly entries: readonly ChangeEntry[];
  readonly divergence: readonly DivergenceEntry[];
  readonly watermarks: Readonly<Record<string, number>>;
  /**
   * Cumulative divergence prune floor: the largest boundary ever
   * passed to `dropDivergenceBefore` — rows below it were dropped
   * *intentionally*. Hydration replays the log to repair rows a
   * failed append lost, but must not rebuild losers whose emit
   * position sits below this floor (rebuilding them would resurrect
   * pruned history with fresh seqs and churn the retained window on
   * every restart).
   */
  readonly divergenceFloor?: number;
  /**
   * Legacy count form of `divergenceDroppedEmissions`: logs written
   * before emission ordinals were tracked carry only how many
   * emissions compaction dropped, so hydration assumes they held
   * positions 1..N and seeds the replay cursor past them.
   */
  readonly divergenceReplayOffset?: number;
  /**
   * Every emission ordinal log compaction has retired, ascending.
   * Hydration replays the surviving log to repair rows a failed
   * append lost; each replayed emission must land back on the
   * ordinal it originally held — skipping the retired ones — or a
   * surviving loser whose original position sat below
   * `divergenceFloor` replays above it and resurrects a pruned row.
   */
  readonly divergenceDroppedEmissions?: readonly number[];
  /**
   * The durable peer-mark table: `peerMarks[sender][src]` is the last
   * contiguous watermark each delta sender provably held for `src` at
   * its most recent claim. Restored rows are stale by construction —
   * the wire carries no peer-instance token, so a deviceId surviving
   * a peer's rebuild can't be told apart from the same instance — so
   * hydration seeds them as remembered-but-unconfirmed: a silent
   * remembered peer pins compaction at 0 rather than being credited
   * a mark it may no longer hold.
   */
  readonly peerMarks?: Readonly<Record<string, SyncCursor>>;
};

export type SyncLogWrite = {
  readonly entries?: readonly ChangeEntry[];
  readonly divergence?: readonly DivergenceEntry[];
  /** Merged into the stored watermark map (per-device max). */
  readonly watermarks?: Readonly<Record<string, number>>;
  /** Drops stored divergence rows with seq strictly below this floor. */
  readonly dropDivergenceBefore?: number;
  /**
   * Log compaction: durable rows to drop, each identified by its
   * unique (deviceId, seq). The engine emits drops only for entries
   * that are merge-dead AND at or below every observed peer's
   * watermark for the emitting device — live candidates and winning
   * tombstones always stay so a fresh peer still materializes the
   * same state; the dropped seqs surface as `skipped` holes on later
   * exports.
   */
  readonly dropEntries?: readonly {
    readonly deviceId: string;
    readonly seq: number;
  }[];
  /**
   * Superseded by `divergenceDroppedEmissions` — kept so stores
   * still parse writes an older build appended. The engine no
   * longer emits it.
   */
  readonly divergenceReplayOffset?: number;
  /**
   * Rides with `dropEntries`: the emission ordinals the dropped
   * entries held, union-folded by the store so hydration can map
   * each replayed emission back onto the ordinal it originally
   * occupied. A replayed write is idempotent (INSERT OR IGNORE /
   * set-union); a stale subset merges into the accumulated set.
   */
  readonly divergenceDroppedEmissions?: readonly number[];
  /**
   * Per-sender replacement rows for the durable peer-mark table: a
   * write carries the sender's whole folded row so a live claim that
   * regresses a persisted row clears it wholesale — a rebuilt peer
   * must never merge fresh claims into what its lost instance held.
   * On `applyDelta` the row rides the entries append itself, so a
   * peer's presence lands atomically with the delta that carried its
   * claim — an apply can only ack once the mark is durable.
   */
  readonly peerMarks?: Readonly<Record<string, SyncCursor>>;
};

/**
 * The engine's own durable seam — the `sync_change_log` surface each
 * platform backs later. Commits are atomic; the port never throws.
 */
export interface SyncLogStore {
  load(context: OperationContext): Promise<Result<SyncLogSnapshot>>;
  append(
    write: SyncLogWrite,
    context: OperationContext,
  ): Promise<Result<void>>;
}

// ---- engine ---------------------------------------------------------------

export type SyncEngineDeps = {
  readonly store: SyncLogStore;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly log: LogPort;
  /** Stable per-install device id; carried on every emitted entry. */
  readonly deviceId: string;
};

export interface SyncEngine {
  readonly deviceId: string;
  /**
   * Appends one local change and returns the stamped entry plus its
   * merge outcome. The caller commits its domain write first; if the
   * outcome is `superseded` the synced winner already known to this
   * device outranks the write and the caller may restore it.
   */
  localChange(
    input: LocalWrite,
    signal?: CancellationSignal,
  ): Promise<Result<LocalChangeResult>>;
  /** One atomic append for multi-record edits (e.g. delete cascades). */
  localChangeBatch(
    inputs: readonly LocalWrite[],
    signal?: CancellationSignal,
  ): Promise<Result<readonly LocalChangeResult[]>>;
  /**
   * The delta document of every logged entry above `since`, bounded
   * to `limit` entries (default the wire cap). `more` reports whether
   * a follow-up export with the receiver's advanced cursor would
   * still have entries — the doc is never emitted in a shape its own
   * validator would reject.
   */
  exportDelta(
    since?: SyncCursor,
    limit?: number,
    signal?: CancellationSignal,
  ): Promise<Result<SyncDelta>>;
  /**
   * Validates a remote delta, appends its new entries, and merges.
   * Entries apply in canonical stamp order, so the merge — including
   * the divergence rows it writes — is identical on every device that
   * receives the same entry set. `senderDeviceId` is the
   * transport-authenticated id of the peer that delivered the doc:
   * when present the doc's own sender stamp must equal it — the stamp
   * keys the peer-mark fold, so a mismatched claim is a forgery and
   * the whole doc fails 'invalid-message'. Unauthenticated sources
   * (local imports) leave it unset and fold the doc's claim as-is.
   */
  applyDelta(
    doc: unknown,
    senderDeviceId?: string,
    signal?: CancellationSignal,
  ): Promise<Result<ApplyResult>>;
  /** Newest-first loser history for diagnostics. */
  divergenceHistory(
    filter?: DivergenceFilter,
  ): readonly DivergenceEntry[];
  /**
   * Re-issues the losing value (or the losing delete) of one
   * divergence row as a fresh local write — a new stamp wins it back.
   * The domain-side restore is the caller's: apply the returned
   * outcome like any other local change.
   */
  restoreLoser(
    historyId: string,
    signal?: CancellationSignal,
  ): Promise<Result<LocalChangeResult>>;
  /**
   * The merged record view: every record the merge ever touched —
   * empty `fields` means a winning tombstone ("synced then deleted"),
   * distinct from a record absent here, which was never synced.
   */
  materialize(): readonly MaterializedRecord[];
  /** This device's per-source-device watermark map. */
  cursor(): SyncCursor;
}

const OP_DEADLINE_MS = 15_000;
const MAX_DEVICE_ID = 128;
const MAX_RECORD_ID = 1024;
const MAX_FIELD = 64;
const MAX_DELTA_ENTRIES = 10_000;
const MAX_CURSOR_DEVICES = 512;
/** Bounded loser history — diagnostics surfaces stay small. */
export const DIVERGENCE_HISTORY_LIMIT = 500;

// ---- field whitelist (the wire contract) ------------------------------------

type FieldRule = {
  readonly valid: (value: unknown) => boolean;
  /**
   * 'lww' — the higher stamp wins.
   * 'max' — the larger value wins (numeric semilattice): used by
   *   playCount.lastMs so the merged "most recent play" never
   *   regresses.
   * 'sum' — a per-device grow-only counter: each device's entries form
   *   its own component (component = the device's largest live value),
   *   and the materialized value is the sum of components. Used by
   *   playCount.count because a scalar max silently loses concurrent
   *   increments (two devices at 5 that each log a play both publish 6
   *   — merged: 6, but 7 plays happened). Losers within a component
   *   (a device's own superseded writes) still land in divergence.
   */
  readonly merge: 'lww' | 'max' | 'sum';
};

function rule(
  valid: (value: unknown) => boolean,
  merge: 'lww' | 'max' | 'sum' = 'lww',
): FieldRule {
  return { valid, merge };
}

const str =
  (max: number) =>
  (value: unknown): boolean =>
    isString(value, max);
const optStr =
  (max: number) =>
  (value: unknown): boolean =>
    isOptString(value, max);

const isBooleanValue = (value: unknown): boolean =>
  typeof value === 'boolean';
const isOptBoolean = (value: unknown): boolean =>
  value === null || isBooleanValue(value);

const isReleaseYear = (value: unknown): boolean =>
  value === null ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

const isArtworkList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 8 &&
  value.every(isArtworkRef);

// Mirrors domain.ts's VersionLabel set — duplicated here so the wire
// whitelist stays self-describing next to the fields it gates.
const VERSION_LABEL_VALUES: ReadonlySet<string> = new Set([
  'live',
  'remix',
  'remaster',
  'clean',
  'explicit',
  'alternate',
]);

const isVersionLabels = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 16 &&
  new Set(value).size === value.length &&
  value.every((l) => typeof l === 'string' && VERSION_LABEL_VALUES.has(l));

const isProvenance = (value: unknown): boolean =>
  value === 'provider' || value === 'local';

const isEntityKindValue = (value: unknown): value is EntityKind =>
  value === 'album' || value === 'artist';

const isStorefrontValue = (value: unknown): boolean =>
  value === null ||
  (typeof value === 'string' && /^[A-Z]{2}$/.test(value));

const isThemeValue = (value: unknown): boolean =>
  value === 'dark' ||
  value === 'light' ||
  value === 'oled' ||
  value === 'system' ||
  value === 'adaptive';

const isQualityKbps = (value: unknown): boolean =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= 512;

const REVIEW_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'confirmed',
  'rejected',
  'dismissed',
]);

const isReviewStatus = (value: unknown): boolean =>
  typeof value === 'string' && REVIEW_STATUSES.has(value);

const isResolutionValue = (value: unknown): boolean =>
  value === null || isMatchResolution(value);

const isCandidateList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 64 &&
  value.every(isCandidateSnapshot);

const isOptTrackRef = (value: unknown): boolean =>
  value === null || isTrackRef(value);

/**
 * The whitelist — the exact set of (kind, field) pairs that may enter
 * a delta, each with its value contract. sync.md's "settings subset"
 * is the settings row literally: theme, storefront, the four provider
 * selections, quality tier, prefetch — nothing else (artwork bytes and
 * metered-download flags are per-device budgets and never sync).
 */
export const SYNC_FIELD_RULES: Readonly<
  Record<SyncRecordKind, Readonly<Record<string, FieldRule>>>
> = {
  recording: {
    title: rule(str(512)),
    artist: rule(optStr(512)),
    album: rule(optStr(512)),
    durationMs: rule(isOptSafeNonNegative),
    releaseYear: rule(isReleaseYear),
    artwork: rule(isArtworkList),
    explicit: rule(isOptBoolean),
    genre: rule(optStr(512)),
    isrc: rule(optStr(64)),
    versionLabels: rule(isVersionLabels),
    provenance: rule(isProvenance),
  },
  recordingSourceRef: {
    ref: rule(isTrackRef),
  },
  recordingMapping: {
    mapping: rule(isSourceMapping),
  },
  like: {
    like: rule(isLike),
  },
  entity: {
    kind: rule(isEntityKindValue),
    title: rule(str(512)),
    artistName: rule(optStr(512)),
    artwork: rule(isArtworkList),
    createdMs: rule(isSafeNonNegative),
  },
  entitySourceRef: {
    ref: rule(isEntityRef),
  },
  playlist: {
    name: rule(str(512)),
    createdMs: rule(isSafeNonNegative),
    updatedMs: rule(isSafeNonNegative),
  },
  playlistEntry: {
    playlistId: rule(str(64)),
    recordingId: rule(str(64)),
    position: rule(isFiniteNumber),
    selectedRef: rule(isOptTrackRef),
    addedMs: rule(isSafeNonNegative),
  },
  playEvent: {
    event: rule(isPlayEvent),
  },
  playCount: {
    count: rule(isSafeNonNegative, 'sum'),
    lastMs: rule(isSafeNonNegative, 'max'),
  },
  matchReview: {
    // Identity fields ride too — a review CREATED on another device
    // must materialize locally, and a receiver can't build the row
    // from mutable state alone (Review #46).
    recordingId: rule(str(64)),
    createdMs: rule(isSafeNonNegative),
    status: rule(isReviewStatus),
    resolution: rule(isResolutionValue),
    resolvedMs: rule(isOptSafeNonNegative),
    candidates: rule(isCandidateList),
  },
  settings: {
    theme: rule(isThemeValue),
    storefront: rule(isStorefrontValue),
    catalogProvider: rule(str(64)),
    playbackProvider: rule(str(64)),
    lyricsProvider: rule(optStr(64)),
    radioProvider: rule(optStr(64)),
    qualityKbps: rule(isQualityKbps),
    prefetch: rule(isBooleanValue),
    language: rule(optStr(24)),
  },
};

/** Whitelisted? Does the value satisfy the field's wire contract? */
export function syncFieldRule(
  kind: SyncRecordKind,
  field: string,
): FieldRule | undefined {
  const rules = SYNC_FIELD_RULES[kind];
  // Own-name match only — a wire field literally named 'constructor'
  // (or any Object.prototype member) must miss, not resolve the
  // inherited entry and crash on a non-rule object.
  return Object.hasOwn(rules, field) ? rules[field] : undefined;
}

export function isChangeEntry(value: unknown): value is ChangeEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'recordId',
      'field',
      'value',
      'tombstone',
      'hlc',
      'deviceId',
      'seq',
    ])
  ) {
    return false;
  }
  const { kind, recordId, field, tombstone, hlc, deviceId } = value;
  if (
    !isSyncRecordKind(kind) ||
    !isString(recordId, MAX_RECORD_ID) ||
    !isString(field, MAX_FIELD) ||
    typeof tombstone !== 'boolean' ||
    !isHlcStamp(hlc) ||
    !isString(deviceId, MAX_DEVICE_ID) ||
    !isEmissionSeq(value['seq'])
  ) {
    return false;
  }
  // The settings record is a declared singleton — an entry under any
  // other id materializes a shadow record no reader looks at.
  if (kind === 'settings' && recordId !== SETTINGS_RECORD_ID) {
    return false;
  }
  if (tombstone) {
    return field === TOMBSTONE_FIELD && value['value'] === null;
  }
  const fieldRule = syncFieldRule(kind, field);
  return fieldRule !== undefined && fieldRule.valid(value['value']);
}

export function isSyncCursor(value: unknown): value is SyncCursor {
  return (
    isRecord(value) &&
    Object.keys(value).length <= MAX_CURSOR_DEVICES &&
    Object.values(value).every(isSafeNonNegative)
  );
}

/**
 * The durable peer-mark table's shape: senders keyed by device id,
 * each row the sender's last advertised cursor. Rows keep the wire's
 * source bound; the sender count is deliberately unbounded — the
 * table is the floor that protects every remembered peer, so evicting
 * a sender would let compaction drop entries it never received. A
 * hard cap needs protocol-level peer retirement, which the wire does
 * not carry.
 */
export function isPeerMarks(
  value: unknown,
): value is Readonly<Record<string, SyncCursor>> {
  return (
    isRecord(value) &&
    Object.keys(value).every((sender) => isString(sender, MAX_DEVICE_ID)) &&
    Object.values(value).every(isSyncCursor)
  );
}

/**
 * Wire-level check for the materialized pull: the envelope plus the
 * same per-field whitelist + value contract `isChangeEntry` applies —
 * the projector casts these values into domain rows, so a field that
 * would never survive the delta path must not enter through this one.
 * Empty `fields` is the record's tombstone form and stays valid.
 */
export function isMaterializedRecord(
  value: unknown,
): value is MaterializedRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'recordId', 'fields']) ||
    !isSyncRecordKind(value['kind']) ||
    !isString(value['recordId'], MAX_RECORD_ID) ||
    !isRecord(value['fields'])
  ) {
    return false;
  }
  const kind = value['kind'];
  return Object.entries(value['fields']).every(([field, fieldValue]) => {
    const fieldRule =
      field.length <= MAX_FIELD ? syncFieldRule(kind, field) : undefined;
    return fieldRule !== undefined && fieldRule.valid(fieldValue);
  });
}

/** Envelope-level check; entries are validated per-row on apply. */
export function isSyncDelta(value: unknown): value is SyncDelta {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'formatVersion',
      'senderDeviceId',
      'cursor',
      'entries',
      'more',
      'skipped',
    ]) &&
    value['formatVersion'] === 1 &&
    isString(value['senderDeviceId'], MAX_DEVICE_ID) &&
    isSyncCursor(value['cursor']) &&
    Array.isArray(value['entries']) &&
    value['entries'].length <= MAX_DELTA_ENTRIES &&
    typeof value['more'] === 'boolean' &&
    isSkippedMap(value['skipped'])
  );
}

function isDivergenceSide(value: unknown): value is DivergenceSide {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['deviceId', 'hlc', 'tombstone', 'value']) &&
    isString(value['deviceId'], MAX_DEVICE_ID) &&
    isHlcStamp(value['hlc']) &&
    typeof value['tombstone'] === 'boolean'
  );
}

export function isDivergenceEntry(
  value: unknown,
): value is DivergenceEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'historyId',
      'seq',
      'kind',
      'recordId',
      'field',
      'loser',
      'winner',
      'observedMs',
      'origin',
    ]) &&
    isString(value['historyId'], 64) &&
    isSafeNonNegative(value['seq']) &&
    isSyncRecordKind(value['kind']) &&
    isString(value['recordId'], MAX_RECORD_ID) &&
    isString(value['field'], MAX_FIELD) &&
    isDivergenceSide(value['loser']) &&
    isDivergenceSide(value['winner']) &&
    isSafeNonNegative(value['observedMs']) &&
    (value['origin'] === 'local' || value['origin'] === 'remote')
  );
}

// ---- merge internals ------------------------------------------------------

type FieldCell = {
  /**
   * The decisive entry for outcome/divergence reporting: the merge
   * rule's winner over `live` — for 'sum', the largest single live
   * contribution.
   */
  winner: ChangeEntry;
  /**
   * The materialized field value: `winner.value` for 'lww'/'max', the
   * per-device component sum for 'sum'.
   */
  value: unknown;
  /**
   * Candidates newer than the record tombstone that could still win —
   * the per-partition (stamp, value) frontier. A dead entry never
   * resurfaces (tombstones only advance), and an entry dominated by a
   * same-partition candidate that BOTH postdates its stamp and
   * carries at least its value can never resurface either: any
   * tombstone that spares it spares the dominator too, so the
   * dominator would always beat it. For 'lww' this is always
   * `[winner]` — the max-stamp entry dominates every smaller stamp.
   * For 'max'/'sum' runner-ups stay only while undominated: a
   * larger-but-dead value must not poison the slot — after a
   * tombstone kills it, the smaller-but-newer write still wins, which
   * is what makes the max-merge convergent under reorder. The bound
   * is what keeps a grow-only 'sum' component at ~one entry per
   * device instead of retaining every superseded increment.
   */
  live: ChangeEntry[];
};

type RecordState = {
  readonly kind: SyncRecordKind;
  readonly recordId: string;
  /** Live candidates + winner per field. */
  readonly fields: Map<string, FieldCell>;
  /** The winning tombstone, if the record was ever deleted. */
  tombstone: ChangeEntry | undefined;
};

function divergenceKey(
  kind: SyncRecordKind,
  recordId: string,
  field: string,
  loser: DivergenceSide,
): string {
  // Injective encoding: recordId/field/deviceId may all carry the
  // KEY_SEP byte, so delimiter joins would let distinct losers
  // collide and get deduped away. JSON is unambiguous over a
  // fixed-arity tuple of strings and numbers.
  return JSON.stringify([
    kind,
    recordId,
    field,
    loser.deviceId,
    loser.hlc.l,
    loser.hlc.c,
  ]);
}

/** Emission ordinals are 1-based: 0 means "nothing observed". */
function isEmissionSeq(value: unknown): value is number {
  return isSafeNonNegative(value) && value >= 1;
}

/**
 * First index whose seq does not satisfy `before` — per-device logs
 * stay seq-sorted, so this is both the insert point and the start of
 * a (mark, …] window.
 */
function firstSeqIndex(
  list: readonly ChangeEntry[],
  before: (seq: number) => boolean,
): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(list[mid]?.seq ?? 0)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function isSkippedMap(
  value: unknown,
): value is Record<string, readonly number[]> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= MAX_CURSOR_DEVICES &&
    Object.values(value).every(
      (seqs) =>
        Array.isArray(seqs) &&
        seqs.length <= MAX_DELTA_ENTRIES &&
        seqs.every(isSafeNonNegative),
    )
  );
}

/**
 * Engine-owned entries are fully frozen — top level, `hlc`, `value`:
 * a caller mutating a delta's entry cannot corrupt ordering, dedupe
 * keys, or later merges. Hydrated entries freeze on load too.
 */
function deepFreezeValue(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Object.isFrozen(node)) {
      // A frozen subtree is already transitively frozen (cloneFrozen
      // output) — re-walking it buys nothing.
      return;
    }
    for (const child of Object.values(node)) {
      visit(child);
    }
    Object.freeze(node);
  };
  visit(value);
}

/**
 * One-pass JSON clone that freezes each node on the way out —
 * replaces the stringify/parse round-trip plus separate freeze walk
 * wire entries used to pay for twice. Only valid for JSON-shaped
 * values (the entry contract guarantees it), and cyclic input throws
 * by recursion depth just as `JSON.stringify` throws on it.
 */
function cloneFrozen(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      copy[i] = cloneFrozen(value[i]);
    }
    return Object.freeze(copy);
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = cloneFrozen(child);
  }
  return Object.freeze(copy);
}

export async function createSyncEngine(
  deps: SyncEngineDeps,
): Promise<Result<SyncEngine>> {
  if (
    deps === null ||
    typeof deps !== 'object' ||
    !isString(deps.deviceId, MAX_DEVICE_ID) ||
    deps.store === undefined ||
    deps.clock === undefined ||
    deps.ids === undefined ||
    deps.log === undefined
  ) {
    return err(appError('invalid-response', 'invalid sync engine deps'));
  }

  const store = deps.store;
  const clock = deps.clock;
  const ids = deps.ids;
  const log = deps.log;
  const deviceId = deps.deviceId;

  let tail: Promise<void> = Promise.resolve();
  function serialized<T>(op: () => Promise<Result<T>>): Promise<Result<T>> {
    const work = tail.then(op);
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /**
   * First-settle-wins against the queue: an op still waiting behind a
   * held serialized turn settles `cancelled` now instead of parking
   * until the in-flight store op finishes. The queued body still runs
   * and exits at its own signal check, so ordering is unchanged —
   * racing only unblocks the caller.
   */
  function cancellable<T>(
    work: Promise<Result<T>>,
    signal: CancellationSignal,
  ): Promise<Result<T>> {
    return new Promise<Result<T>>((resolve) => {
      const unsubscribe = signal.subscribe(() => {
        unsubscribe();
        resolve(err(appError('cancelled', 'cancelled')));
      });
      // The loser unsubscribes: a reused signal never retains one
      // listener per completed op (Promise.race leaves it parked).
      const settle = (result: Result<T>): void => {
        unsubscribe();
        resolve(result);
      };
      if (signal.cancelled) {
        settle(err(appError('cancelled', 'cancelled')));
        return;
      }
      // A rejecting op (a dep throwing past the op's own catches) must
      // settle typed too — a fulfillment-only handler would leave the
      // caller and the signal listener parked forever.
      void work.then(settle, (thrown: unknown) =>
        settle(err(fromUnknown(thrown))),
      );
    });
  }

  function now(): number | null {
    let value: number;
    try {
      value = clock.nowMs();
    } catch {
      return null;
    }
    return isSafeNonNegative(value) ? value : null;
  }

  function context(
    prefix: string,
    deadlineMs: number,
    signal: CancellationSignal,
  ): OperationContext {
    return { requestId: ids.next(prefix), deadlineMs, signal };
  }

  async function call<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await fn();
    } catch (thrown) {
      return err(fromUnknown(thrown));
    }
  }

  function warn(message: string): void {
    const atMs = now();
    if (atMs === null) {
      return;
    }
    void call(() => log.write({ level: 'warn', message, atMs })).then(
      () => undefined,
    );
  }

  /**
   * The op envelope every entry point shares: resolve the caller's
   * signal (a fresh never-cancelled source when absent), refuse early
   * when already cancelled, serialize the body behind the queue, and
   * race first-settle-wins cancellation against it. `at`/`deadlineMs`
   * arrive precomputed — the clock read lives inside the serialized
   * turn so a queued op timestamps at run time, not queue time.
   */
  function runOp<T>(
    signal: CancellationSignal | undefined,
    work: (
      sig: CancellationSignal,
      atMs: number,
      deadlineMs: number,
    ) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const sig = signal ?? new CancellationSource().signal;
    if (sig.cancelled) {
      return Promise.resolve(err(appError('cancelled', 'cancelled')));
    }
    return cancellable(
      serialized(async () => {
        if (sig.cancelled) {
          return err(appError('cancelled', 'cancelled'));
        }
        const at = now();
        if (at === null) {
          return err(
            appError('internal', 'clock returned an unsafe timestamp'),
          );
        }
        return work(
          sig,
          at,
          Math.min(at + OP_DEADLINE_MS, Number.MAX_SAFE_INTEGER),
        );
      }),
      sig,
    );
  }

  // ---- mutable merge state ------------------------------------------------

  const records = new Map<string, RecordState>();
  /**
   * All accepted entries (winners and losers alike), indexed per
   * emitting device and sorted by that device's emission seq — the
   * same ordering `sync_log`'s UNIQUE(device_id, seq) index already
   * provides durably. The lanes let exportDelta start each device at
   * the requester's mark with a binary search and merge the heads in
   * canonical stamp order, instead of filtering+sorting the whole log
   * per page per peer.
   */
  const logByDevice = new Map<string, ChangeEntry[]>();
  /**
   * Entries the merge state still references — field-cell `live`
   * members and record-winning tombstones. Compaction may drop a
   * logged entry only once it leaves this set AND every observed
   * peer's watermark passes its seq.
   */
  const mergeLive = new Set<ChangeEntry>();
  /**
   * Per-device export dry-tail cache: every logged seq `>= from` on
   * that device proved retention-retired under `floor`. Valid while
   * the floor hasn't regressed (floors only rise with the clock) and
   * the lane's tail hasn't grown — indexEntry drops the entry on any
   * append for the device.
   */
  const retiredTail = new Map<string, { from: number; floor: number }>();
  /**
   * The last contiguous watermarks each delta sender advertised —
   * `peerMarks[sender][src]` is the largest seq that peer provably
   * holds for `src`. Each apply replaces the row with the claimed
   * cursor — a live regression retires what a lost instance claimed.
   * Compaction drops an entry only when the per-source MINIMUM across
   * senders passes it: every peer we have heard from already holds it.
   */
  const peerMarks = new Map<string, Map<string, number>>();
  /**
   * Senders the durable peer-mark table remembered that have not
   * re-advertised a cursor this session. A restored mark is stale:
   * the wire carries no peer-instance token, so a deviceId surviving
   * a peer's rebuild may belong to a fresh instance that lost the
   * data its old claims covered. While a remembered peer stays
   * silent it contributes nothing to compaction — its floor
   * contribution is 0 for every device, which only ever delays
   * cleanup. A peer's first live cursor claim clears the staleness:
   * a monotone claim re-confirms the stored row, a regression proves
   * a rebuild — either way only the live claims govern from then on.
   */
  const stalePeers = new Set<string>();
  /**
   * Senders whose folded row has not been confirmed durable: a
   * `peerMarks` append is best-effort, so a sender stays flagged
   * until a store append carrying its row succeeds — the flag is
   * what retries the row on later writes, including claims that
   * change nothing. Without it a failed write would drop the peer
   * from the durable table entirely: after restart it remembered
   * nothing, pinned nothing, and compaction could discard entries
   * it still needed to catch up.
   */
  const dirtyPeerMarkSenders = new Set<string>();
  const seen = new Set<string>();
  /**
   * Per-device emission observation: `seenSeqs[d]` holds only
   * observed seqs still above the contiguous mark (folded seqs are
   * deleted as the mark passes them, so the set sizes to open relay
   * holes, not the log); `contiguous[d]` is the largest seq with no
   * gap below it.
   */
  const seenSeqs = new Map<string, Set<number>>();
  const contiguous = new Map<string, number>();
  /** Emission ordinal of this device's own next entry (appended only). */
  let localSeq = 0;
  const divergence: DivergenceEntry[] = [];
  const divergenceSeen = new Set<string>();
  let divergenceSeq = 0;
  /**
   * Hydrate-replay bookkeeping: `replaySeen` + the emission-ordinal
   * state below re-derive the original emit order so each replayed
   * emission lands on the ordinal it originally held; `divergenceFloor`
   * is the store's cumulative prune frontier — losers whose ordinal
   * sits below it were intentionally capped away and must not be
   * rebuilt (that would resurrect pruned history with fresh seqs and
   * churn the retained window on every restart).
   */
  const replaySeen = new Set<string>();
  /**
   * The original emission ordinal each loser entry produced — set
   * when the row is emitted (live) or replayed (repair), so
   * compaction can retire exactly the ordinals the entries it drops
   * held rather than approximating with a count.
   */
  const emittedAt = new Map<ChangeEntry, number>();
  /**
   * Emission ordinals compaction retired, sorted — hydrated from
   * the store's accumulated set. `nextEmissionOrdinal` is the next
   * unclaimed ordinal; `droppedOrdinalCursor` walks the sorted set
   * so ordinals the dropped entries held are skipped, landing every
   * replayed emission back on its original position.
   */
  const droppedEmissions: number[] = [];
  let droppedOrdinalCursor = 0;
  let nextEmissionOrdinal = 1;
  let divergenceFloor = 0;
  let hlc = new HybridClock();

  /**
   * Fold one entry's emission seq into the observed set and advance
   * the device's contiguous mark while buffered successors exist.
   * Seqs the mark passes are deleted as consumed — only seqs still
   * waiting on a hole stay buffered.
   */
  function foldSeq(source: string, seq: number): void {
    let mark = contiguous.get(source) ?? 0;
    if (seq <= mark) {
      return; // the mark already claims this seq
    }
    let set = seenSeqs.get(source);
    if (set === undefined) {
      set = new Set<number>();
      seenSeqs.set(source, set);
    }
    set.add(seq);
    while (set.delete(mark + 1)) {
      mark += 1;
    }
    contiguous.set(source, mark);
  }

  /**
   * The watermark map an append of `entries` would produce — computed
   * without touching engine state so a failed append can never
   * advance the cursor (the store folds these marks on its side).
   */
  function prospectiveMarks(
    entries: readonly ChangeEntry[],
    skipped: Record<string, readonly number[]> | undefined,
  ): Record<string, number> {
    const marks: Record<string, number> = {};
    const buffers = new Map<string, Set<number>>();
    const foldHypothetical = (dev: string, seq: number): void => {
      let buffer = buffers.get(dev);
      if (buffer === undefined) {
        buffer = new Set(seenSeqs.get(dev));
        buffers.set(dev, buffer);
        marks[dev] = contiguous.get(dev) ?? 0;
      }
      let mark = marks[dev] ?? 0;
      if (seq > mark) {
        buffer.add(seq);
        while (buffer.delete(mark + 1)) {
          mark += 1;
        }
        marks[dev] = mark;
      }
    };
    for (const [dev, seqs] of Object.entries(skipped ?? {})) {
      for (const seq of seqs) {
        foldHypothetical(dev, seq);
      }
    }
    for (const entry of entries) {
      foldHypothetical(entry.deviceId, entry.seq);
    }
    return marks;
  }

  /**
   * Trim the in-memory divergence history to its cap; returns the
   * oldest retained row's seq so the store can drop strictly below
   * it.
   */
  function pruneDivergence(): number | undefined {
    if (divergence.length <= DIVERGENCE_HISTORY_LIMIT) {
      return undefined;
    }
    const floorRow = divergence[divergence.length - DIVERGENCE_HISTORY_LIMIT];
    if (floorRow === undefined) {
      return undefined;
    }
    divergence.splice(0, divergence.length - DIVERGENCE_HISTORY_LIMIT);
    return floorRow.seq;
  }

  function commitSeqs(
    entries: readonly ChangeEntry[],
    skipped: Record<string, readonly number[]> | undefined,
  ): void {
    for (const entry of entries) {
      foldSeq(entry.deviceId, entry.seq);
    }
    if (skipped !== undefined) {
      for (const [dev, seqs] of Object.entries(skipped)) {
        for (const seq of seqs) {
          foldSeq(dev, seq);
        }
      }
    }
  }

  function cursorSnapshot(): SyncCursor {
    // The wire caps a cursor at MAX_CURSOR_DEVICES; keep the devices
    // with the most progress so a trimmed mark only costs re-shipped
    // (deduped) entries, never a wrong claim.
    const pairs = [...contiguous.entries()];
    pairs.sort((a, b) => b[1] - a[1]);
    const out: Record<string, number> = {};
    for (const [device, mark] of pairs.slice(0, MAX_CURSOR_DEVICES)) {
      out[device] = mark;
    }
    return out;
  }

  function toSide(entry: ChangeEntry): DivergenceSide {
    return {
      deviceId: entry.deviceId,
      hlc: entry.hlc,
      tombstone: entry.tombstone,
      value: entry.value,
    };
  }

  /** Advance the ordinal cursor past ordinals compaction retired. */
  function skipRetiredOrdinals(): void {
    while (true) {
      const retired = droppedEmissions[droppedOrdinalCursor];
      if (retired === undefined || retired > nextEmissionOrdinal) {
        return;
      }
      nextEmissionOrdinal = retired + 1;
      droppedOrdinalCursor += 1;
    }
  }

  /**
   * The ordinal this replayed emission originally held: the next
   * position compaction never retired, so survivors land back on
   * their own ordinals — never shifted past or below the floor by
   * an interleaved drop.
   */
  function claimEmissionOrdinal(): number {
    const ordinal = nextEmissionOrdinal;
    nextEmissionOrdinal += 1;
    skipRetiredOrdinals();
    return ordinal;
  }

  /**
   * `emit`:
   * - true — a live merge: every new loser materializes a row.
   * - 'repair' — hydrate replay of the durable log: a row is
   *   materialized only when no stored row covers the same loser key.
   *   This is what heals a dropped divergence append: the durable
   *   change log re-derives every loser deterministically, so a row
   *   that never reached the store is rebuilt on next boot instead of
   *   being suppressed as seen-but-absent.
   */
  function recordDivergence(
    out: DivergenceEntry[],
    loser: ChangeEntry,
    winner: ChangeEntry,
    emit: boolean | 'repair',
  ): void {
    const key = divergenceKey(
      loser.kind,
      loser.recordId,
      loser.field,
      toSide(loser),
    );
    if (emit === false) {
      return;
    }
    if (emit === 'repair') {
      // Replay emits the same distinct-loser sequence the original
      // merges produced, so each claimed ordinal equals the one the
      // event first received. Stored rows still exist (dedupe);
      // ordinals below the floor were intentionally pruned —
      // mark them seen so they are never rebuilt; anything missing
      // above the floor is a lost append worth repairing.
      if (replaySeen.has(key)) {
        return;
      }
      replaySeen.add(key);
      const ordinal = claimEmissionOrdinal();
      emittedAt.set(loser, ordinal);
      if (divergenceSeen.has(key)) {
        return;
      }
      divergenceSeen.add(key);
      if (ordinal < divergenceFloor) {
        return;
      }
    } else {
      if (divergenceSeen.has(key)) {
        return;
      }
      divergenceSeen.add(key);
      emittedAt.set(loser, divergenceSeq + 1);
    }
    divergenceSeq += 1;
    const at = now() ?? loser.hlc.l;
    const entry: DivergenceEntry = {
      historyId: ids.next('div'),
      seq: divergenceSeq,
      kind: loser.kind,
      recordId: loser.recordId,
      field: loser.field,
      loser: toSide(loser),
      winner: toSide(winner),
      observedMs: at,
      origin: loser.deviceId === deviceId ? 'local' : 'remote',
    };
    divergence.push(entry);
    out.push(entry);
  }

  /**
   * The one merge rule, shared by hydrate, local writes, and remote
   * applies: a tombstone competes against the prior tombstone only —
   * field survival is decided at read time by comparing each field's
   * stamp against the winning tombstone's. A field write competes
   * against the field's current winner (or by value for 'max'/'sum'
   * rules: larger numeric value, stamps break exact ties
   * deterministically), then against the tombstone. Every loser lands
   * in divergence.
   */
  function beats(
    candidate: ChangeEntry,
    rival: ChangeEntry,
    merge: FieldRule['merge'] | undefined,
  ): boolean {
    if (
      (merge === 'max' || merge === 'sum') &&
      typeof candidate.value === 'number' &&
      typeof rival.value === 'number'
    ) {
      return (
        candidate.value > rival.value ||
        (candidate.value === rival.value &&
          compareEntryTs(candidate, rival) > 0)
      );
    }
    return compareEntryTs(candidate, rival) > 0;
  }

  /** The merge rule's winner over a set of live candidates. */
  function pickWinner(
    merge: FieldRule['merge'] | undefined,
    candidates: readonly ChangeEntry[],
  ): ChangeEntry {
    let winner: ChangeEntry | undefined;
    for (const candidate of candidates) {
      if (winner === undefined || beats(candidate, winner, merge)) {
        winner = candidate;
      }
    }
    if (winner === undefined) {
      throw new RangeError('empty candidate set');
    }
    return winner;
  }

  /** One device's live component winner inside a 'sum' field. */
  function componentWinner(
    live: readonly ChangeEntry[],
    dev: string,
  ): ChangeEntry | undefined {
    let best: ChangeEntry | undefined;
    for (const candidate of live) {
      if (
        candidate.deviceId === dev &&
        (best === undefined || beats(candidate, best, 'sum'))
      ) {
        best = candidate;
      }
    }
    return best;
  }

  /**
   * The materialized 'sum' value: Σ over per-device live components,
   * saturated at MAX_SAFE_INTEGER — safe-integer input domains are not
   * closed under addition, and the cap keeps the merged view inside
   * the wire's own contract identically on every replica.
   */
  function sumValue(live: readonly ChangeEntry[]): number {
    let total = 0;
    const devs = new Set<string>();
    for (const candidate of live) {
      devs.add(candidate.deviceId);
    }
    for (const dev of devs) {
      const component = componentWinner(live, dev);
      if (typeof component?.value === 'number') {
        total += component.value;
        if (total > Number.MAX_SAFE_INTEGER) {
          return Number.MAX_SAFE_INTEGER;
        }
      }
    }
    return total;
  }

  /**
   * Insert into a cell's live frontier — the minimal candidate set
   * that can still win. A candidate dominates `entry` when it is in
   * the same merge partition, postdates its stamp, and carries at
   * least its value: every tombstone that would spare `entry` also
   * spares the dominator, so a dominated entry could never resurface
   * and stays out of the set. Symmetrically, an inserted entry prunes
   * the same-partition members IT now dominates. Both directions
   * record the dropped member in divergence like any other loser —
   * the row's dedupe key suppresses repeats. 'sum' partitions by
   * emitting device (a device's component winner is its own max);
   * 'max' takes the whole field as one partition.
   */
  function liveInsert(
    live: ChangeEntry[],
    entry: ChangeEntry,
    byDevice: boolean,
    divs: DivergenceEntry[],
    emit: boolean | 'repair',
  ): void {
    const mine = entry.value;
    for (const cand of live) {
      if (
        (byDevice && cand.deviceId !== entry.deviceId) ||
        compareEntryTs(cand, entry) <= 0 ||
        typeof cand.value !== 'number' ||
        typeof mine !== 'number' ||
        cand.value < mine
      ) {
        continue;
      }
      // Dominated: dead weight — the dominator's fate bounds this
      // entry's under any tombstone order. An equal value isn't a
      // loss worth a row — the frontier only gained a newer stamp
      // for what it already showed (same rule as the rival path).
      if (!jsonEquals(cand.value, mine)) {
        recordDivergence(divs, entry, cand, emit);
      }
      return;
    }
    live.push(entry);
    mergeLive.add(entry);
    for (let i = live.length - 2; i >= 0; i -= 1) {
      const cand = live[i];
      if (
        cand === undefined ||
        cand === entry ||
        (byDevice && cand.deviceId !== entry.deviceId) ||
        typeof cand.value !== 'number' ||
        typeof mine !== 'number' ||
        cand.value > mine ||
        compareEntryTs(cand, entry) > 0
      ) {
        continue;
      }
      // Pruned but equal-valued: the candidate leaves the frontier
      // without a row — no value the merge reports actually moved.
      if (!jsonEquals(cand.value, mine)) {
        recordDivergence(divs, cand, entry, emit);
      }
      mergeLive.delete(cand);
      live.splice(i, 1);
    }
  }

  function reduce(
    entry: ChangeEntry,
    emit: boolean | 'repair',
  ): { outcome: MergeOutcome; divergences: DivergenceEntry[] } {
    const key = `${entry.kind}${KEY_SEP}${entry.recordId}`;
    let record = records.get(key);
    if (record === undefined) {
      record = {
        kind: entry.kind,
        recordId: entry.recordId,
        fields: new Map<string, FieldCell>(),
        tombstone: undefined,
      };
      records.set(key, record);
    }
    const divs: DivergenceEntry[] = [];

    if (entry.tombstone) {
      const current = record.tombstone;
      if (current !== undefined && compareEntryTs(entry, current) <= 0) {
        recordDivergence(divs, entry, current, emit);
        return {
          outcome: { type: 'superseded', entry, winner: current },
          divergences: divs,
        };
      }
      if (current !== undefined) {
        recordDivergence(divs, current, entry, emit);
        mergeLive.delete(current);
      }
      // The newer tombstone kills every live candidate stamped at or
      // below it. A killed winner is displaced; a killed runner-up
      // only gets a divergence row when it has none yet (dedupe).
      const killed: ChangeEntry[] = [];
      for (const [field, cell] of record.fields) {
        const rule = syncFieldRule(record.kind, field);
        const survivors: ChangeEntry[] = [];
        for (const candidate of cell.live) {
          if (compareEntryTs(candidate, entry) <= 0) {
            recordDivergence(divs, candidate, entry, emit);
            mergeLive.delete(candidate);
          } else {
            survivors.push(candidate);
          }
        }
        if (survivors.length === 0) {
          record.fields.delete(field);
        } else {
          const winner = pickWinner(rule?.merge, survivors);
          record.fields.set(field, {
            winner,
            live: survivors,
            value:
              rule?.merge === 'sum'
                ? sumValue(survivors)
                : winner.value,
          });
        }
        if (compareEntryTs(cell.winner, entry) <= 0) {
          killed.push(cell.winner);
        }
      }
      record.tombstone = entry;
      mergeLive.add(entry);
      return {
        outcome: { type: 'applied', entry, displaced: killed },
        divergences: divs,
      };
    }

    const rule = syncFieldRule(entry.kind, entry.field);
    const cell = record.fields.get(entry.field);
    const tomb = record.tombstone;

    // Dead on arrival: stamped at or below the winning tombstone. It
    // can never resurface, so it does not join the candidates — but
    // the losing value is preserved in history like any other loser.
    if (tomb !== undefined && compareEntryTs(entry, tomb) <= 0) {
      recordDivergence(divs, entry, tomb, emit);
      return {
        outcome: { type: 'superseded', entry, winner: tomb },
        divergences: divs,
      };
    }

    // The entry's contest: a 'sum' entry competes only within its own
    // device's component — cross-device counts accumulate rather than
    // displace; everything else competes for the whole slot.
    const rival =
      rule?.merge === 'sum'
        ? componentWinner(cell?.live ?? [], entry.deviceId)
        : cell?.winner;

    if (rival !== undefined && !beats(entry, rival, rule?.merge)) {
      if (!jsonEquals(entry.value, rival.value)) {
        recordDivergence(divs, entry, rival, emit);
      }
      // A loser still joins the candidate frontier for 'max'/'sum' —
      // it resurfaces if its rival dies to a later tombstone. Only
      // undominated losers join (a dominated one is dead weight);
      // neither winner nor value can move since the rival stays.
      if (
        cell !== undefined &&
        (rule?.merge === 'max' || rule?.merge === 'sum')
      ) {
        liveInsert(cell.live, entry, rule.merge === 'sum', divs, emit);
      }
      return {
        outcome: { type: 'superseded', entry, winner: rival },
        divergences: divs,
      };
    }

    // Entry won its contest: the rival (if any) is displaced — for
    // 'sum' that is only the device's own previous component winner.
    const displaced: ChangeEntry[] = [];
    if (rival !== undefined) {
      displaced.push(rival);
      if (!jsonEquals(rival.value, entry.value)) {
        recordDivergence(divs, rival, entry, emit);
      }
    }
    if (rule === undefined || rule.merge === 'lww') {
      for (const stale of cell?.live ?? []) {
        mergeLive.delete(stale);
      }
      record.fields.set(entry.field, {
        winner: entry,
        live: [entry],
        value: entry.value,
      });
      mergeLive.add(entry);
    } else {
      const live = cell?.live ?? [];
      liveInsert(live, entry, rule.merge === 'sum', divs, emit);
      const winner = pickWinner(rule?.merge, live);
      record.fields.set(entry.field, {
        winner,
        live,
        value: rule.merge === 'sum' ? sumValue(live) : winner.value,
      });
    }
    return {
      outcome: { type: 'applied', entry, displaced },
      divergences: divs,
    };
  }

  // ---- persistence --------------------------------------------------------

  /**
   * Add an accepted entry to its device's seq-sorted lane. Emissions
   * append in order in the common case; a relayed entry arriving
   * after a later seq of the same device inserts at its sorted
   * position, so exportDelta can binary-search "above the mark".
   */
  function indexEntry(entry: ChangeEntry): void {
    seen.add(entryKey(entry));
    retiredTail.delete(entry.deviceId);
    let list = logByDevice.get(entry.deviceId);
    if (list === undefined) {
      list = [];
      logByDevice.set(entry.deviceId, list);
    }
    const last = list[list.length - 1];
    if (last === undefined || entry.seq > last.seq) {
      list.push(entry);
      return;
    }
    list.splice(firstSeqIndex(list, (seq) => seq < entry.seq), 0, entry);
  }

  async function appendLog(
    entries: readonly ChangeEntry[],
    skipped: Record<string, readonly number[]> | undefined,
    signal: CancellationSignal,
    deadlineMs: number,
    peerMark?: { sender: string; marks: SyncCursor },
  ): Promise<Result<void>> {
    const write: SyncLogWrite = {
      entries,
      watermarks: prospectiveMarks(entries, skipped),
      // The delta sender's folded claim rides the entries append — a
      // peer's presence is durable iff the apply that carried it
      // acked, so a restart can never forget a peer whose entries the
      // log accepted while its mark sat uncommitted.
      ...(peerMark === undefined
        ? {}
        : { peerMarks: { [peerMark.sender]: peerMark.marks } }),
    };
    const appended = await call(() =>
      store.append(write, context('sync-app', deadlineMs, signal)),
    );
    if (!appended.ok) {
      return err(appended.error);
    }
    // Cursor state commits only once the write is durable — a failed
    // append must never advertise entries this device never accepted.
    commitSeqs(entries, skipped);
    for (const entry of entries) {
      indexEntry(entry);
    }
    if (peerMark !== undefined) {
      dirtyPeerMarkSenders.delete(peerMark.sender);
    }
    return ok(undefined);
  }

  /**
   * What `planCompaction` computed but has not committed: the
   * merge-dead entries to drop, the shrunken lanes to install, and
   * the emission ordinals the dropped entries held.
   */
  type CompactionPlan = {
    readonly dropped: readonly ChangeEntry[];
    readonly lanes: readonly (readonly [string, ChangeEntry[]])[];
    readonly ordinals: readonly number[];
  };

  /**
   * Persist newly-detected divergence rows and prune the history once
   * it exceeds its bound. A compaction `plan` and pending peer-mark
   * rows ride the same durable write so the log deletes and the
   * watermark claims land atomically with the merge's own writes —
   * the in-memory lanes drop only after the append commits, so a
   * transient failure leaves the log intact for the next plan.
   *
   * Every pending peer-mark row re-issues on EVERY write — an
   * append is best-effort, so a sender stays flagged
   * (`dirtyPeerMarkSenders`) until a write carrying its row
   * confirms. Retries need no fresh claim: an unchanged cursor still
   * emits the dirty rows here, and one sender's apply retries rows
   * another sender left pending.
   */
  async function appendDivergence(
    rows: readonly DivergenceEntry[],
    plan: CompactionPlan | undefined,
    signal: CancellationSignal,
    deadlineMs: number,
  ): Promise<void> {
    const drops = plan?.dropped ?? [];
    // A Map — not a plain record — so a device literally named
    // `__proto__` lands as data instead of mutating a prototype.
    const pendingRows = new Map<string, SyncCursor>();
    for (const sender of dirtyPeerMarkSenders) {
      const row = peerMarks.get(sender);
      if (row !== undefined) {
        pendingRows.set(sender, Object.fromEntries(row));
      }
    }
    if (rows.length === 0 && drops.length === 0 && pendingRows.size === 0) {
      return;
    }
    const dropBefore = pruneDivergence();
    const write: SyncLogWrite = {
      ...(rows.length > 0 ? { divergence: rows } : {}),
      ...(dropBefore === undefined
        ? {}
        : { dropDivergenceBefore: dropBefore }),
      ...(drops.length > 0
        ? {
          dropEntries: drops.map((entry) => ({
            deviceId: entry.deviceId,
            seq: entry.seq,
          })),
          // The ordinals the dropped entries held — union-folded
          // durably so hydrate replay can skip retired positions.
          ...(plan !== undefined && plan.ordinals.length > 0
            ? { divergenceDroppedEmissions: plan.ordinals }
            : {}),
        }
        : {}),
      ...(pendingRows.size > 0
        ? { peerMarks: Object.fromEntries(pendingRows) }
        : {}),
    };
    const appended = await call(() =>
      store.append(write, context('sync-div', deadlineMs, signal)),
    );
    if (!appended.ok) {
      warn(`sync divergence history append failed: ${appended.error.kind}`);
      return;
    }
    // The write confirmed — retire the pending rows it carried.
    // Ops serialize, so nothing could re-fold between the snapshot
    // above and this clearing.
    for (const sender of pendingRows.keys()) {
      dirtyPeerMarkSenders.delete(sender);
    }
    if (plan !== undefined) {
      commitCompaction(plan);
    }
  }

  /**
   * Fold the sender's advertised contiguous watermarks into the peer
   * table — `peerMarks[sender][src]` becomes the largest seq the
   * sender provably holds for `src`. A cursor is a COMPLETE claim,
   * not a delta: the folded row replaces wholesale, matching the
   * write's per-sender replace — a live regression (a peer rebuilt
   * under the same id) must retire the marks its lost instance
   * claimed, not max-fold over them. The live claim also lifts the
   * sender's hydrate-restored staleness: whatever the durable table
   * remembered, the claims observed this session now govern.
   *
   * Bounds: a row is exactly one wire-validated cursor, so the
   * MAX_CURSOR_DEVICES source bound comes free from `isSyncDelta`.
   * The sender count stays unbounded on purpose: a sender's row is
   * what stops compaction dropping entries that peer never received,
   * so evicting one is a data-loss direction, and a safe cap would
   * need protocol-level peer retirement the wire does not carry.
   */
  function notePeerCursor(sender: string, cursor: SyncCursor): void {
    const claims = new Map<string, number>(Object.entries(cursor));
    const prev = peerMarks.get(sender);
    let changed = prev === undefined || prev.size !== claims.size;
    if (!changed && prev !== undefined) {
      for (const [src, mark] of claims) {
        if (prev.get(src) !== mark) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      peerMarks.set(sender, claims);
    }
    if (stalePeers.delete(sender) || changed) {
      dirtyPeerMarkSenders.add(sender);
    }
  }

  /**
   * Drop dead log entries every observed peer already holds. An entry
   * is compactable once the per-source MINIMUM across all advertised
   * peer watermarks passes its seq AND no merge state references it.
   * Merge-live candidates and winning tombstones always stay — a
   * fresh peer needs them to materialize the same state — while the
   * dropped seqs surface as `skipped` holes on later exports so a
   * new device's contiguous cursor still crosses the region. The
   * local device's newest seq is never dropped: hydration rebuilds
   * `localSeq` from the max stored row, and losing it would reuse a
   * seq the log's UNIQUE(device_id, seq) would then swallow.
   */
  function planCompaction(): CompactionPlan {
    const dropped: ChangeEntry[] = [];
    const lanes: [string, ChangeEntry[]][] = [];
    const ordinals: number[] = [];
    if (peerMarks.size === 0 || stalePeers.size > 0) {
      // A remembered-but-silent peer contributes 0 to every floor —
      // its durable marks are stale until its next live claim — so
      // while any remembered peer hasn't re-advertised this session
      // the minimum over all senders can never exceed 0 anyway.
      return { dropped, lanes, ordinals };
    }
    for (const [dev, list] of logByDevice) {
      // Iterative min: peerMarks is unbounded (one entry per delta
      // sender) — a spread would throw RangeError past the runtime's
      // argument limit.
      let floor = Infinity;
      for (const marks of peerMarks.values()) {
        floor = Math.min(floor, marks.get(dev) ?? 0);
      }
      if (floor <= 0) {
        // A peer that never claimed this device keeps everything.
        continue;
      }
      let boundary = 0;
      const keptPrefix: ChangeEntry[] = [];
      for (; boundary < list.length; boundary += 1) {
        const entry = list[boundary];
        if (entry === undefined || entry.seq > floor) {
          break;
        }
        if (
          mergeLive.has(entry) ||
          (dev === deviceId && entry.seq === localSeq)
        ) {
          keptPrefix.push(entry);
        } else {
          dropped.push(entry);
          // The emission ordinal this entry held retires with it —
          // recorded durably so replay keeps survivors on their
          // original ordinals instead of sliding them past the
          // dropped ones.
          const ordinal = emittedAt.get(entry);
          if (ordinal !== undefined && !ordinals.includes(ordinal)) {
            ordinals.push(ordinal);
          }
        }
      }
      if (keptPrefix.length !== boundary) {
        lanes.push([dev, [...keptPrefix, ...list.slice(boundary)]]);
      }
    }
    return { dropped, lanes, ordinals };
  }

  /**
   * Apply a compaction plan the store has durably committed: shrink
   * the lanes and release dedupe/ordinal bookkeeping for the dropped
   * entries. Runs only after `store.append` succeeds — a transient
   * failure must leave the log whole so a later plan can retry.
   */
  function commitCompaction(plan: CompactionPlan): void {
    for (const [dev, lane] of plan.lanes) {
      logByDevice.set(dev, lane);
    }
    for (const entry of plan.dropped) {
      // The seq is below our own contiguous mark too, so a
      // redelivery re-applies harmlessly (it merges dead again
      // and is re-dropped) — keeping the key would pin dedupe
      // memory for every compacted entry forever.
      seen.delete(entryKey(entry));
      emittedAt.delete(entry);
    }
  }

  function validLocalWrite(
    input: LocalWrite,
  ): Result<LocalWrite> {
    if (input === null || typeof input !== 'object') {
      return err(appError('invalid-response', 'invalid local write'));
    }
    if (!isSyncRecordKind(input.kind)) {
      return err(appError('invalid-response', 'unknown record kind'));
    }
    if (!isString(input.recordId, MAX_RECORD_ID)) {
      return err(appError('invalid-response', 'invalid record id'));
    }
    if (
      input.kind === 'settings' &&
      input.recordId !== SETTINGS_RECORD_ID
    ) {
      return err(
        appError('invalid-response', 'settings is a singleton record'),
      );
    }
    if ('tombstone' in input) {
      if (input.tombstone !== true) {
        return err(appError('invalid-response', 'invalid tombstone write'));
      }
      return ok(input);
    }
    if (
      !('field' in input) ||
      !isString(input.field, MAX_FIELD) ||
      input.field === TOMBSTONE_FIELD
    ) {
      return err(appError('invalid-response', 'invalid field'));
    }
    const fieldRule = syncFieldRule(input.kind, input.field);
    if (fieldRule === undefined) {
      return err(
        appError(
          'not-applicable',
          `${input.kind}.${input.field} does not sync`,
        ),
      );
    }
    if (!fieldRule.valid(input.value)) {
      return err(
        appError(
          'invalid-response',
          `${input.kind}.${input.field} failed its contract`,
        ),
      );
    }
    return ok(input);
  }

  /**
   * 'sum' callers assert the desired AGGREGATE — the merged value the
   * field should show — because the domain row is exactly that. The
   * stamped entry must carry only THIS device's component (the merge
   * sums per-device winners), so translate: component = target minus
   * what peer components already contribute. Clamped at 0 — a target
   * below the remote share can't be expressed and the remote share
   * honestly survives.
   */
  function sumComponentFor(
    input: Extract<LocalWrite, { field: string }>,
  ): unknown {
    const rule = syncFieldRule(input.kind, input.field);
    if (rule?.merge !== 'sum' || typeof input.value !== 'number') {
      return input.value;
    }
    const record = records.get(`${input.kind}${KEY_SEP}${input.recordId}`);
    const cell = record?.fields.get(input.field);
    const remoteShare = sumValue(
      (cell?.live ?? []).filter((e) => e.deviceId !== deviceId),
    );
    return Math.max(0, input.value - remoteShare);
  }

  async function writeChanges(
    inputs: readonly LocalWrite[],
    signal: CancellationSignal | undefined,
    /**
     * `restoreLoser` only: the stored loser value is already a 'sum'
     * component — translating it through `sumComponentFor` again
     * would subtract the remote share twice and clamp the restore
     * to zero. Domain-originated writes stay aggregate-asserted.
     */
    preNormalized = false,
  ): Promise<Result<readonly LocalChangeResult[]>> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return err(appError('invalid-response', 'empty local write'));
    }
    for (const input of inputs) {
      const checked = validLocalWrite(input);
      if (!checked.ok) {
        return err(checked.error);
      }
    }
    return runOp(signal, async (sig, at, deadlineMs) => {
      let entries: ChangeEntry[];
      try {
        entries = inputs.map((input, index) => {
          const stamp = hlc.tick(at);
          const entry: ChangeEntry = {
            kind: input.kind,
            recordId: input.recordId,
            ...('tombstone' in input
              ? { field: TOMBSTONE_FIELD, value: null, tombstone: true }
              : {
                field: input.field,
                // Own the value: the caller keeps its mutable object,
                // the engine freezes its clone — same ownership rule
                // as accepted wire entries.
                value: cloneFrozen(
                  preNormalized ? input.value : sumComponentFor(input),
                ),
                tombstone: false,
              }),
            hlc: stamp,
            deviceId,
            seq: localSeq + index + 1,
          };
          deepFreezeValue(entry);
          return entry;
        });
      } catch (thrown) {
        return err(fromUnknown(thrown));
      }
      // Durable first: the change log is the source of truth; merge
      // state is derived from it.
      const appended = await appendLog(entries, undefined, sig, deadlineMs);
      if (!appended.ok) {
        return err(appended.error);
      }
      // Emission ordinals commit only for durably appended entries —
      // a failed write burns no seq, so the emitted stream stays
      // gap-free.
      localSeq += entries.length;
      const results: LocalChangeResult[] = [];
      const divs: DivergenceEntry[] = [];
      for (const entry of entries) {
        const merged = reduce(entry, true);
        divs.push(...merged.divergences);
        results.push({ entry, outcome: merged.outcome });
      }
      await appendDivergence(divs, undefined, sig, deadlineMs);
      return ok(results);
    });
  }

  /** Unwrap the single-write batch both write entry points share. */
  function firstWritten(
    batch: Result<readonly LocalChangeResult[]>,
  ): Result<LocalChangeResult> {
    if (!batch.ok) {
      return err(batch.error);
    }
    const first = batch.value[0];
    return first === undefined
      ? err(appError('internal', 'local write produced no entry'))
      : ok(first);
  }

  async function localChange(
    input: LocalWrite,
    signal?: CancellationSignal,
  ): Promise<Result<LocalChangeResult>> {
    return firstWritten(await writeChanges([input], signal));
  }

  async function exportDelta(
    since?: SyncCursor,
    limit = MAX_DELTA_ENTRIES,
    signal?: CancellationSignal,
  ): Promise<Result<SyncDelta>> {
    if (since !== undefined && !isSyncCursor(since)) {
      return err(appError('invalid-response', 'invalid sync cursor'));
    }
    if (!isSafeNonNegative(limit) || limit < 1) {
      return err(appError('invalid-response', 'invalid delta limit'));
    }
    const bound = Math.min(limit, MAX_DELTA_ENTRIES);
    return runOp(signal, async (_sig, at) => {
      const retainedFloor = at - PLAY_HISTORY_RETENTION_MS;
      // Seqs dropped by the retention filter inside this request's
      // window — collected per device so the receiver's contiguous
      // cursor can cross the holes (otherwise a permanently-dropped
      // seq stalls every later page forever).
      const retired = new Map<string, number[]>();
      const noteRetired = (dev: string, seq: number): void => {
        const list = retired.get(dev);
        if (list === undefined) {
          retired.set(dev, [seq]);
        } else {
          list.push(seq);
        }
      };
      // Per-device lanes sorted by emission seq: each lane starts at
      // the requester's mark via binary search and the heads merge in
      // canonical order, so a page reads only the seqs it ships — no
      // whole-log scan or global sort.
      type Lane = {
        readonly dev: string;
        readonly list: readonly ChangeEntry[];
        pos: number;
        head: ChangeEntry | undefined;
      };
      const seek = (lane: Lane): void => {
        const dry = retiredTail.get(lane.dev);
        const start = lane.pos;
        while (lane.pos < lane.list.length) {
          const entry = lane.list[lane.pos];
          if (entry === undefined) {
            break;
          }
          if (
            dry !== undefined &&
            dry.floor <= retainedFloor &&
            entry.seq >= dry.from
          ) {
            // The whole remaining tail proved retired under a floor
            // this request still honors — no rescan.
            lane.pos = lane.list.length;
            lane.head = undefined;
            return;
          }
          lane.pos += 1;
          // History is a bounded window (data.md): a play event
          // beyond the retention window would be pruned on the
          // receiver's next write anyway, so it never ships.
          if (
            entry.kind === 'playEvent' &&
            !entry.tombstone &&
            isPlayEvent(entry.value) &&
            entry.value.playedMs < retainedFloor
          ) {
            noteRetired(lane.dev, entry.seq);
            continue;
          }
          lane.head = entry;
          return;
        }
        lane.head = undefined;
        const first = lane.list[start];
        if (first !== undefined) {
          retiredTail.set(lane.dev, {
            from: first.seq,
            floor: retainedFloor,
          });
        }
      };
      const lanes: Lane[] = [];
      for (const [dev, list] of logByDevice) {
        const mark = since?.[dev] ?? 0;
        const pos = firstSeqIndex(list, (seq) => seq <= mark);
        if (pos < list.length) {
          const lane: Lane = { dev, list, pos, head: undefined };
          seek(lane);
          lanes.push(lane);
        }
      }
      const entries: ChangeEntry[] = [];
      while (entries.length < bound) {
        let best: Lane | undefined;
        let bestHead: ChangeEntry | undefined;
        for (const lane of lanes) {
          const head = lane.head;
          if (
            head !== undefined &&
            (bestHead === undefined || compareEntryTs(head, bestHead) < 0)
          ) {
            best = lane;
            bestHead = head;
          }
        }
        if (best === undefined || bestHead === undefined) {
          break;
        }
        entries.push(bestHead);
        seek(best);
      }
      const more = lanes.some((lane) => lane.head !== undefined);
      // Skipped seqs are listed only up to the largest seq this page
      // ships for that device — beyond-page holes are listed by the
      // page that reaches them. If nothing ships for a device its
      // retired tail needs no listing: an empty window stalls nothing.
      const shippedMax = new Map<string, number>();
      for (const entry of entries) {
        const current = shippedMax.get(entry.deviceId) ?? 0;
        if (entry.seq > current) {
          shippedMax.set(entry.deviceId, entry.seq);
        }
      }
      const skipped: Record<string, readonly number[]> = {};
      for (const [dev, shippedBound] of shippedMax) {
        const mark = since?.[dev] ?? 0;
        const listed = new Set<number>();
        // Seq holes this replica already accounts for — skips learned
        // from an upstream peer and rows pruned below its own
        // contiguous mark. Without re-listing them a relay leaves
        // downstream cursors stalled below the gaps forever, so every
        // later page re-ships the same entries. Only seqs at or below
        // this replica's contiguous mark may be claimed absent — a
        // hole above it is unknown, not absent.
        const accounted = Math.min(shippedBound, contiguous.get(dev) ?? 0);
        // The lane already holds every present seq in order — walk
        // only the (mark, accounted] slice instead of a presence set
        // built over the whole log.
        const list = logByDevice.get(dev) ?? [];
        const present = new Set<number>();
        for (
          let i = firstSeqIndex(list, (seq) => seq <= mark);
          i < list.length;
          i += 1
        ) {
          const seq = list[i]?.seq;
          if (seq === undefined || seq > accounted) {
            break;
          }
          present.add(seq);
        }
        // Emit at most the envelope bound: seqs past it are listed by
        // the page whose higher requester mark reaches them.
        for (
          let seq = mark + 1;
          seq <= accounted && listed.size < MAX_DELTA_ENTRIES;
          seq += 1
        ) {
          if (!present.has(seq)) {
            listed.add(seq);
          }
        }
        for (const seq of retired.get(dev) ?? []) {
          if (seq > mark && seq <= shippedBound) {
            listed.add(seq);
          }
        }
        if (listed.size > 0) {
          skipped[dev] = [...listed]
            .sort((a, b) => a - b)
            .slice(0, MAX_DELTA_ENTRIES);
        }
      }
      const doc: SyncDelta = {
        formatVersion: 1,
        senderDeviceId: deviceId,
        cursor: cursorSnapshot(),
        entries,
        more,
        skipped,
      };
      return ok(doc);
    });
  }

  async function applyDelta(
    doc: unknown,
    senderDeviceId?: string,
    signal?: CancellationSignal,
  ): Promise<Result<ApplyResult>> {
    if (!isSyncDelta(doc)) {
      return err(appError('invalid-message', 'malformed sync delta'));
    }
    // The doc's sender stamp is a claim, not an identity — it keys
    // peerMarks/stalePeers and the durable mark row, so a stamp that
    // does not match the authenticated session id is a forgery that
    // must never fold. An absent id means an unauthenticated source
    // and the claim folds as-is.
    if (
      senderDeviceId !== undefined &&
      doc.senderDeviceId !== senderDeviceId
    ) {
      return err(
        appError('invalid-message', 'sync: forged senderDeviceId'),
      );
    }
    return runOp(signal, async (sig, at, deadlineMs) => {
      const outcomes: MergeOutcome[] = [];
      const valid: ChangeEntry[] = [];
      const inDoc = new Set<string>();
      const rawEntries: readonly unknown[] = doc.entries;
      rawEntries.forEach((raw, index) => {
        if (!isChangeEntry(raw)) {
          outcomes.push({
            type: 'rejected',
            index,
            reason: 'malformed or non-syncable entry',
          });
          return;
        }
        const key = entryKey(raw);
        if (inDoc.has(key)) {
          outcomes.push({
            type: 'rejected',
            index,
            reason: 'duplicate stamp within delta',
          });
          return;
        }
        inDoc.add(key);
        // Own the wire bytes: the caller's doc stays mutable after we
        // return, so accepted entries are deep-cloned then frozen —
        // the log, winners map, and divergence sides never alias
        // caller-owned objects. Values are JSON-shaped by the
        // whitelist contract, so a JSON clone is exact; cloneFrozen
        // folds the freeze walk into the clone pass.
        const owned = cloneFrozen(raw) as ChangeEntry;
        valid.push(owned);
      });
      // Canonical order: every device that receives the same set of
      // entries merges them identically, divergence included.
      valid.sort(compareEntryTs);
      // Preflight the clock fold on a shadow: a terminal remote stamp
      // must fail BEFORE anything is durable — a post-append throw
      // would leave entries durable-but-unmerged until restart.
      try {
        const shadow = new HybridClock(hlc.stamp());
        for (const entry of valid) {
          shadow.receive(entry.hlc, at);
        }
      } catch (thrown) {
        return err(fromUnknown(thrown));
      }
      const fresh: ChangeEntry[] = [];
      for (const entry of valid) {
        if (seen.has(entryKey(entry))) {
          outcomes.push({ type: 'duplicate', entry });
        } else {
          fresh.push(entry);
        }
      }

      // The sender's cursor is its own contiguous watermark claim —
      // folded before the entries append so the row rides that same
      // durable write: a peer's presence lands atomically with the
      // delta carrying its claim, and an apply that can't persist the
      // mark errors out rather than acking without it. Once every
      // observed peer advertises a seq as held, a dead log row below
      // the floor can never be needed again and is dropped from both
      // the in-memory lanes and durable sync_log.
      notePeerCursor(doc.senderDeviceId, doc.cursor);
      const foldedRow = peerMarks.get(doc.senderDeviceId);
      // A cursor-only claim that changed nothing (no fresh entries,
      // no skipped holes, a row already durable) is a pure re-confirm
      // — skip the append so an idle round costs the store no write.
      const needsLog =
        fresh.length > 0 ||
        (doc.skipped !== undefined &&
          Object.keys(doc.skipped).length > 0) ||
        dirtyPeerMarkSenders.has(doc.senderDeviceId);
      if (needsLog) {
        const appended = await appendLog(
          fresh,
          doc.skipped,
          sig,
          deadlineMs,
          foldedRow === undefined
            ? undefined
            : {
                sender: doc.senderDeviceId,
                marks: Object.fromEntries(foldedRow),
              },
        );
        if (!appended.ok) {
          return err(appended.error);
        }
      }
      // Once fresh entries are durable the merge runs to completion —
      // bailing here would leave the log ahead of the in-memory merge.
      const divs: DivergenceEntry[] = [];
      try {
        for (const entry of fresh) {
          hlc.receive(entry.hlc, at);
          const merged = reduce(entry, true);
          divs.push(...merged.divergences);
          outcomes.push(merged.outcome);
        }
      } catch (thrown) {
        return err(fromUnknown(thrown));
      }
      const compaction = planCompaction();
      await appendDivergence(divs, compaction, sig, deadlineMs);
      // Attach the post-merge materialized truth per applied record —
      // projecting from entries alone can't see fields that merged in
      // earlier deltas (a delayed tombstone that lost to newer fields
      // must not delete a row the engine still materializes).
      const stamped = outcomes.map((outcome) =>
        outcome.type === 'applied'
          ? { ...outcome, record: recordSnapshot(outcome.entry) }
          : outcome,
      );
      const result: ApplyResult = {
        senderDeviceId: doc.senderDeviceId,
        entries: fresh,
        outcomes: stamped,
        divergence: divs,
        cursor: cursorSnapshot(),
      };
      return ok(result);
    });
  }

  /** A record's surviving field→value map as the merge sees it. */
  function fieldsOf(
    record: RecordState | undefined,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (record !== undefined) {
      for (const [field, cell] of record.fields) {
        fields[field] = cell.value;
      }
    }
    return fields;
  }

  /** The record's surviving field set as the merge currently sees it. */
  function recordSnapshot(entry: ChangeEntry): MaterializedRecord {
    return {
      kind: entry.kind,
      recordId: entry.recordId,
      fields: fieldsOf(
        records.get(`${entry.kind}${KEY_SEP}${entry.recordId}`),
      ),
    };
  }

  function divergenceHistory(
    filter?: DivergenceFilter,
  ): readonly DivergenceEntry[] {
    return divergence
      .filter(
        (row) =>
          (filter?.kind === undefined || row.kind === filter.kind) &&
          (filter?.recordId === undefined ||
            row.recordId === filter.recordId),
      )
      .slice()
      .reverse();
  }

  async function restoreLoser(
    historyId: string,
    signal?: CancellationSignal,
  ): Promise<Result<LocalChangeResult>> {
    if (!isString(historyId, 64)) {
      return err(appError('invalid-response', 'invalid history id'));
    }
    const row = divergence.find((d) => d.historyId === historyId);
    if (row === undefined) {
      return err(appError('not-found', 'unknown divergence entry'));
    }
    const input: LocalWrite = row.loser.tombstone
      ? { kind: row.kind, recordId: row.recordId, tombstone: true }
      : {
        kind: row.kind,
        recordId: row.recordId,
        field: row.field,
        value: row.loser.value,
      };
    // The loser value is already the field's component form for
    // 'sum' rules — restoring must stamp it verbatim, not translate
    // a second aggregate (Review #46 round-8).
    return firstWritten(await writeChanges([input], signal, true));
  }

  function materialize(): readonly MaterializedRecord[] {
    const out: MaterializedRecord[] = [];
    for (const record of records.values()) {
      // Empty fields is included on purpose: a record only ends up
      // fieldless after a WINNING tombstone, so it means "synced then
      // deleted" — distinct from a record absent here, which was never
      // synced at all. Rebuild consumers need the tombstone to drop
      // the row; absence must keep it.
      out.push({
        kind: record.kind,
        recordId: record.recordId,
        fields: fieldsOf(record),
      });
    }
    out.sort((a, b) => {
      // (tier, group, kind, recordId): grouped families sort by their
      // shared parent id so a page carries a recording WITH its refs;
      // tier-1 dependents sort last, whole, after every parent exists.
      const ta = MATERIALIZE_GROUPED_KINDS.has(a.kind) ? 0 : 1;
      const tb = MATERIALIZE_GROUPED_KINDS.has(b.kind) ? 0 : 1;
      if (ta !== tb) {
        return ta - tb;
      }
      const ga = materializeGroup(a.kind, a.recordId);
      const gb = materializeGroup(b.kind, b.recordId);
      if (ga !== gb) {
        return ga < gb ? -1 : 1;
      }
      if (a.kind !== b.kind) {
        return a.kind < b.kind ? -1 : 1;
      }
      return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
    });
    return out;
  }

  // ---- hydrate ------------------------------------------------------------

  const loadAt = now();
  if (loadAt === null) {
    return err(appError('internal', 'clock returned an unsafe timestamp'));
  }
  const emptySignal = new CancellationSource();
  const loaded = await call(() =>
    store.load(
      context(
        'sync-load',
        Math.min(loadAt + OP_DEADLINE_MS, Number.MAX_SAFE_INTEGER),
        emptySignal.signal,
      ),
    ),
  );
  if (!loaded.ok) {
    return err(loaded.error);
  }
  const snapshot = loaded.value;
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.entries) ||
    !snapshot.entries.every(isChangeEntry) ||
    !Array.isArray(snapshot.divergence) ||
    !snapshot.divergence.every(isDivergenceEntry) ||
    !isRecord(snapshot.watermarks) ||
    !isSyncCursor(snapshot.watermarks) ||
    (snapshot.divergenceFloor !== undefined &&
      !isOptSafeNonNegative(snapshot.divergenceFloor)) ||
    (snapshot.divergenceReplayOffset !== undefined &&
      !isOptSafeNonNegative(snapshot.divergenceReplayOffset)) ||
    (snapshot.divergenceDroppedEmissions !== undefined &&
      (!Array.isArray(snapshot.divergenceDroppedEmissions) ||
        !snapshot.divergenceDroppedEmissions.every(isEmissionSeq))) ||
    (snapshot.peerMarks !== undefined && !isPeerMarks(snapshot.peerMarks))
  ) {
    return err(appError('invalid-response', 'sync log snapshot invalid'));
  }
  divergenceFloor = snapshot.divergenceFloor ?? 0;
  droppedEmissions.push(
    ...new Set(snapshot.divergenceDroppedEmissions ?? []),
  );
  droppedEmissions.sort((a, b) => a - b);
  // Compaction dropped entries that already consumed emission
  // ordinals — replay resumes at each survivor's own position so
  // ordinals still line up with the stored divergence floor. The
  // legacy offset carries only a count (logs written before
  // ordinals were tracked): treat its positions as the first N.
  nextEmissionOrdinal = (snapshot.divergenceReplayOffset ?? 0) + 1;
  skipRetiredOrdinals();
  // Stored divergence rows seed the dedupe set BEFORE replay, so
  // 'repair' emit materializes exactly the rows the store is missing.
  for (const row of snapshot.divergence) {
    divergence.push(row);
    divergenceSeen.add(
      divergenceKey(row.kind, row.recordId, row.field, row.loser),
    );
    divergenceSeq = Math.max(divergenceSeq, row.seq);
  }
  const repairs: DivergenceEntry[] = [];
  let highest: HlcStamp | undefined;
  for (const entry of snapshot.entries) {
    deepFreezeValue(entry);
    indexEntry(entry);
    foldSeq(entry.deviceId, entry.seq);
    if (
      entry.deviceId === deviceId &&
      entry.seq > localSeq
    ) {
      localSeq = entry.seq;
    }
    if (highest === undefined || compareStamp(entry.hlc, highest) > 0) {
      highest = entry.hlc;
    }
    reduce(entry, 'repair').divergences.forEach((row) =>
      repairs.push(row),
    );
  }
  // Stored watermarks merge back on top of the log-derived marks: a
  // mark may ride on `skipped` folds — seqs an exporter claimed
  // permanently absent that never entered the log — and persisting
  // them is what the watermark field exists for. The write was atomic
  // with the entries, so a stored mark can't claim progress the
  // durable state didn't witness; max() keeps whichever side proves
  // more.
  for (const [dev, mark] of Object.entries(snapshot.watermarks)) {
    contiguous.set(dev, Math.max(mark, contiguous.get(dev) ?? 0));
  }
  // Durable peer rows hydrate as stale: a remembered-but-silent peer
  // pins every compaction floor at 0 until its first live claim —
  // the stored marks themselves never count, because a rebuilt peer
  // could carry the same deviceId while holding nothing its old
  // claims covered.
  for (const sender of Object.keys(snapshot.peerMarks ?? {})) {
    stalePeers.add(sender);
  }
  hlc = new HybridClock(highest);
  // Best-effort repair write: divergence rows rebuilt from the log
  // that the store is missing (e.g. a prior divergence append that
  // failed). Bounded by the same cap as live writes.
  if (repairs.length > 0) {
    const dropBefore = pruneDivergence();
    const write: SyncLogWrite = {
      divergence: repairs,
      ...(dropBefore === undefined
        ? {}
        : { dropDivergenceBefore: dropBefore }),
    };
    const repaired = await call(() =>
      store.append(
        write,
        context(
          'sync-repair',
          Math.min(
            loadAt + OP_DEADLINE_MS,
            Number.MAX_SAFE_INTEGER,
          ),
          emptySignal.signal,
        ),
      ),
    );
    if (!repaired.ok) {
      warn(
        `sync divergence repair append failed: ${repaired.error.kind}`,
      );
    }
  }

  const engine: SyncEngine = {
    deviceId,
    localChange,
    localChangeBatch: writeChanges,
    exportDelta,
    applyDelta,
    divergenceHistory,
    restoreLoser,
    materialize,
    cursor: cursorSnapshot,
  };
  return ok(engine);
}
