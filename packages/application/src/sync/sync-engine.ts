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
import type { PlayEvent } from '../library/library.ts';
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

export type SyncRecordKind =
  | 'recording'
  | 'recordingSourceRef'
  | 'recordingMapping'
  | 'like'
  | 'entity'
  | 'entitySourceRef'
  | 'playlist'
  | 'playlistEntry'
  | 'playEvent'
  | 'playCount'
  | 'matchReview'
  | 'settings';

export const SYNC_RECORD_KINDS: readonly SyncRecordKind[] = [
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
];

const SYNC_RECORD_KIND_SET: ReadonlySet<string> = new Set(SYNC_RECORD_KINDS);

export function isSyncRecordKind(value: unknown): value is SyncRecordKind {
  return (
    typeof value === 'string' && SYNC_RECORD_KIND_SET.has(value)
  );
}

/** The record-wide delete marker: a tombstone entry always uses it. */
export const TOMBSTONE_FIELD = '*';

/** The singleton settings record's id. */
export const SETTINGS_RECORD_ID = 'settings';

const KEY_SEP = '\u001f';

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
  let out = '';
  for (const part of parts) {
    out += `${part.length}:${part}`;
  }
  return out;
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

export type DivergenceSide = {
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

export type DivergenceFilter = {
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

export type LocalChangeResult = {
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
};

export type SyncLogWrite = {
  readonly entries?: readonly ChangeEntry[];
  readonly divergence?: readonly DivergenceEntry[];
  /** Merged into the stored watermark map (per-device max). */
  readonly watermarks?: Readonly<Record<string, number>>;
  /** Drops stored divergence rows with seq strictly below this floor. */
  readonly dropDivergenceBefore?: number;
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
   * receives the same entry set.
   */
  applyDelta(
    doc: unknown,
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

function isBooleanValue(value: unknown): boolean {
  return typeof value === 'boolean';
}

function isOptBoolean(value: unknown): boolean {
  return value === null || typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isReleaseYear(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0)
  );
}

function isArtworkList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(isArtworkRef)
  );
}

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

function isVersionLabels(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    new Set(value).size === value.length &&
    value.every((l) => typeof l === 'string' && VERSION_LABEL_VALUES.has(l))
  );
}

function isProvenance(value: unknown): boolean {
  return value === 'provider' || value === 'local';
}

function isEntityKindValue(value: unknown): value is EntityKind {
  return value === 'album' || value === 'artist';
}

function isStorefrontValue(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' && /^[A-Z]{2}$/.test(value))
  );
}

function isThemeValue(value: unknown): boolean {
  return (
    value === 'dark' ||
    value === 'light' ||
    value === 'oled' ||
    value === 'system'
  );
}

function isQualityKbps(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 512
  );
}

const REVIEW_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'confirmed',
  'rejected',
  'dismissed',
]);

function isReviewStatus(value: unknown): boolean {
  return typeof value === 'string' && REVIEW_STATUSES.has(value);
}

function isResolutionValue(value: unknown): boolean {
  return value === null || isMatchResolution(value);
}

function isCandidateList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 64 &&
    value.every(isCandidateSnapshot)
  );
}

function isOptTrackRef(value: unknown): boolean {
  return value === null || isTrackRef(value);
}

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
  },
};

/** Whitelisted? Does the value satisfy the field's wire contract? */
export function syncFieldRule(
  kind: SyncRecordKind,
  field: string,
): FieldRule | undefined {
  return SYNC_FIELD_RULES[kind][field];
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
 * Wire-level shape check for the materialized pull — field VALUES go
 * unvalidated here because the projector only reads them through
 * per-field typed accessors and the field whitelist.
 */
export function isMaterializedRecord(
  value: unknown,
): value is MaterializedRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'recordId', 'fields']) &&
    isSyncRecordKind(value['kind']) &&
    isString(value['recordId'], MAX_RECORD_ID) &&
    isRecord(value['fields']) &&
    Object.keys(value['fields']).every((k) => k.length <= MAX_FIELD)
  );
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

