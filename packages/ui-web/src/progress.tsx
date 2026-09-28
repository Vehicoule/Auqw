import {
  formatClock,
  formatRemaining,
  resamplePeaks,
  t,
  waveformBarExtent,
  waveformBarLayout,
  waveformPeaks,
} from '@auqw/ui-shared';
import type { WaveformPeak } from '@auqw/ui-shared';
import { Artwork, Text } from './primitives.tsx';
import { progressPathState } from './motion.ts';
import { seekStepMs } from './keyboard.ts';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent } from 'react';

// Same squared ring the native 'arc' variant draws — the desktop
// chrome uses it everywhere (there is no platform split on web).
export const SQUARED_RING_PATH =
  'M26 3 L38 3 Q49 3 49 14 L49 38 Q49 49 38 49 L14 49 Q3 49 3 38 L3 14 Q3 3 14 3 Z';

type Pt = { readonly x: number; readonly y: number };

type Seg =
  | { readonly kind: 'l'; readonly a: Pt; readonly b: Pt }
  | { readonly kind: 'q'; readonly a: Pt; readonly c: Pt; readonly b: Pt };

const pt = (x: number, y: number): Pt => ({ x, y });

const RING_SEGS: readonly Seg[] = [
  { kind: 'l', a: pt(26, 3), b: pt(38, 3) },
  { kind: 'q', a: pt(38, 3), c: pt(49, 3), b: pt(49, 14) },
  { kind: 'l', a: pt(49, 14), b: pt(49, 38) },
  { kind: 'q', a: pt(49, 38), c: pt(49, 49), b: pt(38, 49) },
  { kind: 'l', a: pt(38, 49), b: pt(14, 49) },
  { kind: 'q', a: pt(14, 49), c: pt(3, 49), b: pt(3, 38) },
  { kind: 'l', a: pt(3, 38), b: pt(3, 14) },
  { kind: 'q', a: pt(3, 14), c: pt(3, 3), b: pt(14, 3) },
  { kind: 'l', a: pt(14, 3), b: pt(26, 3) },
];

function segPoint(seg: Seg, t: number): Pt {
  if (seg.kind === 'l') {
    return pt(seg.a.x + (seg.b.x - seg.a.x) * t, seg.a.y + (seg.b.y - seg.a.y) * t);
  }
  const u = 1 - t;
  return pt(
    u * u * seg.a.x + 2 * u * t * seg.c.x + t * t * seg.b.x,
    u * u * seg.a.y + 2 * u * t * seg.c.y + t * t * seg.b.y,
  );
}

// Polyline approximation of the ring outline — the same 24-sample
// resolution the native port uses, so the dash model is identical.
function segLength(seg: Seg): number {
  if (seg.kind === 'l') {
    return Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  }
  let length = 0;
  let prev = seg.a;
  for (let i = 1; i <= 24; i += 1) {
    const cur = segPoint(seg, i / 24);
    length += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  return length;
}

export const SQUARED_RING_LENGTH = RING_SEGS.map(segLength).reduce(
  (a, b) => a + b,
  0,
);

export type ArtworkRingProps = {
  readonly artworkUrl: string | null;
  readonly progress: number;
  readonly size?: number | undefined;
  readonly artworkSize?: number | undefined;
  readonly dimmed?: boolean | undefined;
  readonly className?: string | undefined;
};

export function ArtworkRing({
  artworkUrl,
  progress,
  size = 48,
  artworkSize = 38,
  dimmed = false,
  className,
}: ArtworkRingProps) {
  const ring = progressPathState(progress, SQUARED_RING_LENGTH);
  return (
    <div
      className={`uw-ring${dimmed ? ' uw-artwork--dimmed' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Artwork url={artworkUrl} size={artworkSize} cornerRadius={7} dimmed={dimmed} />
      <svg width={size} height={size} viewBox="0 0 52 52" className="uw-ring__svg">
        <path
          d={SQUARED_RING_PATH}
          fill="none"
          stroke="var(--fg18)"
          strokeWidth={1}
        />
        <path
          className="uw-ring__arc"
          d={SQUARED_RING_PATH}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${ring.dashLength} ${ring.dashLength}`}
          strokeDashoffset={ring.dashOffset}
          opacity={ring.opacity}
        />
      </svg>
    </div>
  );
}

function progressOf(positionMs: number, durationMs: number | null): number {
  if (durationMs === null || durationMs <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, positionMs / durationMs));
}

/**
 * Commit-on-release scrub state for the range-input seek controls:
 * a pointer drag previews `scrubMs` and fires `onSeek` once at
 * pointer-up, matching the native pan gesture. Committing per
 * `input` event serialized a queue persist plus a transport seek on
 * every pixel — the transport re-anchored mid-drag and the thumb
 * kept snapping back to the last published position, so the bar
 * couldn't be dragged. `heldMs` keeps the committed position shown
 * until the publish round-trip lands (or the settle timer lapses),
 * the same optimistic fill the native control applies.
 */
