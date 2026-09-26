// Deterministic decorative waveform + ring geometry shared by the
// native and web progress controls. These are not real peaks — the
// spec (docs/specs/design.md §87) keeps measured peaks deferred, so a
// hashed pattern stands in until the audio pipeline provides them.

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function fnv1a(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Cheap stream of 32-bit words derived from one seed — xorshift on a
// re-hashed state so each draw is independent of the previous digits.
function seedStream(seed: string, stream: number): () => number {
  let state = (fnv1a(`${seed}#${stream}`) || 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function seededRange(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

export function waveformAmplitudes(
  seed: string,
  count: number,
): readonly number[] {
  if (count <= 0 || !Number.isFinite(count)) {
    return [];
  }
  const rand = seedStream(seed, 0);
  const p1 = rand();
  const p2 = rand();
  const p3 = rand();
  const f1 = seededRange(rand, 1.5, 2.5);
  const f2 = seededRange(rand, 4, 6);
  const f3 = seededRange(rand, 9, 13);
  const jitter = seedStream(seed, 1);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const u = count === 1 ? 0.5 : i / (count - 1);
    const wave =
      0.55 * Math.sin(2 * Math.PI * (f1 * u + p1)) +
      0.3 * Math.sin(2 * Math.PI * (f2 * u + p2)) +
      0.15 * Math.sin(2 * Math.PI * (f3 * u + p3));
    const value = 0.5 + 0.5 * wave + (jitter() * 2 - 1) * 0.12;
    out.push(Math.min(1, Math.max(0.12, value)));
  }
  return out;
}

export type WaveformBarLayout = {
  readonly count: number;
  readonly step: number;
  readonly barWidth: number;
  /** Bar center x positions in pixels. */
  readonly xs: readonly number[];
};

export function waveformBarLayout(
  width: number,
  barWidth = 3,
  gap = 2.5,
): WaveformBarLayout {
  const step = barWidth + gap;
  const count = Math.max(0, Math.floor((width - gap) / step));
  if (count <= 0) {
    return { count: 0, step, barWidth, xs: [] };
  }
  const leftover = width - (count * step - gap);
  const xs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    xs.push(leftover / 2 + i * step + barWidth / 2);
  }
  return { count, step, barWidth, xs };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function waveformBarExtent(
  amplitude: number,
  maxExtent: number,
  minExtent = 2.4,
  bloom = 1,
): number {
  const eased = Number.isFinite(bloom)
    ? easeOutCubic(clamp01(bloom))
    : 0;
  return minExtent + (maxExtent - minExtent) * amplitude * eased;
}

export function staggerProgress(
  progress: number,
  index: number,
  count: number,
): number {
  if (count <= 0) {
    return 1;
  }
  const delay = (index / count) * 0.55;
  return clamp01((progress - delay) / (1 - delay));
}

export function shimmerHighlight(
  fraction: number,
  phase: number,
  band = 0.16,
): number {
  const d = Math.abs(fraction - phase);
  const wrapped = Math.min(d, 1 - d);
  return clamp01(1 - wrapped / band);
}

export function ringTrackDash(
  progress: number,
  pathLength: number,
  gapLength: number,
): { readonly dashArray: string; readonly dashOffset: number; readonly visible: boolean } {
  const start = clamp01(progress) * pathLength + gapLength;
  const end = pathLength - gapLength;
  const len = Math.max(0, end - start);
  return {
    dashArray: `${len} ${pathLength}`,
    dashOffset: -start,
    visible: len > 0.5,
  };
}

export function waveAmplitudeFor(
  progress: number,
  playing: boolean,
): number {
  if (!playing) {
    return 0;
  }
  const enter = clamp01((progress - 0.04) / (0.1 - 0.04));
  const exit = clamp01((0.98 - progress) / (0.98 - 0.92));
  return clamp01(Math.min(enter, exit));
}
