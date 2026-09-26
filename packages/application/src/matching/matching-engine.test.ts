import {
  extractVersionLabels,
  MatchingEngine,
} from './matching-engine.ts';
import type { MatchCandidate } from './matching-engine.ts';
import type {
  Recording,
  SourceMapping,
  SourceRef,
  TrackMetadata,
  VersionLabel,
} from '../domain.ts';
import { assert, assertEqual } from '../testing/assert.ts';

let refCounter = 0;
function ref(id?: string): SourceRef {
  refCounter += 1;
  return {
    provider: 'youtube-music',
    kind: 'track',
    id: id ?? `ref${refCounter}`,
  };
}

function candidate(partial: {
  title: string;
  artist?: string | null;
  durationMs?: number | null;
  explicit?: boolean | null;
  isrc?: string | null;
  sourceRef?: SourceRef;
}): MatchCandidate {
  const base: TrackMetadata = {
    sourceRef: partial.sourceRef ?? ref(),
    title: partial.title,
    artist: partial.artist ?? null,
    album: null,
    durationMs: partial.durationMs ?? null,
    releaseYear: null,
    artwork: [],
    explicit: partial.explicit ?? null,
    genre: null,
    storefront: null,
  };
  const out: MatchCandidate = { ...base };
  if (partial.isrc !== undefined) {
    (out as { isrc?: string | null }).isrc = partial.isrc;
  }
  return out;
}

function recording(partial: {
  title: string;
  artist?: string | null;
  durationMs?: number | null;
  explicit?: boolean | null;
  isrc?: string | null;
  versionLabels?: readonly VersionLabel[];
}): Recording {
  const explicit = partial.explicit ?? null;
  return {
    id: 'rec',
    title: partial.title,
    artist: partial.artist ?? null,
    album: null,
    durationMs: partial.durationMs ?? null,
    releaseYear: null,
    artwork: [],
    explicit,
    genre: null,
    isrc: partial.isrc ?? null,
    versionLabels:
      partial.versionLabels ?? extractVersionLabels(partial.title, explicit),
    sourceRefs: [],
    mappings: [],
    provenance: 'provider',
  };
}

function mapping(
  target: SourceRef,
  status: SourceMapping['status'],
): SourceMapping {
  return {
    ref: target,
    status,
    matchedAtMs: 0,
    evidence: {
      titleSimilarity: 0,
      artistSimilarity: null,
      durationDeltaMs: null,
      exactIsrc: false,
      score: 0,
      versionLabels: [],
    },
  };
}

function labelTests(): void {
  assertDeep(extractVersionLabels('Roads (Live)', null), ['live']);
  assertDeep(
    extractVersionLabels('Blue (Remastered 2011)', null),
    ['remaster'],
  );
  assertDeep(extractVersionLabels('Night Drive - Remix', null), ['remix']);
  assertDeep(extractVersionLabels('Song (Alt Take)', null), ['alternate']);
  assertDeep(extractVersionLabels('Song', true), ['explicit']);
  assertDeep(extractVersionLabels('Song', false), ['clean']);
  assertDeep(extractVersionLabels('Plain Song', null), []);
  assertDeep(
    extractVersionLabels('Song (Live) [Remix]', null).slice().sort(),
    ['live', 'remix'],
  );
}

function assertDeep(actual: readonly string[], expected: readonly string[]) {
  assertEqual([...actual].join('|'), [...expected].join('|'));
}

