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
  for (let i = 0; i < allTokens.length; i += 1) {
    const token = allTokens[i];
    if (token === undefined) {
      continue;
    }
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

/** Sørensen–Dice over Unicode code-point bigrams. */
function dice(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const aLen = [...a].length;
  const bLen = [...b].length;
  // One-code-point strings have no bigrams; unequal strings score 0,
  // never NaN.
  if (aLen < 2 || bLen < 2) {
    return 0;
  }
  const bigrams = (s: string): Map<string, number> => {
    const grams = new Map<string, number>();
    const chars = [...s];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const gram = `${chars[i] ?? ''}${chars[i + 1] ?? ''}`;
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    return grams;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  let overlap = 0;
  for (const [gram, count] of left) {
    overlap += Math.min(count, right.get(gram) ?? 0);
  }
  return (2 * overlap) / (aLen - 1 + bLen - 1);
}

/** Sørensen–Dice over whitespace-token multisets. */
function tokenDice(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const tokens = (s: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const token of s.split(/\s+/u).filter((t) => t.length > 0)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
  };
  const left = tokens(a);
  const right = tokens(b);
  let overlap = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of left.values()) {
    leftTotal += count;
  }
  for (const count of right.values()) {
    rightTotal += count;
  }
  for (const [token, count] of left) {
    overlap += Math.min(count, right.get(token) ?? 0);
  }
  return (2 * overlap) / (leftTotal + rightTotal);
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

function refKey(ref: SourceRef): string {
  return `${ref.provider}\u001f${ref.kind}\u001f${ref.id}`;
}

function normalizeFree(text: string): string {
  return tokenize(text).join(' ');
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
    const precedence = (status: SourceMapping['status']): number =>
      status === 'user-confirmed' ? 2 : status === 'rejected' ? 1 : 0;
    const mappingByRef = new Map<string, SourceMapping>();
    for (const mapping of userMappings) {
      const key = refKey(mapping.ref);
      const existing = mappingByRef.get(key);
      if (
        existing === undefined ||
        mapping.matchedAtMs > existing.matchedAtMs ||
        (mapping.matchedAtMs === existing.matchedAtMs &&
          precedence(mapping.status) > precedence(existing.status))
      ) {
        mappingByRef.set(key, mapping);
      }
    }

    const eligible: { candidate: MatchCandidate; index: number }[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (candidate === undefined) {
        continue;
      }
      const mapping = mappingByRef.get(refKey(candidate.sourceRef));
      if (mapping?.status === 'rejected') {
        continue;
      }
      if (mapping?.status === 'user-confirmed') {
        // A user-confirmed mapping wins before auto scoring; evidence
        // is still computed for the record (null if it would have
        // been hard-rejected, in which case the user verdict stands
        // with a zero-score evidence record).
        const scored = this.evidence(recording, candidate);
        const evidence: MatchEvidence =
          scored?.evidence ??
          {
            titleSimilarity: 0,
            artistSimilarity: null,
            durationDeltaMs: null,
            exactIsrc: false,
            score: 0,
            versionLabels: extractVersionLabels(
              candidate.title,
              candidate.explicit,
            ),
          };
        return { type: 'matched', candidate, evidence };
      }
      eligible.push({ candidate, index: i });
    }

    const scored: Scored[] = [];
    for (const { candidate, index } of eligible) {
      const outcome = this.evidence(recording, candidate);
      if (outcome !== null) {
        scored.push({ candidate, evidence: outcome.evidence, index });
      }
    }
    scored.sort((a, b) => b.evidence.score - a.evidence.score || a.index - b.index);

    const top = scored[0];
    if (top === undefined) {
      return { type: 'unavailable', reason: 'no candidates' };
    }
    const second = scored[1];
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
      const near = scored
        .filter((s) => top.evidence.score - s.evidence.score < 7)
        .slice(0, 5)
        .map((s) => ({ candidate: s.candidate, evidence: s.evidence }));
      return { type: 'ambiguous', candidates: near };
    }
    return { type: 'unavailable', reason: 'below threshold' };
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
    const intendedLabels = new Set(recording.versionLabels);
    const candidateLabels = new Set(
      extractVersionLabels(candidate.title, candidate.explicit),
    );

    // Hard rejections come before any scoring; a label mismatch
    // rejects even an exact-ISRC candidate.
    for (const axis of HARD_AXES) {
      if (intendedLabels.has(axis) !== candidateLabels.has(axis)) {
        return null;
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
    if (
      intendedCE !== null &&
      candidateCE !== null &&
      intendedCE !== candidateCE
    ) {
      return null;
    }

    const candidateBase = analyzeTitle(candidate.title).base;
    const titleSimilarity = dice(intended.base, candidateBase);
    // Artist similarity blends code-point and token Dice: near-equal
    // names like 'Artist A'/'Artist B' separate cleanly while
    // reorderings and dropped articles stay close.
    const artistSimilarity =
      recording.artist !== null && candidate.artist !== null
        ? (dice(
          normalizeFree(recording.artist),
          normalizeFree(candidate.artist),
        ) +
          tokenDice(
            normalizeFree(recording.artist),
            normalizeFree(candidate.artist),
          )) /
        2
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
      if (durationDeltaMs <= 2000) {
        adjustment = 10;
      } else if (durationDeltaMs <= 6000) {
        adjustment = 4;
      } else if (durationDeltaMs > 15000) {
        adjustment = -10;
      }
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
