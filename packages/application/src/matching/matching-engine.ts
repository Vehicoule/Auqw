import type {
  MatchEvidence,
  Recording,
  SourceMapping,
  SourceRef,
  TrackMetadata,
  VersionLabel,
} from '../domain.ts';

export type MatchOutcome =
  | {
    readonly type: 'matched';
    readonly candidate: TrackMetadata;
    readonly evidence: MatchEvidence;
  }
  | {
    readonly type: 'ambiguous';
    readonly candidates: readonly {
      candidate: TrackMetadata;
      evidence: MatchEvidence;
    }[];
  }
  | { readonly type: 'unavailable'; readonly reason: string };

const LABEL_ORDER: readonly VersionLabel[] = [
  'live',
  'remix',
  'remaster',
  'clean',
  'explicit',
  'alternate',
];

// Tokens that map to a VersionLabel when they appear whole-word.
const LABEL_TOKEN: ReadonlyMap<string, VersionLabel> = new Map([
  ['live', 'live'],
  ['remix', 'remix'],
  ['mix', 'remix'],
  ['remaster', 'remaster'],
  ['remastered', 'remaster'],
  ['clean', 'clean'],
  ['explicit', 'explicit'],
  ['alternate', 'alternate'],
]);

// Tokens that are never meaningful title content on their own.
// 'topic' is the auto-upload channel suffix ('Song - Topic').
const FURNITURE: ReadonlySet<string> = new Set([
  ...LABEL_TOKEN.keys(),
  'alt',
  'take',
  'version',
  'official',
  'video',
  'audio',
  'feat',
  'ft',
  'topic',
]);

function tokenize(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

type AnalyzedTitle = {
  readonly base: string;
  readonly labels: ReadonlySet<VersionLabel>;
};

function analyzeTitle(title: string): AnalyzedTitle {
  const lower = title.normalize('NFKC').toLowerCase();
  const labels = new Set<VersionLabel>();

  // Labels are detected over the whole title, including any suffix we
  // later strip from the base.
  const allTokens = tokenize(lower);
  for (const [i, token] of allTokens.entries()) {
    const label = LABEL_TOKEN.get(token);
    if (label !== undefined) {
      labels.add(label);
    } else if (
      token === 'alt' &&
      (allTokens[i + 1] === 'take' || allTokens[i + 1] === 'version')
    ) {
      labels.add('alternate');
    }
  }

  // Cut a ` - ` / ` | ` suffix only when what follows is entirely
  // recognized furniture.
  let baseText = lower;
  for (const sep of [' - ', ' | ']) {
    const idx = baseText.indexOf(sep);
    if (idx >= 0) {
      const rest = tokenize(baseText.slice(idx + sep.length));
      if (rest.length > 0 && rest.every((t) => FURNITURE.has(t))) {
        baseText = baseText.slice(0, idx);
      }
    }
  }

  const baseTokens: string[] = [];
  const tokens = tokenize(baseText);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    // A `feat.`/`ft.` suffix drops itself and everything after.
    if (token === 'feat' || token === 'ft') {
      break;
    }
    // `official video` / `official audio` pairs are furniture.
    if (
      token === 'official' &&
      (tokens[i + 1] === 'video' || tokens[i + 1] === 'audio')
    ) {
      i += 1;
      continue;
    }
    // Recognized version labels and `alt take`/`alt version` are
    // stripped from the comparison base.
    if (LABEL_TOKEN.has(token)) {
      continue;
    }
    if (
      token === 'alt' &&
      (tokens[i + 1] === 'take' || tokens[i + 1] === 'version')
    ) {
      i += 1;
      continue;
    }
    baseTokens.push(token);
  }
  return { base: baseTokens.join(' '), labels };
}