function adversarialTests(): void {
  // 1. Intended live, candidates studio + live -> matched live.
  {
    const out = MatchingEngine.match(
      recording({
        title: 'Roads (Live)',
        artist: 'Portishead',
        durationMs: 300_000,
      }),
      [
        candidate({
          title: 'Roads',
          artist: 'Portishead',
          durationMs: 300_000,
        }),
        candidate({
          title: 'Roads (Live)',
          artist: 'Portishead',
          durationMs: 300_800,
        }),
      ],
    );
    assert(out.type === 'matched', `1: ${out.type}`);
    assertEqual(out.candidate.title, 'Roads (Live)');
    assertEqual(out.evidence.versionLabels.includes('live'), true);
  }

  // 2. Intended studio, candidates live + studio -> matched studio.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Song', artist: 'Artist', durationMs: 240_000 }),
      [
        candidate({
          title: 'Song (Live)',
          artist: 'Artist',
          durationMs: 240_000,
        }),
        candidate({
          title: 'Song',
          artist: 'Artist',
          durationMs: 241_000,
        }),
      ],
    );
    assert(out.type === 'matched', `2: ${out.type}`);
    assertEqual(out.candidate.title, 'Song');
  }

  // 3. Remaster axes match regardless of label word order.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Blue (Remastered 2011)', artist: 'Band' }),
      [
        candidate({ title: 'Blue', artist: 'Band' }),
        candidate({ title: 'Blue (2011 Remaster)', artist: 'Band' }),
      ],
    );
    assert(out.type === 'matched', `3: ${out.type}`);
    assertEqual(out.candidate.title, 'Blue (2011 Remaster)');
  }

  // 4. Dash-suffix remix label is furniture only when recognized.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Night Drive (Remix)', artist: 'Synth' }),
      [
        candidate({ title: 'Night Drive', artist: 'Synth' }),
        candidate({ title: 'Night Drive - Remix', artist: 'Synth' }),
      ],
    );
    assert(out.type === 'matched', `4: ${out.type}`);
    assertEqual(out.candidate.title, 'Night Drive - Remix');
  }

  // 5. clean-vs-explicit is a hard axis when both are known.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Track', artist: 'Artist', explicit: true }),
      [
        candidate({ title: 'Track', artist: 'Artist', explicit: false }),
        candidate({ title: 'Track', artist: 'Artist', explicit: true }),
      ],
    );
    assert(out.type === 'matched', `5: ${out.type}`);
    assertEqual(out.candidate.explicit, true);
  }

  // 6. Non-Latin exact beats transliteration.
  {
    const out = MatchingEngine.match(
      recording({ title: '夜の歌', artist: '東京サウンド' }),
      [
        candidate({ title: 'Yoru no Uta', artist: 'Tokyo Sound' }),
        candidate({ title: '夜の歌', artist: '東京サウンド' }),
      ],
    );
    assert(out.type === 'matched', `6: ${out.type}`);
    assertEqual(out.candidate.title, '夜の歌');
  }

  // 7. Exact title + different artist loses to exact artist —
  // verbatim lead-authored corpus case.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Home', artist: 'Artist A', durationMs: 200_000 }),
      [
        candidate({ title: 'Home', artist: 'Artist B', durationMs: 200_000 }),
        candidate({ title: 'Home', artist: 'Artist A', durationMs: 200_000 }),
      ],
    );
    assert(out.type === 'matched', `7: ${out.type}`);
    assertEqual(out.candidate.artist, 'Artist A');
  }

  // Artist blend sanity: dropped article still matches; the blended
  // similarity separates near-identical distinct names.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Song', artist: 'The Beatles', durationMs: 180_000 }),
      [
        candidate({ title: 'Song', artist: 'ZZ Top', durationMs: 180_000 }),
        candidate({ title: 'Song', artist: 'Beatles', durationMs: 180_000 }),
      ],
    );
    assert(out.type === 'matched', 'beatles: matched');
    assertEqual(out.candidate.artist, 'Beatles');
    const sim = out.evidence.artistSimilarity;
    assert(sim !== null && sim > 0.55 && sim < 1, `beatles sim ${sim}`);
  }

  // 8. Missing duration on both sides still matches.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Unknown Duration', artist: 'Artist' }),
      [candidate({ title: 'Unknown Duration', artist: 'Artist' })],
    );
    assert(out.type === 'matched', `8: ${out.type}`);
    assertEqual(out.evidence.durationDeltaMs, null);
  }

  // 9. Display-identical candidates are one choice: the review row
  // shows title + `artist · provider`, so a provider listing the same
  // song under two ids is a phantom tie — the best-scored member wins
  // (equal scores keep upstream order).
  {
    const rA = ref();
    const rB = ref();
    const out = MatchingEngine.match(
      recording({ title: 'Same', artist: 'Artist', durationMs: 200_000 }),
      [
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: rA,
        }),
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: rB,
        }),
      ],
    );
    assert(out.type === 'matched', `9: ${out.type}`);
    assertEqual(out.candidate.sourceRef, rA);
  }

  // 9b. The collapse precedes the margin check: two identical display
  // rows plus a genuinely different near-tie still gate. The review
  // parks every member (a reject must veto hidden duplicates too);
  // display collapsing is the view-model's job.
  {
    const rA = ref();
    const rB = ref();
    const rC = ref();
    const out = MatchingEngine.match(
      recording({ title: 'Same', artist: 'Artist', durationMs: 200_000 }),
      [
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: rA,
        }),
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: rB,
        }),
        candidate({
          title: 'Same',
          artist: 'Artist B',
          durationMs: 200_000,
          sourceRef: rC,
        }),
      ],
    );
    assert(out.type === 'ambiguous', `9b: ${out.type}`);
    assertEqual(out.candidates.length, 3);
    assertEqual(out.candidates[0]?.candidate.sourceRef, rA);
    assertEqual(out.candidates[1]?.candidate.sourceRef, rB);
    assertEqual(out.candidates[2]?.candidate.sourceRef, rC);
  }

  // 9c. Same title and artist but a different shown duration is a
  // distinct choice, not a duplicate: the review rows stay
  // distinguishable, so the near-tie still gates. The recording has
  // no duration, so scoring can't separate the two on that axis.
  {
    const rA = ref();
    const rB = ref();
    const out = MatchingEngine.match(
      recording({ title: 'Same', artist: 'Artist' }),
      [
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: rA,
        }),
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 300_000,
          sourceRef: rB,
        }),
      ],
    );
    assert(out.type === 'ambiguous', `9c: ${out.type}`);
    assertEqual(out.candidates.length, 2);
    // Sub-second metadata drift still renders the same clock and stays
    // one display group.
    const drift = MatchingEngine.match(
      recording({ title: 'Same', artist: 'Artist', durationMs: 200_000 }),
      [
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: rA,
        }),
        candidate({
          title: 'Same',
          artist: 'Artist',
          durationMs: 200_400,
          sourceRef: rB,
        }),
      ],
    );
    assert(drift.type === 'matched', `9c-drift: ${drift.type}`);
  }

  // 9d. The five-group cap admits new groups, never drops a member of
  // an admitted one: a duplicate arriving after the cap still parks,
  // so a reject vetoes it too (unparked duplicates stay playable).
  {
    const out = MatchingEngine.match(
      recording({ title: 'Same', artist: 'Artist' }),
      [
        // Five distinct display groups fill the cap...
        candidate({ title: 'Same', artist: 'Artist', sourceRef: { provider: 'p1', kind: 'track', id: 'p1-a' } }),
        candidate({ title: 'Same', artist: 'Artist', sourceRef: { provider: 'p2', kind: 'track', id: 'p2' } }),
        candidate({ title: 'Same', artist: 'Artist', sourceRef: { provider: 'p3', kind: 'track', id: 'p3' } }),
        candidate({ title: 'Same', artist: 'Artist', sourceRef: { provider: 'p4', kind: 'track', id: 'p4' } }),
        candidate({ title: 'Same', artist: 'Artist', sourceRef: { provider: 'p5', kind: 'track', id: 'p5' } }),
        // ...a sixth group is skipped...
        candidate({ title: 'Same', artist: 'Artist', sourceRef: { provider: 'p6', kind: 'track', id: 'p6' } }),
        // ...but a late member of the first group still parks.
        candidate({ title: 'Same', artist: 'Artist', sourceRef: { provider: 'p1', kind: 'track', id: 'p1-b' } }),
      ],
    );
    assert(out.type === 'ambiguous', `9d: ${out.type}`);
    assertEqual(out.candidates.length, 6);
    assert(
      out.candidates.some((c) => c.candidate.sourceRef.id === 'p1-b'),
      'late member of an admitted group must park',
    );
    assert(
      !out.candidates.some((c) => c.candidate.sourceRef.id === 'p6'),
      'sixth display group stays out',
    );
  }

  // 10. Hard label mismatch rejects even an exact-ISRC candidate.
  {
    const out = MatchingEngine.match(
      recording({ title: 'Take (Live)', artist: 'Artist', isrc: 'X1' }),
      [
        candidate({ title: 'Take', artist: 'Artist', isrc: 'X1' }),
        candidate({ title: 'Take (Live)', artist: 'Artist' }),
      ],
    );
    assert(out.type === 'matched', `10: ${out.type}`);
    assertEqual(out.candidate.title, 'Take (Live)');
    assertEqual(out.evidence.exactIsrc, false);
  }

  // 11. A user-confirmed mapping wins even when the auto score is lower.
  {
    const confirmedRef = ref();
    const out = MatchingEngine.match(
      recording({ title: 'Alpha', artist: 'One', durationMs: 100_000 }),
      [
        candidate({ title: 'Alpha', artist: 'One', durationMs: 100_000 }),
        candidate({ title: 'Totally Different', artist: 'Someone Else', sourceRef: confirmedRef }),
      ],
      [mapping(confirmedRef, 'user-confirmed')],
    );
    assert(out.type === 'matched', `11: ${out.type}`);
    assertEqual(out.candidate.sourceRef, confirmedRef);
  }

  // 12. A rejected mapping removes the ref; the next valid candidate wins.
  {
    const rejectedRef = ref();
    const keptRef = ref();
    const out = MatchingEngine.match(
      recording({ title: 'Gamma', artist: 'Artist', durationMs: 200_000 }),
      [
        candidate({
          title: 'Gamma',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: rejectedRef,
        }),
        candidate({
          title: 'Gamma',
          artist: 'Artist',
          durationMs: 200_000,
          sourceRef: keptRef,
        }),
      ],
      [mapping(rejectedRef, 'rejected')],
    );
    assert(out.type === 'matched', `12: ${out.type}`);
    assertEqual(out.candidate.sourceRef, keptRef);
  }
}

