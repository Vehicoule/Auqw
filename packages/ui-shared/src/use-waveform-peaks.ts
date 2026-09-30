import { useEffect, useMemo, useState } from 'react';
import { createClock, createPeaksTracker } from '@auqw/application';
import type { PeaksPort, PeaksTarget, WaveformPeak } from '@auqw/application';

export type { PeaksTarget } from '@auqw/application';

/**
 * Real waveform peaks for the currently playing recording — lazily
 * extracted on track change, cached per attempt (`recordingId|attemptId`
 * — a re-prepared stream never inherits the attempt it replaced), a
 * `null` entry marks a settled failure so the placeholder baseline
 * sticks without re-pulling on every render, and a small LRU bounds
 * memory. A cancelled extraction never caches — revisiting the
 * track retries. Returns `null` while pending or on failure — the
 * renderer falls back to `waveformPlaceholder`. The lifecycle itself
 * lives in `@auqw/application`'s `peaks-tracker.ts`; this hook only
 * bridges it to React.
 */
export function useWaveformPeaks(
  port: PeaksPort | null,
  target: PeaksTarget | null,
): readonly WaveformPeak[] | null {
  const [, setTick] = useState(0);
  const tracker = useMemo(
    () =>
      port === null
        ? null
        : createPeaksTracker({
            port,
            clock: createClock(),
            onChange: () => setTick((tick) => tick + 1),
          }),
    [port],
  );

  const id = target?.id ?? null;
  const handle = target?.handle ?? null;
  const durationMs = target?.durationMs ?? null;

  // Identity lifecycle: pull on a new recording/handle, cancel on
  // change or unmount — a settled read is a no-op to cancel.
  useEffect(() => {
    if (tracker === null || id === null || handle === null) {
      return;
    }
    tracker.pull({ id, handle, durationMs });
    return () => tracker.cancel(id);
    // durationMs is read live in the refresh effect below — pulling
    // it into these deps would cancel+restart the whole byte sweep
    // mid-flight when metadata lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker, id, handle]);

  // Metadata refresh: `durationMs` arriving mid-extraction re-pulls
  // without a cancel — the tracker folds it into the live sweep.
  useEffect(() => {
    if (tracker === null || id === null || handle === null) {
      return;
    }
    tracker.pull({ id, handle, durationMs });
  }, [tracker, id, handle, durationMs]);

  if (id === null) {
    return null;
  }
  return tracker?.get(id) ?? null;
}