/** Multiset counts over items. */
function counts<T>(items: readonly T[]): Map<T, number> {
  const out = new Map<T, number>();
  for (const item of items) {
    out.set(item, (out.get(item) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice over two count maps. */
function diceScore(
  left: Map<string, number>,
  right: Map<string, number>,
): number {
  let overlap = 0;
  let leftTotal = 0;
  for (const [key, count] of left) {
    leftTotal += count;
    overlap += Math.min(count, right.get(key) ?? 0);
  }
  let rightTotal = 0;
  for (const count of right.values()) {
    rightTotal += count;
  }
  return (2 * overlap) / (leftTotal + rightTotal);
}

/** Sørensen–Dice over Unicode code-point bigrams. */
function dice(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const bigrams = (s: string): string[] => {
    const chars = [...s];
    return chars.slice(1).map((c, i) => `${chars[i] ?? ''}${c}`);
  };
  // One-code-point strings have no bigrams; unequal strings score 0,
  // never NaN.
  if ([...a].length < 2 || [...b].length < 2) {
    return 0;
  }
  return diceScore(counts(bigrams(a)), counts(bigrams(b)));
}

/** Sørensen–Dice over whitespace-token multisets. */
function tokenDice(a: string, b: string): number {
  if (a === b || a.length === 0 || b.length === 0) {
    return a === b ? 1 : 0;
  }
  const tokens = (s: string): string[] =>
    s.split(/\s+/u).filter((t) => t.length > 0);
  return diceScore(counts(tokens(a)), counts(tokens(b)));
}

export function extractVersionLabels(
  title: string,
  explicit: boolean | null,
): readonly VersionLabel[] {
  const labels = new Set(analyzeTitle(title).labels);
  if (explicit === true) {
    labels.add('explicit');
  } else if (explicit === false) {
    labels.add('clean');
  }
  return LABEL_ORDER.filter((l) => labels.has(l));
}

export function refKey(ref: SourceRef): string {
  return `${ref.provider}\u001f${ref.kind}\u001f${ref.id}`;
}

/**
 * The effective claim per ref: latest matchedAtMs wins; equal
 * timestamps rank user-confirmed > rejected > automatic.
 */
export function collapseByRef(
  mappings: readonly SourceMapping[],
): Map<string, SourceMapping> {
  const rank = (status: SourceMapping['status']): number =>
    status === 'user-confirmed' ? 2 : status === 'rejected' ? 1 : 0;
  const byRef = new Map<string, SourceMapping>();
  for (const mapping of mappings) {
    const key = refKey(mapping.ref);
    const existing = byRef.get(key);
    if (
      existing === undefined ||
      mapping.matchedAtMs > existing.matchedAtMs ||
      (mapping.matchedAtMs === existing.matchedAtMs &&
        rank(mapping.status) > rank(existing.status))
    ) {
      byRef.set(key, mapping);
    }
  }
  return byRef;
}

export function normalizeFree(text: string): string {
  return tokenize(text).join(' ');
}

/**
 * Featuring/collab credit separators in an artist field. Splitting
 * happens on the raw string — normalizeFree would already have
 * folded the punctuation away. 'and'/'with' are deliberately absent:
 * they live inside canonical act names ('Florence and the Machine'),
 * so splitting on them would promote a fragment to full-artist
 * certainty. Punctuation-based separators ('Earth, Wind & Fire')
 * remain ambiguous — an inherent limit of string-level matching —
 * but at least the act's own canonical name can't be confused with
 * collab syntax.
 */
const ARTIST_SPLIT =
  /[&,+]|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bvs\.?\b|\bx\b/iu;

/**
 * The whole normalized name plus each credited act it splits into.
 * Catalogs differ on collab credits — a file tagged 'A & B' and a
 * provider's plain 'A' name the same act, so the best pairwise view
 * wins rather than requiring the whole lists to match.
 */
function artistViews(text: string): readonly string[] {
  const views = [normalizeFree(text)];
  for (const part of text.split(ARTIST_SPLIT)) {
    const normalized = normalizeFree(part);
    if (normalized.length > 0 && normalized !== views[0]) {
      views.push(normalized);
    }
  }
  return views;
}

function artistSimilarityBetween(a: string, b: string): number {
  return (dice(a, b) + tokenDice(a, b)) / 2;
}

function bestArtistSimilarity(a: string, b: string): number {
  let best = 0;
  for (const left of artistViews(a)) {
    for (const right of artistViews(b)) {
      best = Math.max(best, artistSimilarityBetween(left, right));
      if (best === 1) {
        return 1;
      }
    }
  }
  return best;
}

/**
 * What a review row actually shows: title + `artist · provider ·
 * duration`. A provider often lists the same song under several ids
 * (album audio, topic video, short uploads) — those candidates are
 * one choice, not two, and a tie between them is a phantom that would
 * gate a confident match on rows the user cannot tell apart.
 * Duration is bucketed to the displayed clock (whole seconds), so two
 * listings off by sub-second metadata still render as one row while
 * genuinely different-length tracks stay distinct choices.
 */
export function matchDisplayKey(candidate: {
  readonly provider: string;
  readonly title: string;
  readonly artist: string | null;
  readonly durationMs: number | null;
}): string {
  return [
    candidate.provider,
    normalizeFree(candidate.title),
    normalizeFree(candidate.artist ?? ''),
    candidate.durationMs === null || !Number.isFinite(candidate.durationMs)
      ? ''
      : Math.floor(candidate.durationMs / 1000).toString(),
  ].join('\u001f');
}

function displayKey(candidate: MatchCandidate): string {
  return matchDisplayKey({
    provider: candidate.sourceRef.provider,
    title: candidate.title,
    artist: candidate.artist ?? null,
    durationMs: candidate.durationMs ?? null,
  });
}

/**
 * The fields a recording-identity verdict reads — a subset both
 * `Recording` and `TrackMetadata` satisfy.
 */
export type IdentityFields = {
  readonly title: string;
  readonly artist: string | null;
  readonly durationMs: number | null;
  readonly isrc?: string | null;
  readonly explicit?: boolean | null;
  readonly versionLabels?: readonly VersionLabel[];
};

const SAME_SONG_ARTIST_SIM = 0.85;
const SAME_SONG_DURATION_MS = 2500;

/**
 * True only on hard label incompatibilities — a version-axis mismatch
 * (live vs studio, remix vs album cut) or a clean/explicit conflict.
 * The verdict `sameSongIdentity` and the matcher's `hardConflict`
 * share it so 'the same recording' means the same thing on every
 * path that collapses listings.
 */
function versionLabelsConflict(
  a: ReadonlySet<VersionLabel>,
  b: ReadonlySet<VersionLabel>,
): boolean {
  for (const axis of HARD_AXES) {
    if (a.has(axis) !== b.has(axis)) {
      return true;
    }
  }
  const cleanOrExplicit = (labels: ReadonlySet<VersionLabel>) =>
    labels.has('explicit')
      ? 'explicit'
      : labels.has('clean')
        ? 'clean'
        : null;
  const aCE = cleanOrExplicit(a);
  const bCE = cleanOrExplicit(b);
  return aCE !== null && bCE !== null && aCE !== bCE;
}

function identityLabels(f: IdentityFields): ReadonlySet<VersionLabel> {
  return new Set(
    f.versionLabels ?? extractVersionLabels(f.title, f.explicit ?? null),
  );
}

/**
 * Whether two records describe the same recording of a song — the
 * question a catalog asks when it lists one song under several ids
 * (album audio, topic upload, music video, re-upload). A same-song
 * group is one choice wearing several keys: picking between members
 * carries no information, so callers collapse them instead of
 * asking.
 *
 * ISRC is decisive either way: equal codes are the same recording
 * id industry-wide, different ones are different recordings (a
 * remaster earns its own ISRC) even when the listings' metadata
 * reads identically. Without a usable ISRC pair the verdict needs
 * the analyzed title base (version-label/furniture tokens stripped)
 * plus at least one corroborating axis — a similar artist credit or
 * a duration inside ~2.5 s. Title alone never merges: two artists'
 * 'Intro' rows are different songs the metadata cannot tell apart.
 * Neither do version-conflicting rows: 'Song (Live)' is a different
 * recording from 'Song', not a listing of it.
 */
export function sameSongIdentity(a: IdentityFields, b: IdentityFields): boolean {
  const isrcA = a.isrc?.trim().toLowerCase();
  const isrcB = b.isrc?.trim().toLowerCase();
  if (isrcA !== undefined && isrcA !== '' && isrcB !== undefined && isrcB !== '') {
    return isrcA === isrcB;
  }
  if (analyzeTitle(a.title).base !== analyzeTitle(b.title).base) {
    return false;
  }
  if (versionLabelsConflict(identityLabels(a), identityLabels(b))) {
    return false;
  }
  const artistKnown = a.artist !== null && b.artist !== null;
  const durationKnown = a.durationMs !== null && b.durationMs !== null;
  if (!artistKnown && !durationKnown) {
    return false;
  }
  if (
    artistKnown &&
    bestArtistSimilarity(a.artist, b.artist) < SAME_SONG_ARTIST_SIM
  ) {
    return false;
  }
  if (
    durationKnown &&
    Math.abs(a.durationMs - b.durationMs) > SAME_SONG_DURATION_MS
  ) {
    return false;
  }
  return true;
}

/**
 * The key `matchDisplayKey` would emit had the title been the
 * analyzed base: identical listings collapse, and so do listings
 * whose only difference is version furniture ('(Official Video)',
 * '- Topic', feat suffixes) — the difference a user can't act on.
 * Version labels stay in the key so a live cut or a remix keeps its
 * own row; distinct durations and artists still hold rows apart.
 */
export function displayIdentityKey(candidate: {
  readonly provider: string;
  readonly title: string;
  readonly artist: string | null;
  readonly durationMs: number | null;
}): string {
  const analyzed = analyzeTitle(candidate.title);
  return [
    candidate.provider,
    analyzed.base,
    [...analyzed.labels].sort().join(','),
    normalizeFree(candidate.artist ?? ''),
    candidate.durationMs === null || !Number.isFinite(candidate.durationMs)
      ? ''
      : Math.floor(candidate.durationMs / 1000).toString(),
  ].join('\u001f');
}

/**
 * The less decorated of two same-song listing titles — 'Sunset' over
 * 'Sunset - Topic' or 'Sunset (Official Video)'. Same-song merges
 * keep it so the canonical name outlives the noisier listings.
 */
export function cleanerTitle(a: string, b: string): string {
  return normalizeFree(a).length <= normalizeFree(b).length ? a : b;
}

type Scored = {
  readonly candidate: MatchCandidate;
  readonly evidence: MatchEvidence;
  readonly index: number;
};

/**
 * A candidate is catalog metadata scored against a recording; the
 * optional `isrc`/`artistRef`/`albumRef` fields of `TrackMetadata`
 * carry whatever evidence the provider reported.
 */
export type MatchCandidate = TrackMetadata;

const HARD_AXES: readonly VersionLabel[] = [
  'live',
  'remix',
  'remaster',
  'alternate',
];

export class MatchingEngine {
  static match(
    recording: Recording,
    candidates: readonly MatchCandidate[],
    userMappings: readonly SourceMapping[] = [],
  ): MatchOutcome {
    // Conflicting mappings for one ref resolve by latest
    // matchedAtMs; equal timestamps rank user-confirmed > rejected >
    // automatic.
    const mappingByRef = collapseByRef(userMappings);

    const scored: Scored[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const mapping = mappingByRef.get(refKey(candidate.sourceRef));
      if (mapping?.status === 'rejected') {
        continue;
      }
      if (mapping?.status === 'user-confirmed') {
        // A user-confirmed mapping wins before auto scoring; evidence
        // is still computed for the record (the user verdict stands
        // even when the candidate would have been hard-rejected).
        return {
          type: 'matched',
          candidate,
          evidence: this.userEvidence(recording, candidate),
        };
      }
      const outcome = this.evidence(recording, candidate);
      if (outcome !== null) {
        scored.push({ candidate, evidence: outcome.evidence, index });
      }
    }
    scored.sort((a, b) => b.evidence.score - a.evidence.score || a.index - b.index);

    // Sorted, so the first member of each display group is its best.
    const distinct: Scored[] = [];
    const seenDisplay = new Set<string>();
    for (const s of scored) {
      const key = displayKey(s.candidate);
      if (seenDisplay.has(key)) {
        continue;
      }
      seenDisplay.add(key);
      distinct.push(s);
    }

    const top = distinct[0];
    if (top === undefined) {
      return { type: 'unavailable', reason: 'no candidates' };
    }
    const second = distinct[1];
    const margin =
      second === undefined
        ? Number.POSITIVE_INFINITY
        : top.evidence.score - second.evidence.score;
    if (
      (top.evidence.score >= 78 || top.evidence.exactIsrc) &&
      margin >= 7
    ) {
      return { type: 'matched', candidate: top.candidate, evidence: top.evidence };
    }
    if (top.evidence.score >= 65 && margin < 7) {
      // A near-tie made only of same-song listings is one choice
      // wearing several provider ids — the album audio, the topic
      // upload, the video. Parking it for the user asks a question
      // the rows cannot answer, so the best-scored member wins. The
      // window must be a clique — identity isn't transitive (an
      // uncoded listing matches two coded ones whose ISRCs conflict),
      // so members check each other, not only the top.
      const window = distinct
        .slice(1)
        .filter((s) => top.evidence.score - s.evidence.score < 7);
      if (
        window.every((s) => sameSongIdentity(top.candidate, s.candidate)) &&
        window.every((s, i) =>
          window
            .slice(i + 1)
            .every((t) => sameSongIdentity(s.candidate, t.candidate)),
        )
      ) {
        return {
          type: 'matched',
          candidate: top.candidate,
          evidence: top.evidence,
        };
      }
      // The review parks every near-tie member — not just the display
      // representatives — because a reject vetoes each parked ref and
      // a hidden duplicate surviving the veto would auto-match on the
      // next attempt, silently undoing the user's verdict. A display-
      // group cap can't drop that rule either: a variant crowded out
      // of the visible five still survives the veto if it never
      // parked. The 64-candidate persistence limit caps the total.
      const near: { candidate: MatchCandidate; evidence: MatchEvidence }[] =
        [];
      for (const s of scored) {
        if (top.evidence.score - s.evidence.score >= 7 || near.length >= 64) {
          break;
        }
        near.push({ candidate: s.candidate, evidence: s.evidence });
      }
      return { type: 'ambiguous', candidates: near };
    }
    return { type: 'unavailable', reason: 'below threshold' };
  }

  /**
   * Evidence recorded alongside a user verdict (confirm or reject):
   * the computed score, or a zero record when the candidate would
   * have been hard-rejected — the verdict is the user's, the evidence
   * is provenance only.
   */
  static userEvidence(
    recording: Recording,
    candidate: MatchCandidate,
  ): MatchEvidence {
    return (
      this.evidence(recording, candidate)?.evidence ?? {
        titleSimilarity: 0,
        artistSimilarity: null,
        durationDeltaMs: null,
        exactIsrc: false,
        score: 0,
        versionLabels: extractVersionLabels(
          candidate.title,
          candidate.explicit,
        ),
      }
    );
  }

  /**
   * True only on hard incompatibilities — a version-label axis
   * mismatch (e.g. live vs studio) or a clean/explicit conflict.
   * Similarity-floor misses are ordinary metadata drift, not a
   * rejection. Public so provider-asserted pairings (e.g. a radio
   * page's own refs) can distinguish the two.
   */
  static hardConflict(
    recording: Recording,
    candidate: MatchCandidate,
  ): boolean {
    const intendedLabels = new Set(recording.versionLabels);
    const candidateLabels = new Set(
      extractVersionLabels(candidate.title, candidate.explicit),
    );
    for (const axis of HARD_AXES) {
      if (intendedLabels.has(axis) !== candidateLabels.has(axis)) {
        return true;
      }
    }
    const cleanOrExplicit = (labels: ReadonlySet<VersionLabel>) =>
      labels.has('explicit')
        ? 'explicit'
        : labels.has('clean')
          ? 'clean'
          : null;
    const intendedCE = cleanOrExplicit(intendedLabels);
    const candidateCE = cleanOrExplicit(candidateLabels);
    return (
      intendedCE !== null &&
      candidateCE !== null &&
      intendedCE !== candidateCE
    );
  }

  /**
   * Scores one candidate; returns null when hard label axes reject it
   * or it fails the similarity floor. Public so provider-asserted
   * pairings (e.g. a radio page's own refs) can record real evidence
   * instead of a fabricated score.
   */
  static evidence(
    recording: Recording,
    candidate: MatchCandidate,
  ): { evidence: MatchEvidence } | null {
    const intended = analyzeTitle(recording.title);
    const candidateLabels = new Set(
      extractVersionLabels(candidate.title, candidate.explicit),
    );

    // Hard rejections come before any scoring; a label mismatch
    // rejects even an exact-ISRC candidate.
    if (this.hardConflict(recording, candidate)) {
      return null;
    }

    const candidateBase = analyzeTitle(candidate.title).base;
    const titleSimilarity = dice(intended.base, candidateBase);
    // Artist similarity blends code-point and token Dice over the
    // best pairwise credit view: near-equal names like 'Artist A'/
    // 'Artist B' separate cleanly while collab-credit variants
    // ('A & B' vs 'A') and reorderings stay close.
    const artistSimilarity =
      recording.artist !== null && candidate.artist !== null
        ? bestArtistSimilarity(recording.artist, candidate.artist)
        : null;

    const candidateIsrc = candidate.isrc ?? null;
    const exactIsrc =
      recording.isrc !== null &&
      candidateIsrc !== null &&
      recording.isrc.toLowerCase() === candidateIsrc.toLowerCase();

    if (!exactIsrc) {
      if (titleSimilarity < 0.65) {
        return null;
      }
      if (artistSimilarity !== null && artistSimilarity < 0.55) {
        return null;
      }
    }

    const base = exactIsrc
      ? 1000
      : artistSimilarity !== null
        ? 90 * (0.7 * titleSimilarity + 0.3 * artistSimilarity)
        : 90 * titleSimilarity;

    let adjustment = 0;
    let durationDeltaMs: number | null = null;
    if (recording.durationMs !== null && candidate.durationMs !== null) {
      durationDeltaMs = Math.abs(recording.durationMs - candidate.durationMs);
      adjustment =
        durationDeltaMs <= 2000
          ? 10
          : durationDeltaMs <= 6000
            ? 4
            : durationDeltaMs > 15000
              ? -10
              : 0;
    }

    return {
      evidence: {
        titleSimilarity,
        artistSimilarity,
        durationDeltaMs,
        exactIsrc,
        score: base + adjustment,
        versionLabels: LABEL_ORDER.filter((l) => candidateLabels.has(l)),
      },
    };
  }
}