function useScrubCommit(
  positionMs: number,
  durationMs: number | null,
  onSeek: ((ms: number) => void) | undefined,
): {
  readonly enabled: boolean;
  readonly shownMs: number;
  readonly onScrubStart: () => void;
  readonly onScrubValue: (ms: number) => void;
  readonly onScrubEnd: (commitMs: number | null) => void;
} {
  const enabled =
    durationMs !== null && durationMs > 0 && onSeek !== undefined;
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [heldMs, setHeldMs] = useState<number | null>(null);
  const dragging = useRef(false);
  const scrubRef = useRef<number | null>(null);
  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;
  const heldBaseline = useRef(0);
  const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback(
    (ms: number) => {
      dragging.current = false;
      scrubRef.current = null;
      setScrubMs(null);
      heldBaseline.current = positionRef.current;
      setHeldMs(ms);
      if (heldTimer.current !== null) {
        clearTimeout(heldTimer.current);
      }
      heldTimer.current = setTimeout(() => {
        heldTimer.current = null;
        setHeldMs(null);
      }, 800);
      onSeek?.(ms);
    },
    [onSeek],
  );

  // The publish lands as a `positionMs` change: once it does, the
  // real value is authoritative again and the hold releases. A
  // paused/noop seek that never republishes releases on the timer.
  useEffect(() => {
    if (heldMs !== null && positionMs !== heldBaseline.current) {
      if (heldTimer.current !== null) {
        clearTimeout(heldTimer.current);
        heldTimer.current = null;
      }
      setHeldMs(null);
    }
  }, [positionMs, heldMs]);
  useEffect(
    () => () => {
      if (heldTimer.current !== null) {
        clearTimeout(heldTimer.current);
      }
    },
    [],
  );
  // A disable landing mid-drag abandons the gesture (pointerup will
  // never arrive on a disabled input) — restore the real fill.
  useEffect(() => {
    if (!enabled && dragging.current) {
      dragging.current = false;
      scrubRef.current = null;
      setScrubMs(null);
    }
  }, [enabled]);

  const onScrubStart = useCallback(() => {
    if (enabled) {
      dragging.current = true;
      scrubRef.current = null;
    }
  }, [enabled]);
  const onScrubValue = useCallback(
    (ms: number) => {
      if (dragging.current) {
        scrubRef.current = ms;
        setScrubMs(ms);
      } else if (enabled) {
        // No pointer drag in flight — keyboard Home/End and AT
        // commits seek immediately, as before.
        commit(ms);
      }
    },
    [commit, enabled],
  );
  const onScrubEnd = useCallback(
    (commitMs: number | null) => {
      if (!dragging.current) {
        return;
      }
      if (commitMs === null) {
        // A cancelled/empty gesture restores the real fill — only a
        // released pointer's position may move playback, so the
        // preview must be dropped before any fallback is consulted.
        dragging.current = false;
        scrubRef.current = null;
        setScrubMs(null);
        return;
      }
      commit(scrubRef.current ?? commitMs);
    },
    [commit],
  );
  return {
    enabled,
    shownMs: scrubMs ?? heldMs ?? positionMs,
    onScrubStart,
    onScrubValue,
    onScrubEnd,
  };
}

export type LinearScrubberProps = {
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly className?: string | undefined;
};

// The native LinearScrubber is a pan-gesture strip; the web port is a
// real range input — the browser gives focus, arrows, and AT a slider
// for free, and the ±10s step stays wired via Arrow keys.
export function LinearScrubber({
  positionMs,
  durationMs,
  onSeek,
  className,
}: LinearScrubberProps) {
  const scrub = useScrubCommit(positionMs, durationMs, onSeek);
  const { enabled, shownMs } = scrub;
  const p = progressOf(shownMs, durationMs);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const stepped =
      onSeek === undefined ? null : seekStepMs(event.key, shownMs, durationMs);
    if (stepped !== null) {
      event.preventDefault();
      onSeek?.(stepped);
    }
  };
  return (
    <input
      type="range"
      className={`uw-scrubber${enabled ? '' : ' uw-off'}${className ? ` ${className}` : ''}`}
      aria-label={t('progress.a11y.seek')}
      aria-valuetext={t('progress.a11y.value', {
        position: formatClock(shownMs),
        duration: formatClock(durationMs),
      })}
      min={0}
      max={Math.max(1, durationMs ?? 0)}
      step="any"
      value={Math.round(shownMs)}
      disabled={!enabled}
      onKeyDown={onKeyDown}
      onPointerDown={enabled ? scrub.onScrubStart : undefined}
      onPointerUp={
        enabled
          ? (event) =>
            scrub.onScrubEnd(Number(event.currentTarget.value))
          : undefined
      }
      onPointerCancel={enabled ? () => scrub.onScrubEnd(null) : undefined}
      onLostPointerCapture={enabled ? () => scrub.onScrubEnd(null) : undefined}
      onChange={
        enabled
          ? (event) => scrub.onScrubValue(Number(event.currentTarget.value))
          : undefined
      }
      style={{ '--uw-fill': `${p * 100}%` } as React.CSSProperties}
    />
  );
}