function edgeTests(): void {
  // One-code-point titles: exact still 1, unequal yields 0 (never
  // NaN) and is rejected below the similarity floor.
  {
    const matched = MatchingEngine.match(
      recording({ title: 'x', artist: 'Artist' }),
      [
        candidate({ title: 'y', artist: 'Artist' }),
        candidate({ title: 'x', artist: 'Artist' }),
      ],
    );
    assert(matched.type === 'matched', 'one-code-point exact match');
    assertEqual(matched.candidate.title, 'x');
    assertEqual(matched.evidence.titleSimilarity, 1);

    const rejected = MatchingEngine.match(
      recording({ title: 'x', artist: 'Artist' }),
      [candidate({ title: 'y', artist: 'Artist' })],
    );
    assertEqual(rejected.type, 'unavailable');
  }

  // Mapping conflicts resolve by latest matchedAtMs.
  {
    const target = ref();
    const kept = ref();
    const base = recording({
      title: 'Gamma',
      artist: 'Artist',
      durationMs: 200_000,
    });
    const candidates = [
      candidate({
        title: 'Gamma',
        artist: 'Artist',
        durationMs: 200_000,
        sourceRef: target,
      }),
      candidate({
        title: 'Other Title',
        artist: 'Other Artist',
        durationMs: 200_000,
        sourceRef: kept,
      }),
    ];

    // Newer rejected beats older user-confirmed -> ref removed.
    const out1 = MatchingEngine.match(base, candidates, [
      { ...mapping(target, 'user-confirmed'), matchedAtMs: 5 },
      { ...mapping(target, 'rejected'), matchedAtMs: 10 },
    ]);
    assert(out1.type === 'unavailable', `conflict latest rejected: ${out1.type}`);

    // Newer user-confirmed beats older rejected -> ref wins.
    const out2 = MatchingEngine.match(base, candidates, [
      { ...mapping(target, 'rejected'), matchedAtMs: 5 },
      { ...mapping(target, 'user-confirmed'), matchedAtMs: 10 },
    ]);
    assert(out2.type === 'matched', 'conflict latest confirmed');
    assertEqual(out2.candidate.sourceRef, target);

    // Equal timestamps: user-confirmed > rejected > automatic.
    const out3 = MatchingEngine.match(base, candidates, [
      { ...mapping(target, 'rejected'), matchedAtMs: 7 },
      { ...mapping(target, 'user-confirmed'), matchedAtMs: 7 },
    ]);
    assert(out3.type === 'matched', 'tie: confirmed wins');
    assertEqual(out3.candidate.sourceRef, target);

    const out4 = MatchingEngine.match(base, candidates, [
      { ...mapping(target, 'automatic'), matchedAtMs: 7 },
      { ...mapping(target, 'rejected'), matchedAtMs: 7 },
    ]);
    assert(out4.type === 'unavailable', 'tie: rejected beats automatic');
  }
}

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

