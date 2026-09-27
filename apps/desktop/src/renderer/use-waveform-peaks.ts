import { useEffect, useMemo, useState } from 'react';
import type { PeaksPort } from '@auqw/application';
import { createPeaksTracker } from './peaks-tracker.ts';
import type { PeaksTarget } from './peaks-tracker.ts';

export type { PeaksTarget } from './peaks-tracker.ts';

/**
 * Real waveform peaks for the currently playing recording — lazily
 * extracted on track change, cached per attempt (`recordingId|attemptId`
 * — a re-prepared stream never inherits the attempt it replaced), a
 * `null` entry marks a settled failure so the seeded pattern sticks
 * without re-pulling on every render, and a small LRU bounds memory.
 * A cancelled extraction never caches — revisiting the track retries.
 * Returns `null` while pending or on failure — the renderer falls
 * back to the seeded pattern. The lifecycle itself lives in
 * `peaks-tracker.ts`; this hook only bridges it to React.
 */
export function useWaveformPeaks(
  port: PeaksPort | null,
  target: PeaksTarget | null,
): readonly number[] | null {
  const [, setTick] = useState(0);
  const tracker = useMemo(
    () =>
      port === null
        ? null
        : createPeaksTracker({
            port,
            onChange: () => setTick((tick) => tick + 1),
          }),
    [port],
  );

  const id = target?.id ?? null;
  const handle = target?.handle ?? null;
  const durationMs = target?.durationMs ?? null;

  useEffect(() => {
    if (tracker === null || id === null || handle === null) {
      return;
    }
    tracker.pull({ id, handle, durationMs });
    // Cleanup abandons the pull when the track or its handle changes
    // underneath it, or on unmount — a settled read is a no-op to
    // cancel.
    return () => tracker.cancel(id);
  }, [tracker, id, handle, durationMs]);

  if (id === null) {
    return null;
  }
  return tracker?.get(id) ?? null;
}