const WAVE_HEIGHT = 48;
const WAVE_MID = 24;
const WAVE_MAX_EXTENT = 20;
const WAVE_MIN_EXTENT = 2.4;
const WAVE_BAR_WIDTH = 3;
const WAVE_BAR_GAP = 2.5;

// One `M x y1 L x y2` segment per bar, asymmetric around the midline
// — the same model the native control draws, so both ports share the
// helper math verbatim.
function barsPathD(
  xs: readonly number[],
  peaks: readonly WaveformPeak[],
): string {
  let d = '';
  for (let i = 0; i < xs.length; i += 1) {
    const peak = peaks[i];
    const upExtent = waveformBarExtent(
      peak?.up ?? 0,
      WAVE_MAX_EXTENT,
      WAVE_MIN_EXTENT,
      1,
    );
    const downExtent = waveformBarExtent(
      peak?.down ?? 0,
      WAVE_MAX_EXTENT,
      WAVE_MIN_EXTENT,
      1,
    );
    d += `M${(xs[i] ?? 0).toFixed(2)} ${(WAVE_MID - upExtent).toFixed(2)} L${(
      xs[i] ?? 0
    ).toFixed(2)} ${(WAVE_MID + downExtent).toFixed(2)}`;
  }
  return d;
}

// Three amplitude terciles → three stroke opacities (mirrors native);
// a bar's loudness is its longer arm.
function partitionBars(
  xs: readonly number[],
  peaks: readonly WaveformPeak[],
): readonly [string, string, string] {
  const sorted = peaks
    .map((p) => Math.max(p.up, p.down))
    .sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)] ?? Infinity;
  const t2 = sorted[Math.floor((sorted.length * 2) / 3)] ?? Infinity;
  const groups: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < xs.length; i += 1) {
    const amp = Math.max(peaks[i]?.up ?? 0, peaks[i]?.down ?? 0);
    groups[amp <= t1 ? 0 : amp <= t2 ? 1 : 2].push(i);
  }
  return groups.map((g) =>
    barsPathD(
      g.map((i) => xs[i] ?? 0),
      g.map((i) => peaks[i] ?? { up: 0, down: 0 }),
    ),
  ) as [string, string, string];
}

export type WaveformSeekProps = {
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly seed?: string | undefined;
  /**
   * Real measured peaks at the canonical resolution (`peaks.ts`),
   * resampled to the bar count. Absent/null keeps the seeded
   * `waveformPeaks` pattern — extraction is lazy, so the seeded
   * bars are both the pending state and the failure fallback.
   */
  readonly peaks?: readonly WaveformPeak[] | null | undefined;
  readonly loading?: boolean | undefined;
  readonly labels?: boolean | undefined;
  readonly className?: string | undefined;
};

