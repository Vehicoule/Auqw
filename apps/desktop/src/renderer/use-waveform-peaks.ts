import { useEffect, useRef, useState } from 'react';
import { CancellationSource } from '@auqw/application';
import type { PeaksPort } from '@auqw/application';

/** What the hook needs to fetch — the live playback session fields. */
export type PeaksTarget = {
  readonly recordingId: string;
  readonly handle: string;
  readonly durationMs: number | null;
};

/** Canonical 256-float rows are tiny; a dozen tracks is plenty of recency. */
const PEAK_CACHE_LIMIT = 12;
const PEAK_DEADLINE_MS = 30_000;
/**
 * A transient abort (bytes not yet buffered, a stalled fill, a dead
 * handle about to be re-prepared) retries on a delay — each pull is a
 * handful of IPC reads, cheap to re-attempt a few times before the
 * seeded pattern settles.
 */
const PEAK_RETRY_LIMIT = 3;
const PEAK_RETRY_DELAY_MS = 4_000;

/**
 * Real waveform peaks for the currently playing recording — lazily
 * extracted on track change, cached per recordingId (a `null` entry
 * marks a settled failure so the seeded pattern sticks without
 * re-pulling on every render), and bounded by a small LRU. A
 * cancelled extraction never caches — revisiting the track retries.
 * Returns `null` while pending or on failure — the renderer falls
 * back to the seeded pattern.
 */
export function useWaveformPeaks(
  port: PeaksPort | null,
  target: PeaksTarget | null,
): readonly number[] | null {
  const cacheRef = useRef<Map<string, readonly number[] | null> | null>(null);
  const inflightRef = useRef<Map<string, CancellationSource> | null>(null);
  const [, setTick] = useState(0);

  const recordingId = target?.recordingId ?? null;
  const handle = target?.handle ?? null;
  const durationMs = target?.durationMs ?? null;

  useEffect(() => {
    if (port === null || recordingId === null || handle === null) {
      return;
    }
    const cache = (cacheRef.current ??= new Map());
    if (cache.has(recordingId)) {
      return;
    }
    const inflight = (inflightRef.current ??= new Map());
    if (inflight.has(recordingId)) {
      return;
    }
    const source = new CancellationSource();
    inflight.set(recordingId, source);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = (n: number): void => {
      void port
        .peaks(
          { handle, durationMs },
          {
            requestId: `peaks-${recordingId}-${n}`,
            deadlineMs: Date.now() + PEAK_DEADLINE_MS,
            signal: source.signal,
          },
        )
        .then((result) => {
          if (result.ok) {
            cache.set(recordingId, result.value);
          } else if (
            result.error.kind === 'budget-exceeded' ||
            result.error.kind === 'invalid-response'
          ) {
            // Terminal failures cache `null` — seeded bars stick and
            // the same recording never re-pulls on revisit.
            cache.set(recordingId, null);
          }
          while (cache.size > PEAK_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) {
              break;
            }
            cache.delete(oldest);
          }
          if (result.ok || result.error.kind !== 'cancelled') {
            setTick((tick) => tick + 1);
          }
          const transient =
            !result.ok &&
            result.error.kind !== 'cancelled' &&
            result.error.kind !== 'budget-exceeded' &&
            result.error.kind !== 'invalid-response';
          if (transient && n < PEAK_RETRY_LIMIT) {
            timer = setTimeout(() => {
              if (!source.signal.cancelled) {
                attempt(n + 1);
              }
            }, PEAK_RETRY_DELAY_MS);
            return;
          }
          if (inflight.get(recordingId) === source) {
            inflight.delete(recordingId);
          }
        });
    };
    attempt(1);
    // Effect cleanup cancels the in-flight pull when the track or its
    // handle changes underneath it, or on unmount — a settled read is
    // a no-op to cancel.
    return () => {
      source.cancel();
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (inflight.get(recordingId) === source) {
        inflight.delete(recordingId);
      }
    };
  }, [port, recordingId, handle, durationMs]);

  if (recordingId === null) {
    return null;
  }
  return cacheRef.current?.get(recordingId) ?? null;
}
