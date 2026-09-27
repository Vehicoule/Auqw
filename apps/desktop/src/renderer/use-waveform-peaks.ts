import { useEffect, useMemo, useState } from 'react';
import type { PeaksPort } from '@auqw/application';
import { createPeaksTracker } from './peaks-tracker.ts';
import type { PeaksTarget } from './peaks-tracker.ts';

export type { PeaksTarget } from './peaks-tracker.ts';

/**
 * Real waveform peaks for the currently playing recording — lazily
 * extracted on track change, cached per recordingId (a `null` entry
 * marks a settled failure so the seeded pattern sticks without
 * re-pulling on every render), and bounded by a small LRU. A
 * cancelled extraction never caches — revisiting the track retries.
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

  const recordingId = target?.recordingId ?? null;
  const handle = target?.handle ?? null;
  const durationMs = target?.durationMs ?? null;

  useEffect(() => {
    if (tracker === null || recordingId === null || handle === null) {
      return;
    }
    tracker.pull({ recordingId, handle, durationMs });
    // Cleanup abandons the pull when the track or its handle changes
    // underneath it, or on unmount — a settled read is a no-op to
    // cancel.
    return () => tracker.cancel(recordingId);
  }, [tracker, recordingId, handle, durationMs]);

  if (recordingId === null) {
    return null;
  }
  return tracker?.get(recordingId) ?? null;
}