// Bars are decorative; the actual control is the range input carrying
// the same a11y contract (`seek`, clock value text, ±10s arrows).
export function WaveformSeek({
  positionMs,
  durationMs,
  onSeek,
  seed = 'auqw',
  peaks,
  loading = false,
  labels = true,
  className,
}: WaveformSeekProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  const scrub = useScrubCommit(positionMs, durationMs, onSeek);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) {
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const enabled = scrub.enabled;
  const shownMs = scrub.shownMs;
  const isLoading = loading || durationMs === null;
  const p = progressOf(shownMs, durationMs);
  const layout = useMemo(
    () => waveformBarLayout(width, WAVE_BAR_WIDTH, WAVE_BAR_GAP),
    [width],
  );
  const bars = useMemo(
    () =>
      peaks !== undefined && peaks !== null && peaks.length > 0
        ? resamplePeaks(peaks, layout.count)
        : waveformPeaks(seed, layout.count),
    [peaks, seed, layout.count],
  );
  const [dLow, dMid, dHigh] = useMemo(
    () => partitionBars(layout.xs, bars),
    [layout, bars],
  );
  const dAll = useMemo(() => barsPathD(layout.xs, bars), [layout, bars]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const stepped =
      onSeek === undefined ? null : seekStepMs(event.key, shownMs, durationMs);
    if (stepped !== null) {
      event.preventDefault();
      onSeek?.(stepped);
    }
  };
  const preview = hover ?? p;
  const bandStart = Math.min(p, preview);
  const bandEnd = Math.max(p, preview);
  // Forward preview tints unplayed bars with accent; backward preview
  // dims the played span that would be given back.
  const bandBackward = preview < p;
  return (
    <div className={`uw-wave${className ? ` ${className}` : ''}`} ref={rootRef}>
      <svg
        className="uw-wave__bars"
        width={width}
        height={WAVE_HEIGHT}
        aria-hidden="true"
      >
        {isLoading ? (
          <>
            {layout.xs.map((x, i) => (
              <rect
                key={i}
                x={x - WAVE_BAR_WIDTH / 2}
                y={WAVE_MID - WAVE_MIN_EXTENT}
                width={WAVE_BAR_WIDTH}
                height={WAVE_MIN_EXTENT * 2}
                rx={1.5}
                fill="var(--fg18)"
              />
            ))}
            <clipPath id={`bars-${uid}`}>
              {layout.xs.map((x, i) => (
                <rect
                  key={i}
                  x={x - WAVE_BAR_WIDTH / 2}
                  y={WAVE_MID - WAVE_MIN_EXTENT}
                  width={WAVE_BAR_WIDTH}
                  height={WAVE_MIN_EXTENT * 2}
                  rx={1.5}
                />
              ))}
            </clipPath>
            <g clipPath={`url(#bars-${uid})`}>
              <rect
                className="uw-wave__shimmer"
                x={0}
                y={0}
                width={width * 0.16}
                height={WAVE_HEIGHT}
                fill="var(--accent)"
                opacity={0.55}
              />
            </g>
          </>
        ) : (
          <>
            <clipPath id={`played-${uid}`}>
              <rect
                className="uw-wave__fill"
                x={0}
                y={0}
                height={WAVE_HEIGHT}
                width={p * width}
              />
            </clipPath>
            {hover !== null && (
              <clipPath id={`hover-${uid}`}>
                <rect
                  x={bandStart * width}
                  y={0}
                  height={WAVE_HEIGHT}
                  width={(bandEnd - bandStart) * width}
                />
              </clipPath>
            )}
            <path
              d={dLow}
              stroke="var(--fg18)"
              strokeWidth={WAVE_BAR_WIDTH}
              strokeLinecap="round"
              fill="none"
              opacity={0.6}
            />
            <path
              d={dMid}
              stroke="var(--fg18)"
              strokeWidth={WAVE_BAR_WIDTH}
              strokeLinecap="round"
              fill="none"
              opacity={0.8}
            />
            <path
              d={dHigh}
              stroke="var(--fg18)"
              strokeWidth={WAVE_BAR_WIDTH}
              strokeLinecap="round"
              fill="none"
              opacity={1}
            />
            <g clipPath={`url(#played-${uid})`}>
              <path
                d={dAll}
                stroke="var(--accent)"
                strokeWidth={WAVE_BAR_WIDTH}
                strokeLinecap="round"
                fill="none"
              />
            </g>
            {hover !== null && (
              <g clipPath={`url(#hover-${uid})`}>
                <path
                  d={dAll}
                  stroke={bandBackward ? 'var(--bg)' : 'var(--accent)'}
                  strokeWidth={WAVE_BAR_WIDTH}
                  strokeLinecap="round"
                  fill="none"
                  opacity={bandBackward ? 0.45 : 0.55}
                />
              </g>
            )}
          </>
        )}
      </svg>
      <input
        type="range"
        className={`uw-scrubber uw-wave__input${enabled ? '' : ' uw-off'}`}
        aria-label={t('progress.a11y.seek')}
        aria-valuetext={t('progress.a11y.value', {
          position: formatClock(shownMs),
          duration: formatClock(durationMs),
        })}
        min={0}
        max={Math.max(1, durationMs ?? 0)}
        step="any"
        value={Math.round(shownMs)}
        disabled={!enabled}
        onKeyDown={onKeyDown}
        onPointerDown={enabled ? scrub.onScrubStart : undefined}
        onPointerUp={
          enabled
            ? (event) => scrub.onScrubEnd(Number(event.currentTarget.value))
            : undefined
        }
        onPointerCancel={enabled ? () => scrub.onScrubEnd(null) : undefined}
        onLostPointerCapture={
          enabled ? () => scrub.onScrubEnd(null) : undefined
        }
        onChange={
          enabled
            ? (event) => scrub.onScrubValue(Number(event.currentTarget.value))
            : undefined
        }
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width > 0) {
            setHover(
              Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            );
          }
        }}
        onPointerLeave={() => setHover(null)}
        style={{ '--uw-fill': `${p * 100}%` } as React.CSSProperties}
      />
      {labels && (
        <div className="uw-wave__labels">
          <Text variant="metadata" color="secondary" numeric>
            {formatClock(shownMs)}
          </Text>
          <Text variant="metadata" color="secondary" numeric>
            {formatRemaining(shownMs, durationMs)}
          </Text>
        </div>
      )}
    </div>
  );
}
