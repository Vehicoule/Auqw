import {
  formatClock,
  formatRemaining,
  t,
  waveformAmplitudes,
  waveformBarExtent,
  waveformBarLayout,
} from '@auqw/ui-shared';
import { Artwork, Text } from './primitives.tsx';
import { progressPathState } from './motion.ts';
import { seekStepMs } from './keyboard.ts';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  const enabled = durationMs !== null && durationMs > 0 && onSeek !== undefined;
  const p = progressOf(positionMs, durationMs);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const stepped =
      onSeek === undefined ? null : seekStepMs(event.key, positionMs, durationMs);
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
        position: formatClock(positionMs),
        duration: formatClock(durationMs),
      })}
      min={0}
      max={Math.max(1, durationMs ?? 0)}
      step="any"
      value={Math.round(positionMs)}
      disabled={!enabled}
      onKeyDown={onKeyDown}
      onChange={
        enabled ? (event) => onSeek?.(Number(event.currentTarget.value)) : undefined
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

// One `M x y1 L x y2` segment per bar — the same model the native
// control draws, so both ports share the helper math verbatim.
function barsPathD(
  xs: readonly number[],
  amps: readonly number[],
): string {
  let d = '';
  for (let i = 0; i < xs.length; i += 1) {
    const extent = waveformBarExtent(
      amps[i] ?? 0,
      WAVE_MAX_EXTENT,
      WAVE_MIN_EXTENT,
      1,
    );
    d += `M${(xs[i] ?? 0).toFixed(2)} ${(WAVE_MID - extent).toFixed(2)} L${(
      xs[i] ?? 0
    ).toFixed(2)} ${(WAVE_MID + extent).toFixed(2)}`;
  }
  return d;
}

// Three amplitude terciles → three stroke opacities (mirrors native).
function partitionBars(
  xs: readonly number[],
  amps: readonly number[],
): readonly [string, string, string] {
  const sorted = [...amps].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)] ?? Infinity;
  const t2 = sorted[Math.floor((sorted.length * 2) / 3)] ?? Infinity;
  const groups: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < xs.length; i += 1) {
    const amp = amps[i] ?? 0;
    groups[amp <= t1 ? 0 : amp <= t2 ? 1 : 2].push(i);
  }
  return groups.map((g) =>
    barsPathD(
      g.map((i) => xs[i] ?? 0),
      g.map((i) => amps[i] ?? 0),
    ),
  ) as [string, string, string];
}

export type WaveformSeekProps = {
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly onSeek?: ((ms: number) => void) | undefined;
  readonly seed?: string | undefined;
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
  loading = false,
  labels = true,
  className,
}: WaveformSeekProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
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
  const enabled = durationMs !== null && durationMs > 0 && onSeek !== undefined;
  const isLoading = loading || durationMs === null;
  const p = progressOf(positionMs, durationMs);
  const fill = hover ?? p;
  const layout = useMemo(
    () => waveformBarLayout(width, WAVE_BAR_WIDTH, WAVE_BAR_GAP),
    [width],
  );
  const amps = useMemo(
    () => waveformAmplitudes(seed, layout.count),
    [seed, layout.count],
  );
  const [dLow, dMid, dHigh] = useMemo(
    () => partitionBars(layout.xs, amps),
    [layout, amps],
  );
  const dAll = useMemo(() => barsPathD(layout.xs, amps), [layout, amps]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const stepped =
      onSeek === undefined ? null : seekStepMs(event.key, positionMs, durationMs);
    if (stepped !== null) {
      event.preventDefault();
      onSeek?.(stepped);
    }
  };
  const bandStart = Math.min(p, fill);
  const bandEnd = Math.max(p, fill);
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
                width={fill * width}
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
                  stroke="var(--accent)"
                  strokeWidth={WAVE_BAR_WIDTH}
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.55}
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
          position: formatClock(positionMs),
          duration: formatClock(durationMs),
        })}
        min={0}
        max={Math.max(1, durationMs ?? 0)}
        step="any"
        value={Math.round(positionMs)}
        disabled={!enabled}
        onKeyDown={onKeyDown}
        onChange={
          enabled ? (event) => onSeek?.(Number(event.currentTarget.value)) : undefined
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
        style={{ '--uw-fill': `${fill * 100}%` } as React.CSSProperties}
      />
      {labels && (
        <div className="uw-wave__labels">
          <Text variant="metadata" color="secondary" numeric>
            {formatClock(positionMs)}
          </Text>
          <Text variant="metadata" color="secondary" numeric>
            {formatRemaining(positionMs, durationMs)}
          </Text>
        </div>
      )}
    </div>
  );
}