const WORDS = ['river', 'night', 'blue', 'home', 'fire', 'light'];
const ARTISTS = ['portishead', 'radiohead', 'bjork', 'massive attack'];

function propertyHarness(): void {
  const AXES: readonly VersionLabel[] = [
    'live',
    'remix',
    'remaster',
    'alternate',
  ];
  const render = (title: string, labels: readonly VersionLabel[]) => {
    let out = title;
    for (const label of labels) {
      if (label === 'live') out += ' (Live)';
      else if (label === 'remix') out += ' (Remix)';
      else if (label === 'remaster') out += ' (Remastered)';
      else if (label === 'alternate') out += ' (Alternate Version)';
    }
    return out;
  };

  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = xorshift32(seed);
    const title = WORDS[rand() % WORDS.length] ?? 'river';
    const artist = ARTISTS[rand() % ARTISTS.length] ?? 'portishead';
    const axis = AXES[rand() % AXES.length] ?? 'live';
    const intendedHasAxis = rand() % 2 === 0;
    const sharedIsrc = rand() % 3 === 0 ? `ISRC${seed}` : null;

    const intendedLabels: VersionLabel[] = intendedHasAxis ? [axis] : [];
    const flippedLabels: VersionLabel[] = intendedHasAxis ? [] : [axis];
    const intended = recording({
      title: render(title, intendedLabels),
      artist,
      durationMs: 200_000,
      isrc: sharedIsrc,
      versionLabels: intendedLabels,
    });
    const a = candidate({
      title: render(title, intendedLabels),
      artist,
      durationMs: 200_000,
    });
    // B flips exactly one axis but is otherwise equal-or-better.
    const b = candidate({
      title: render(title, flippedLabels),
      artist,
      durationMs: 200_000,
      ...(sharedIsrc === null ? {} : { isrc: sharedIsrc }),
    });

    const out = MatchingEngine.match(intended, [b, a]);
    if (out.type === 'matched') {
      assert(
        out.candidate !== b,
        `seed ${seed}: label-flipped candidate matched (axis ${axis})`,
      );
    }
    if (out.type === 'ambiguous') {
      for (const entry of out.candidates) {
        assert(
          entry.candidate !== b,
          `seed ${seed}: label-flipped candidate in ambiguous set`,
        );
      }
    }
  }
}

export function run(): void {
  labelTests();
  adversarialTests();
  edgeTests();
  propertyHarness();
}