export function isDivergenceSide(value: unknown): value is DivergenceSide {
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
   * Candidates newer than the record tombstone. A dead entry never
   * resurfaces (tombstones only advance), so it is dropped on death —
   * 'live' holds exactly the entries that could still win. For 'lww'
   * this is always `[winner]`: if the max-stamp entry ever dies, every
   * smaller-stamped candidate is dead too, so runner-ups cannot
   * resurface. For 'max' runner-ups must stay: a larger-but-dead
   * value must not poison the slot — after a tombstone kills it, the
   * smaller-but-newer write still wins, which is what makes the
   * max-merge convergent under reorder.
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

/** The total order: (l, c) then deviceId — ties are impossible then. */
function compareEntryTs(
  a: { hlc: HlcStamp; deviceId: string },
  b: { hlc: HlcStamp; deviceId: string },
): number {
  const byStamp = compareStamp(a.hlc, b.hlc);
  if (byStamp !== 0) {
    return byStamp;
  }
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

function entryKey(entry: ChangeEntry): string {
  return `${entry.deviceId}${KEY_SEP}${entry.hlc.l}${KEY_SEP}${entry.hlc.c}`;
}

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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

/** Emission ordinals are 1-based: 0 means "nothing observed". */
function isEmissionSeq(value: unknown): value is number {
  return isSafeNonNegative(value) && value >= 1;
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

function jsonEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]))
    );
  }
  if (!isJsonObject(a) || !isJsonObject(b)) {
    return false;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.hasOwn(b, key) && jsonEquals(a[key], b[key]),
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
    for (const child of Object.values(node)) {
      visit(child);
    }
    Object.freeze(node);
  };
  visit(value);
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

  function resolveSignal(signal: CancellationSignal | undefined): {
    signal: CancellationSignal;
    cancelled: boolean;
  } {
    if (signal !== undefined) {
      return { signal, cancelled: signal.cancelled };
    }
    const source = new CancellationSource();
    return { signal: source.signal, cancelled: false };
  }

  // ---- mutable merge state ------------------------------------------------

  const records = new Map<string, RecordState>();
  /** All accepted entries (winners and losers alike), append order. */
  const changeLog: ChangeEntry[] = [];
  const seen = new Set<string>();
  /**
   * Per-device emission observation: `seenSeqs[d]` holds every seq
   * observed from device d (including our own); `contiguous[d]` is the
   * largest seq with no gap below it. Memory is proportional to the
   * log — same order as `changeLog` itself.
   */
  const seenSeqs = new Map<string, Set<number>>();
  const contiguous = new Map<string, number>();
  /** Emission ordinal of this device's own next entry (appended only). */
  let localSeq = 0;
  const divergence: DivergenceEntry[] = [];
  const divergenceSeen = new Set<string>();
  let divergenceSeq = 0;
  /**
   * Hydrate-replay bookkeeping: `replaySeen` + `repairPos` re-derive
   * the original emit order so positions line up 1:1 with row seqs;
   * `divergenceFloor` is the store's cumulative prune frontier —
   * losers with emit positions below it were intentionally capped
   * away and must not be rebuilt (that would resurrect pruned history
   * with fresh seqs and churn the retained window on every restart).
   */
  const replaySeen = new Set<string>();
  let repairPos = 0;
  let divergenceFloor = 0;
  let hlc = new HybridClock();

  /**
   * Fold one entry's emission seq into the observed set and advance
   * the device's contiguous mark while buffered successors exist.
   */
  function foldSeq(source: string, seq: number): void {
    let set = seenSeqs.get(source);
    if (set === undefined) {
      set = new Set<number>();
      seenSeqs.set(source, set);
    }
    set.add(seq);
    let mark = contiguous.get(source) ?? 0;
    while (set.has(mark + 1)) {
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
        buffer = new Set<number>();
        const prior = seenSeqs.get(dev);
        if (prior !== undefined) {
          for (const existing of prior) {
            buffer.add(existing);
          }
        }
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
    if (skipped !== undefined) {
      for (const [dev, seqs] of Object.entries(skipped)) {
        for (const seq of seqs) {
          foldHypothetical(dev, seq);
        }
      }
    }
    for (const entry of entries) {
      foldHypothetical(entry.deviceId, entry.seq);
    }
    return marks;
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
      // merges produced, so each new position equals the row seq the
      // event would have received. Stored rows still exist (dedupe);
      // positions below the floor were intentionally pruned —
      // mark them seen so they are never rebuilt; anything missing
      // above the floor is a lost append worth repairing.
      if (replaySeen.has(key)) {
        return;
      }
      replaySeen.add(key);
      repairPos += 1;
      if (divergenceSeen.has(key)) {
        return;
      }
      divergenceSeen.add(key);
      if (repairPos < divergenceFloor) {
        return;
      }
    } else {
      if (divergenceSeen.has(key)) {
        return;
      }
      divergenceSeen.add(key);
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
   * against the field's current winner (or by value for 'max' rules),
   * then against the tombstone. Every loser lands in divergence.
   */
  /**
   * The merge rule's winner over a set of live candidates: 'lww'
   * takes the newest stamp; 'max' takes the largest numeric value
   * (stamps break exact ties deterministically).
   */
  function pickWinner(
    rule: FieldRule | undefined,
    candidates: readonly ChangeEntry[],
  ): ChangeEntry {
    let winner = candidates[0];
    for (const candidate of candidates) {
      if (winner === undefined) {
        winner = candidate;
        continue;
      }
      if (
        (rule?.merge === 'max' || rule?.merge === 'sum') &&
        typeof candidate.value === 'number' &&
        typeof winner.value === 'number'
      ) {
        if (
          candidate.value > winner.value ||
          (candidate.value === winner.value &&
            compareEntryTs(candidate, winner) > 0)
        ) {
          winner = candidate;
        }
      } else if (compareEntryTs(candidate, winner) > 0) {
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
      if (candidate.deviceId !== dev) {
        continue;
      }
      if (
        best === undefined ||
        (typeof candidate.value === 'number' &&
          typeof best.value === 'number' &&
          (candidate.value > best.value ||
            (candidate.value === best.value &&
              compareEntryTs(candidate, best) > 0)))
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
   * Does `candidate` beat `rival` under the merge rule? 'lww' —
   * newer stamp. 'max'/'sum' — larger numeric value, ties broken by
   * stamp.
   */
  function beats(
    candidate: ChangeEntry,
    rival: ChangeEntry,
    rule: FieldRule | undefined,
  ): boolean {
    if (
      (rule?.merge === 'max' || rule?.merge === 'sum') &&
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
          } else {
            survivors.push(candidate);
          }
        }
        if (survivors.length === 0) {
          record.fields.delete(field);
        } else {
          const winner = pickWinner(rule, survivors);
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

    if (rival !== undefined && !beats(entry, rival, rule)) {
      if (!jsonEquals(entry.value, rival.value)) {
        recordDivergence(divs, entry, rival, emit);
      }
      // A live loser still joins the candidates for 'max'/'sum' — it
      // resurfaces if its rival dies to a later tombstone.
      if (
        cell !== undefined &&
        (rule?.merge === 'max' || rule?.merge === 'sum')
      ) {
        const live = [...cell.live, entry];
        const winner = pickWinner(rule, live);
        cell.live = live;
        cell.winner = winner;
        cell.value =
          rule.merge === 'sum' ? sumValue(live) : winner.value;
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
    const live = [...(cell?.live ?? []), entry];
    const winner = pickWinner(rule, live);
    record.fields.set(entry.field, {
      winner,
      live:
        rule === undefined || rule.merge === 'lww' ? [entry] : live,
      value: rule?.merge === 'sum' ? sumValue(live) : winner.value,
    });
    return {
      outcome: { type: 'applied', entry, displaced },
      divergences: divs,
    };
  }

  // ---- persistence --------------------------------------------------------

  async function appendLog(
    entries: readonly ChangeEntry[],
    skipped: Record<string, readonly number[]> | undefined,
    signal: CancellationSignal,
    deadlineMs: number,
  ): Promise<Result<void>> {
    const write: SyncLogWrite = {
      entries,
      watermarks: prospectiveMarks(entries, skipped),
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
      changeLog.push(entry);
      seen.add(entryKey(entry));
    }
    return ok(undefined);
  }

  async function appendDivergence(
    rows: readonly DivergenceEntry[],
    signal: CancellationSignal,
    deadlineMs: number,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    let dropBefore: number | undefined;
    if (divergence.length > DIVERGENCE_HISTORY_LIMIT) {
      const floorRow = divergence[divergence.length - DIVERGENCE_HISTORY_LIMIT];
      if (floorRow !== undefined) {
        dropBefore = floorRow.seq;
        divergence.splice(
          0,
          divergence.length - DIVERGENCE_HISTORY_LIMIT,
        );
      }
    }
    const write: SyncLogWrite = {
      divergence: rows,
      ...(dropBefore === undefined
        ? {}
        : { dropDivergenceBefore: dropBefore }),
    };
    const appended = await call(() =>
      store.append(write, context('sync-div', deadlineMs, signal)),
    );
    if (!appended.ok) {
      warn(`sync divergence history append failed: ${appended.error.kind}`);
      return;
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
    const { signal: sig } = resolveSignal(signal);
    if (sig.cancelled) {
      return err(appError('cancelled', 'cancelled'));
    }
    const work = serialized(async () => {
      if (sig.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(
          appError('internal', 'clock returned an unsafe timestamp'),
        );
      }
      const deadlineMs = Math.min(
        at + OP_DEADLINE_MS,
        Number.MAX_SAFE_INTEGER,
      );
      let entries: ChangeEntry[];
      try {
        entries = inputs.map((input, index) => {
          const stamp = hlc.tick(at);
          const entry: ChangeEntry =
            'tombstone' in input
              ? {
                kind: input.kind,
                recordId: input.recordId,
                field: TOMBSTONE_FIELD,
                value: null,
                tombstone: true,
                hlc: stamp,
                deviceId,
                seq: localSeq + index + 1,
              }
              : {
                kind: input.kind,
                recordId: input.recordId,
                field: input.field,
                // Own the value: the caller keeps its mutable object,
                // the engine freezes its clone — same ownership rule
                // as accepted wire entries.
                value: JSON.parse(
                  JSON.stringify(sumComponentFor(input)),
                ) as unknown,
                tombstone: false,
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
      await appendDivergence(divs, sig, deadlineMs);
      return ok(results);
    });
    return cancellable(work, sig);
  }

  async function localChange(
    input: LocalWrite,
    signal?: CancellationSignal,
  ): Promise<Result<LocalChangeResult>> {
    const batch = await writeChanges([input], signal);
    if (!batch.ok) {
      return err(batch.error);
    }
    const first = batch.value[0];
    if (first === undefined) {
      return err(appError('internal', 'local write produced no entry'));
    }
    return ok(first);
  }

  async function localChangeBatch(
    inputs: readonly LocalWrite[],
    signal?: CancellationSignal,
  ): Promise<Result<readonly LocalChangeResult[]>> {
    return writeChanges(inputs, signal);
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
    const { signal: sig } = resolveSignal(signal);
    if (sig.cancelled) {
      return err(appError('cancelled', 'cancelled'));
    }
    const work = serialized(async () => {
      if (sig.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(
          appError('internal', 'clock returned an unsafe timestamp'),
        );
      }
      const retainedFloor = at - PLAY_HISTORY_RETENTION_MS;
      // Seqs dropped by the retention filter inside this request's
      // window — collected per device so the receiver's contiguous
      // cursor can cross the holes (otherwise a permanently-dropped
      // seq stalls every later page forever).
      const retired = new Map<string, number[]>();
      /** Log seqs above the requester's mark, per device — the
       * presence set the gap derivation below is checked against. */
      const present = new Map<string, Set<number>>();
      const eligible = changeLog
        .filter((entry) => {
          // Per-source contiguous seq: entries at or below the
          // requester's mark are known-observed and never re-ship.
          const seenUpTo = since?.[entry.deviceId] ?? 0;
          if (entry.seq > seenUpTo) {
            let set = present.get(entry.deviceId);
            if (set === undefined) {
              set = new Set<number>();
              present.set(entry.deviceId, set);
            }
            set.add(entry.seq);
          } else {
            return false;
          }
          // History is a bounded window (data.md): a play event
          // beyond the retention window would be pruned on the
          // receiver's next write anyway, so it never ships.
          if (
            entry.kind === 'playEvent' &&
            !entry.tombstone &&
            isPlayEvent(entry.value) &&
            entry.value.playedMs < retainedFloor
          ) {
            const list = retired.get(entry.deviceId);
            if (list === undefined) {
              retired.set(entry.deviceId, [entry.seq]);
            } else {
              list.push(entry.seq);
            }
            return false;
          }
          return true;
        })
        .sort(compareEntryTs);
      const entries = eligible.slice(0, bound);
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
      for (const [dev, bound] of shippedMax) {
        const mark = since?.[dev] ?? 0;
        const listed = new Set<number>();
        // Seq holes this replica already accounts for — skips learned
        // from an upstream peer and rows pruned below its own
        // contiguous mark. Without re-listing them a relay leaves
        // downstream cursors stalled below the gaps forever, so every
        // later page re-ships the same entries. Only seqs at or below
        // this replica's contiguous mark may be claimed absent — a
        // hole above it is unknown, not absent.
        const accounted = Math.min(bound, contiguous.get(dev) ?? 0);
        const logSeqs = present.get(dev);
        // Emit at most the envelope bound: seqs past it are listed by
        // the page whose higher requester mark reaches them.
        for (
          let seq = mark + 1;
          seq <= accounted && listed.size < MAX_DELTA_ENTRIES;
          seq += 1
        ) {
          if (logSeqs === undefined || !logSeqs.has(seq)) {
            listed.add(seq);
          }
        }
        for (const seq of retired.get(dev) ?? []) {
          if (seq > mark && seq <= bound) {
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
        more: eligible.length > entries.length,
        skipped,
      };
      return ok(doc);
    });
    return cancellable(work, sig);
  }

  async function applyDelta(
    doc: unknown,
    signal?: CancellationSignal,
  ): Promise<Result<ApplyResult>> {
    if (!isSyncDelta(doc)) {
      return err(appError('invalid-message', 'malformed sync delta'));
    }
    const { signal: sig } = resolveSignal(signal);
    if (sig.cancelled) {
      return err(appError('cancelled', 'cancelled'));
    }
    const work = serialized(async () => {
      if (sig.cancelled) {
        return err(appError('cancelled', 'cancelled'));
      }
      const at = now();
      if (at === null) {
        return err(
          appError('internal', 'clock returned an unsafe timestamp'),
        );
      }
      const deadlineMs = Math.min(
        at + OP_DEADLINE_MS,
        Number.MAX_SAFE_INTEGER,
      );

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
        // whitelist contract, so a JSON clone is exact.
        const owned = JSON.parse(JSON.stringify(raw)) as ChangeEntry;
        deepFreezeValue(owned);
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

      const appended = await appendLog(fresh, doc.skipped, sig, deadlineMs);
      if (!appended.ok) {
        return err(appended.error);
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
      await appendDivergence(divs, sig, deadlineMs);
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
    return cancellable(work, sig);
  }

  /** The record's surviving field set as the merge currently sees it. */
  function recordSnapshot(entry: ChangeEntry): MaterializedRecord {
    const record = records.get(`${entry.kind}${KEY_SEP}${entry.recordId}`);
    const fields: Record<string, unknown> = {};
    if (record !== undefined) {
      for (const [field, cell] of record.fields) {
        fields[field] = cell.value;
      }
    }
    return { kind: entry.kind, recordId: entry.recordId, fields };
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
    return localChange(input, signal);
  }

  function materialize(): readonly MaterializedRecord[] {
    const out: MaterializedRecord[] = [];
    for (const record of records.values()) {
      const fields: Record<string, unknown> = {};
      for (const [field, cell] of record.fields) {
        fields[field] = cell.value;
      }
      // Empty fields is included on purpose: a record only ends up
      // fieldless after a WINNING tombstone, so it means "synced then
      // deleted" — distinct from a record absent here, which was never
      // synced at all. Rebuild consumers need the tombstone to drop
      // the row; absence must keep it.
      out.push({
        kind: record.kind,
        recordId: record.recordId,
        fields,
      });
    }
    out.sort((a, b) => {
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
      !isOptSafeNonNegative(snapshot.divergenceFloor))
  ) {
    return err(appError('invalid-response', 'sync log snapshot invalid'));
  }
  divergenceFloor = snapshot.divergenceFloor ?? 0;
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
    changeLog.push(entry);
    seen.add(entryKey(entry));
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
  hlc = new HybridClock(highest);
  // Best-effort repair write: divergence rows rebuilt from the log
  // that the store is missing (e.g. a prior divergence append that
  // failed). Bounded by the same cap as live writes.
  if (repairs.length > 0) {
    let dropBefore: number | undefined;
    if (divergence.length > DIVERGENCE_HISTORY_LIMIT) {
      const floorRow =
        divergence[divergence.length - DIVERGENCE_HISTORY_LIMIT];
      if (floorRow !== undefined) {
        dropBefore = floorRow.seq;
        divergence.splice(
          0,
          divergence.length - DIVERGENCE_HISTORY_LIMIT,
        );
      }
    }
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
    localChangeBatch,
    exportDelta,
    applyDelta,
    divergenceHistory,
    restoreLoser,
    materialize,
    cursor: cursorSnapshot,
  };
  return ok(engine);
}
