import {
  formatClock,
  formatRemaining,
  progressPathState,
  resamplePeaks,
  t,
  waveformBarExtent,
  waveformBarLayout,
  waveformPeaks,
} from '@auqw/ui-shared';
import type { WaveformPeak } from '@auqw/ui-shared';
import { Artwork, Text } from './primitives.tsx';
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
import type {
  ChangeEvent,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

// Same squared ring the native 'arc' variant draws — the desktop
// chrome uses it everywhere (there is no platform split on web).
const SQUARED_RING_PATH =
  'M26 3 L38 3 Q49 3 49 14 L49 38 Q49 49 38 49 L14 49 Q3 49 3 38 L3 14 Q3 3 14 3 Z';

// [x1, y1, x2, y2] line or [x1, y1, cx, cy, x2, y2] quadratic corner —
// the same outline SQUARED_RING_PATH draws.
type Seg =
  | readonly [number, number, number, number]
  | readonly [number, number, number, number, number, number];

const RING_SEGS: readonly Seg[] = [
  [26, 3, 38, 3], [38, 3, 49, 3, 49, 14], [49, 14, 49, 38],
  [49, 38, 49, 49, 38, 49], [38, 49, 14, 49], [14, 49, 3, 49, 3, 38],
  [3, 38, 3, 14], [3, 14, 3, 3, 14, 3], [14, 3, 26, 3],
];

// Polyline approximation of the ring outline — the same 24-sample
// resolution the native port uses, so the dash model is identical.
function segLength(seg: Seg): number {
  if (seg.length === 4) {
    return Math.hypot(seg[2] - seg[0], seg[3] - seg[1]);
  }
  let length = 0;
  let px = seg[0];
  let py = seg[1];
  for (let i = 1; i <= 24; i += 1) {
    const s = i / 24;
    const u = 1 - s;
    const x = u * u * seg[0] + 2 * u * s * seg[2] + s * s * seg[4];
    const y = u * u * seg[1] + 2 * u * s * seg[3] + s * s * seg[5];
    length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return length;
}

const SQUARED_RING_LENGTH = RING_SEGS.map(segLength).reduce(
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

export function progressOf(positionMs: number, durationMs: number | null): number {
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
  onSeek:
    | ((ms: number, expectedOccurrenceId?: string) => void)
    | undefined,
  trackKey: string | null | undefined,
): {
  readonly enabled: boolean;
  readonly shownMs: number;
  readonly onScrubStart: (pointerId: number) => void;
  readonly onScrubValue: (ms: number) => void;
  readonly onScrubEnd: (commitMs: number | null, pointerId: number) => void;
  readonly onScrubKey: (key: string) => boolean;
} {
  const enabled =
    durationMs !== null && durationMs > 0 && onSeek !== undefined;
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [heldMs, setHeldMs] = useState<number | null>(null);
  // Pointer identity tracking: `activePointer` is the pointer id
  // driving the drag; `deadPointers` are ids whose gesture died
  // mid-press (track flip, disable, a second contact that never
  // owned one) — their `input` events stay ignored until their
  // real release, observed at the document where pointerup always
  // bubbles, so they can never commit as a fake keyboard seek. A
  // tombstone also drains when a live pointerdown arrives with the
  // same id: a recycled id proves the missed release.
  const pointerPhase = useRef<'none' | 'drag'>('none');
  const activePointer = useRef<number | null>(null);
  const deadPointers = useRef<Set<number>>(new Set());
  const scrubRef = useRef<number | null>(null);
  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;
  const trackKeyRef = useRef(trackKey);
  trackKeyRef.current = trackKey;
  const heldBaseline = useRef(0);
  const heldKey = useRef(trackKey);
  const gestureKey = useRef<string | null | undefined>(undefined);
  const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The shared gesture teardown — every abort path (cancel, disable,
  // track change, dead-pointer drain) drops the same refs+state.
  const clearDrag = () => {
    pointerPhase.current = 'none';
    scrubRef.current = null;
    gestureKey.current = undefined;
    setScrubMs(null);
  };
  const killDrag = () => {
    if (activePointer.current !== null) {
      deadPointers.current.add(activePointer.current);
      activePointer.current = null;
    }
    clearDrag();
  };

  // Held-position teardown — every release path (publish landed,
  // track changed, unmount) clears the settle timer the same way.
  const stopHoldTimer = () => {
    if (heldTimer.current !== null) {
      clearTimeout(heldTimer.current);
      heldTimer.current = null;
    }
  };
  const releaseHold = () => {
    stopHoldTimer();
    setHeldMs(null);
  };

  const commit = useCallback(
    (ms: number) => {
      // `step="any"` hands fractional values to the DOM; session
      // positions are integer ms — round at the commit boundary.
      const rounded = Math.round(ms);
      pointerPhase.current = 'none';
      activePointer.current = null;
      scrubRef.current = null;
      setScrubMs(null);
      heldBaseline.current = positionRef.current;
      // The hold belongs to the track the gesture began on — a
      // mid-drag track change commits nothing on the new track.
      const begunOn =
        gestureKey.current !== undefined
          ? gestureKey.current
          : trackKeyRef.current;
      heldKey.current = begunOn;
      gestureKey.current = undefined;
      setHeldMs(rounded);
      stopHoldTimer();
      heldTimer.current = setTimeout(() => {
        heldTimer.current = null;
        setHeldMs(null);
      }, 800);
      // The begun-on key rides to the session too — the ref
      // compare covers flips React already rendered; the session
      // guard covers the sub-frame window before it.
      onSeek?.(rounded, begunOn ?? undefined);
    },
    [onSeek],
  );

  // The publish lands as a `positionMs` change: once it does, the
  // real value is authoritative again and the hold releases. A
  // paused/noop seek that never republishes releases on the timer.
  useEffect(() => {
    if (heldMs !== null && positionMs !== heldBaseline.current) {
      releaseHold();
    }
  }, [positionMs, heldMs]);
  useEffect(() => stopHoldTimer, []);
  // Every pointer release bubbles to the document — even one
  // landing off the control or while it's disabled. Draining dead
  // ids there means a held dead pointer keeps ignoring its input
  // (a re-enabled control included) while a released one frees
  // keyboard input again. A release off the element mid-drag is a
  // cancel.
  useEffect(() => {
    const release = (event: PointerEvent) => {
      deadPointers.current.delete(event.pointerId);
      if (event.pointerId === activePointer.current) {
        activePointer.current = null;
        clearDrag();
      }
    };
    // Capture phase so it runs before the control's own down
    // handler: a pointerdown on a tombstoned id — anywhere in the
    // page — means that id's release never reached the document
    // (a stopped propagation mid-bubble) and the browser recycled
    // it for a fresh gesture. Draining here keeps the tombstone
    // from swallowing the new gesture's release or gating
    // keyboard input until the id happens to be reused.
    const down = (event: PointerEvent) => {
      deadPointers.current.delete(event.pointerId);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
    };
  }, []);
  // A disable landing mid-drag kills the gesture (pointerup can
  // never arrive on a disabled input) — drain the pointer as dead
  // and restore the real fill.
  useEffect(() => {
    if (!enabled && pointerPhase.current === 'drag') {
      killDrag();
    }
  }, [enabled]);
  // The hold belongs to the track it was committed on — a track
  // change renders `positionMs` below regardless, but clear the
  // state + settle timer rather than let them die on the clock.
  useEffect(() => {
    if (heldMs !== null && heldKey.current !== trackKey) {
      releaseHold();
    }
  }, [trackKey, heldMs]);
  // A track change mid-drag kills the gesture entirely: the
  // preview belongs to a track no longer playing, a release must
  // never seek it, and the still-pressed pointer drains as dead —
  // `onScrubEnd` double-checks the key since a release can land
  // before this effect.
  useEffect(() => {
    if (
      pointerPhase.current === 'drag' &&
      gestureKey.current !== undefined &&
      gestureKey.current !== trackKey
    ) {
      killDrag();
    }
  }, [trackKey]);

  const onScrubStart = useCallback(
    (pointerId: number) => {
      if (!enabled) {
        return;
      }
      deadPointers.current.delete(pointerId);
      if (
        pointerPhase.current === 'drag' &&
        activePointer.current !== pointerId
      ) {
        // A second contact never takes over a live drag — mark it
        // dead so its release drains instead of committing
        // mid-gesture, and so a still-held second finger can't
        // commit per `input` event after the owner releases.
        deadPointers.current.add(pointerId);
        return;
      }
      pointerPhase.current = 'drag';
      activePointer.current = pointerId;
      scrubRef.current = null;
      gestureKey.current = trackKeyRef.current;
    },
    [enabled],
  );
  const onScrubValue = useCallback(
    (ms: number) => {
      if (pointerPhase.current === 'drag') {
        scrubRef.current = ms;
        setScrubMs(ms);
      } else if (deadPointers.current.size === 0 && enabled) {
        // No pointer gesture live or dead in flight — keyboard
        // Home/End and AT commits seek immediately, as before. A
        // held dead pointer's inputs are ignored until release.
        commit(ms);
      }
    },
    [commit, enabled],
  );
  const onScrubEnd = useCallback(
    (commitMs: number | null, pointerId: number) => {
      if (deadPointers.current.delete(pointerId)) {
        return; // a dead pointer's release — drained, seeks nothing
      }
      if (pointerId !== activePointer.current) {
        return; // a pointer this control never tracked
      }
      activePointer.current = null;
      // Abandoned gestures — a cancelled pointer or a track change
      // since pointer-down — restore the real fill. The key check
      // matters: releasing on a new track must not seek it to a
      // position the preview only ever showed on the old one.
      if (
        commitMs === null ||
        (gestureKey.current !== undefined &&
          gestureKey.current !== trackKeyRef.current)
      ) {
        clearDrag();
        return;
      }
      commit(scrubRef.current ?? commitMs);
    },
    [commit],
  );
  const shownHeld =
    heldMs !== null && heldKey.current === trackKey ? heldMs : null;
  const shownScrub =
    scrubMs !== null &&
    pointerPhase.current === 'drag' &&
    gestureKey.current === trackKey
      ? scrubMs
      : null;
  // Keyboard and AT steps go through `commit` so the hold tracks
  // them — stepping off `shownMs` while a seek publish is pending
  // must still move the hold forward, or the next arrow replays
  // the same step.
  const onScrubKey = useCallback(
    (key: string): boolean => {
      if (
        !enabled ||
        durationMs === null ||
        pointerPhase.current === 'drag' ||
        deadPointers.current.size > 0
      ) {
        return false;
      }
      const stepped = seekStepMs(key, shownHeld ?? positionMs, durationMs);
      if (stepped === null) {
        return false;
      }
      commit(stepped);
      return true;
    },
    [commit, durationMs, enabled, positionMs, shownHeld],
  );
  return {
    enabled,
    shownMs: shownScrub ?? shownHeld ?? positionMs,
    onScrubStart,
    onScrubValue,
    onScrubEnd,
    onScrubKey,
  };
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
    const up = waveformBarExtent(peak?.up ?? 0, WAVE_MAX_EXTENT, WAVE_MIN_EXTENT, 1);
    const down = waveformBarExtent(peak?.down ?? 0, WAVE_MAX_EXTENT, WAVE_MIN_EXTENT, 1);
    const x = (xs[i] ?? 0).toFixed(2);
    d += `M${x} ${(WAVE_MID - up).toFixed(2)} L${x} ${(WAVE_MID + down).toFixed(2)}`;
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
  const pick = (g: readonly number[]) =>
    barsPathD(
      g.map((i) => xs[i] ?? 0),
      g.map((i) => peaks[i] ?? { up: 0, down: 0 }),
    );
  return [pick(groups[0]), pick(groups[1]), pick(groups[2])];
}

export type WaveformSeekProps = {
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly onSeek?:
    | ((ms: number, expectedOccurrenceId?: string) => void)
    | undefined;
  /** Identity of the track on the player — scopes the optimistic
   *  hold so a track change never displays the previous track's
   *  committed position. */
  readonly trackKey?: string | null | undefined;
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
  trackKey,
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
  const scrub = useScrubCommit(positionMs, durationMs, onSeek, trackKey);
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
  const { enabled, shownMs } = scrub;
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
    if (scrub.onScrubKey(event.key)) {
      event.preventDefault();
    }
  };
  const scrubHandlers = enabled
    ? {
        onPointerDown: (event: ReactPointerEvent<HTMLInputElement>) =>
          scrub.onScrubStart(event.pointerId),
        onPointerUp: (event: ReactPointerEvent<HTMLInputElement>) =>
          scrub.onScrubEnd(
            Number(event.currentTarget.value),
            event.pointerId,
          ),
        onPointerCancel: (event: ReactPointerEvent<HTMLInputElement>) =>
          scrub.onScrubEnd(null, event.pointerId),
        onLostPointerCapture: (event: ReactPointerEvent<HTMLInputElement>) =>
          scrub.onScrubEnd(null, event.pointerId),
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          scrub.onScrubValue(Number(event.currentTarget.value)),
      }
    : {};
  const preview = hover ?? p;
  const bandStart = Math.min(p, preview);
  const bandEnd = Math.max(p, preview);
  // Forward preview tints unplayed bars with accent; backward preview
  // dims the played span that would be given back.
  const bandBackward = preview < p;
  const wavePath = (d: string, stroke: string, opacity?: number, key?: number) => (
    <path
      key={key}
      d={d}
      stroke={stroke}
      strokeWidth={WAVE_BAR_WIDTH}
      strokeLinecap="round"
      fill="none"
      opacity={opacity}
    />
  );
  const minibar = (x: number, i: number, fill?: string) => (
    <rect
      key={i}
      x={x - WAVE_BAR_WIDTH / 2}
      y={WAVE_MID - WAVE_MIN_EXTENT}
      width={WAVE_BAR_WIDTH}
      height={WAVE_MIN_EXTENT * 2}
      rx={1.5}
      fill={fill}
    />
  );
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
            {layout.xs.map((x, i) => minibar(x, i, 'var(--fg18)'))}
            <clipPath id={`bars-${uid}`}>
              {layout.xs.map((x, i) => minibar(x, i))}
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
            {([[dLow, 0.6], [dMid, 0.8], [dHigh, 1]] as const).map(
              ([d, opacity]) => wavePath(d, 'var(--fg18)', opacity, opacity),
            )}
            <g clipPath={`url(#played-${uid})`}>
              {wavePath(dAll, 'var(--accent)')}
            </g>
            {hover !== null && (
              <g clipPath={`url(#hover-${uid})`}>
                {wavePath(
                  dAll,
                  bandBackward ? 'var(--bg)' : 'var(--accent)',
                  bandBackward ? 0.45 : 0.55,
                )}
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
        {...scrubHandlers}
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
