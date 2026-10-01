import { assert, assertEqual } from '@auqw/application/testing';
import { CancellationSource } from '@auqw/application';
import type { OperationContext } from '@auqw/application';
import { PEAKS_RESOLUTION } from '@auqw/ui-shared';
import type { AuqwPeaksNative } from './auqw-expo-surface.ts';
import { createExpoPeaksPort } from './expo-peaks.ts';

function context(signal?: CancellationSource): OperationContext {
  return {
    requestId: 'peaks-test-1',
    deadlineMs: Date.now() + 30_000,
    signal: signal?.signal ?? new CancellationSource().signal,
  };
}

type Call = { method: string; args: readonly unknown[] };

type CoarseListener = (event: {
  requestId: string;
  peaks: readonly number[];
}) => void;

function fakeNative(
  result: readonly number[] | (() => Promise<readonly number[]>),
): AuqwPeaksNative & {
  calls: Call[];
  cancels: string[];
  coarseListeners: Set<CoarseListener>;
  emitCoarse(requestId: string, peaks: readonly number[]): void;
} {
  const calls: Call[] = [];
  const cancels: string[] = [];
  const coarseListeners = new Set<CoarseListener>();
  return {
    calls,
    cancels,
    coarseListeners,
    emitCoarse(requestId, peaks) {
      for (const listener of [...coarseListeners]) {
        listener({ requestId, peaks });
      }
    },
    waveformPeaks(requestId, handle, count, maxBytes, provisionalCap) {
      calls.push({
        method: 'waveformPeaks',
        args: [requestId, handle, count, maxBytes, provisionalCap],
      });
      return typeof result === 'function'
        ? result()
        : Promise.resolve(result);
    },
    waveformPeaksCancel(requestId) {
      cancels.push(requestId);
    },
    addWaveformPeaksCoarseListener(listener) {
      coarseListeners.add(listener);
      return { remove: () => coarseListeners.delete(listener) };
    },
  };
}

/** Flat `[up,down]` pairs: a loud quiet gradient so normalization
 *  lands somewhere strictly inside (0,1]. */
function flatProfile(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const arm = i % 3 === 0 ? 0.8 : 0.3 + (i % 7) * 0.05;
    out.push(arm, arm * (i % 2 === 0 ? 0.5 : 1));
  }
  return out;
}

export async function run(): Promise<void> {
  // iOS/old builds lack the seam — honest 'unavailable', seeded stays.
  {
    const port = createExpoPeaksPort({});
    const result = await port.peaks(
      { handle: 'h-1', durationMs: 120_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'unavailable');
  }

  // A known over-long track is refused before any native call —
  // the shared PEAKS_MAX_DECODE_MS gate.
  {
    const native = fakeNative([]);
    const port = createExpoPeaksPort(native);
    const result = await port.peaks(
      { handle: 'h-2', durationMs: 9 * 60_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'budget-exceeded');
    assertEqual(native.calls.length, 0, 'no decode past the gate');
  }

  // Happy path: flat pairs re-pair and normalize into asymmetric bars.
  {
    const native = fakeNative(flatProfile(PEAKS_RESOLUTION));
    const port = createExpoPeaksPort(native);
    const result = await port.peaks(
      { handle: 'h-3', durationMs: 120_000 },
      context(),
    );
    assert(result.ok, 'extraction succeeds');
    assertEqual(
      result.value.length,
      PEAKS_RESOLUTION,
      'canonical resolution round-trips',
    );
    const args = native.calls[0]?.args;
    assertEqual(args?.[2], PEAKS_RESOLUTION, 'canonical count passed down');
    assertEqual(args?.[4], false, 'known duration is not provisional');
    const first = result.value[0];
    const second = result.value[1];
    assert(
      first !== undefined && first.up !== first.down,
      'the bars carry real asymmetry — no mirroring',
    );
    assert(
      result.value.every(
        (p) => p.up >= 0 && p.up <= 1 && p.down >= 0 && p.down <= 1,
      ),
      'all pairs land inside the normalized range',
    );
    assert(second !== undefined);
  }

  // Unknown duration sends the provisional flag and the tighter cap —
  // a dense stream that size can't decode past the PCM gate anyway.
  {
    const native = fakeNative(flatProfile(4));
    const port = createExpoPeaksPort(native);
    await port.peaks({ handle: 'h-4', durationMs: null }, context());
    const args = native.calls[0]?.args;
    assertEqual(args?.[4], true, 'unknown duration is provisional');
    const cap = args?.[3];
    assert(
      typeof cap === 'number' && cap < 24 * 1024 * 1024,
      'the provisional pull is bounded below the full cap',
    );
  }

  // A coded rejection maps through the error taxonomy — a dead
  // handle stays 'released', not a raw throw.
  {
    const native = fakeNative(() =>
      Promise.reject(Object.assign(new Error('gone'), { code: 'released' })),
    );
    const port = createExpoPeaksPort(native);
    const result = await port.peaks(
      { handle: 'h-5', durationMs: 60_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'released');
  }

  // A deadline already past refuses before the native call —
  // 'timeout', the retryable kind, with zero wire surface.
  {
    const native = fakeNative(flatProfile(PEAKS_RESOLUTION));
    const port = createExpoPeaksPort(native);
    const result = await port.peaks(
      { handle: 'h-7', durationMs: 60_000 },
      {
        requestId: 'peaks-dead',
        deadlineMs: Date.now() - 1,
        signal: new CancellationSource().signal,
      },
    );
    assert(!result.ok && result.error.kind === 'timeout');
    assertEqual(native.calls.length, 0, 'an expired deadline never decodes');
  }

  // A deadline lapsing mid-sweep cancels the native job and surfaces
  // 'timeout' — not the port's 'cancelled', and never a hung decode.
  {
    const nativeCall: { reject?: (e: Error) => void } = {};
    const native = fakeNative(
      () =>
        new Promise<readonly number[]>((_resolve, reject) => {
          nativeCall.reject = reject;
        }),
    );
    const port = createExpoPeaksPort(native);
    const pending = port.peaks(
      { handle: 'h-8', durationMs: 60_000 },
      {
        requestId: 'peaks-dl',
        deadlineMs: Date.now() + 40,
        signal: new CancellationSource().signal,
      },
    );
    await new Promise((r) => setTimeout(r, 90));
    assertEqual(native.cancels[0], 'peaks-dl', 'the deadline cancels native');
    // The native side's honest reply to its cancel.
    nativeCall.reject?.(
      Object.assign(new Error('cancelled'), { code: 'cancelled' }),
    );
    const result = await pending;
    assert(!result.ok && result.error.kind === 'timeout');
  }

  // A truncated flat list is a partial decode, not a waveform —
  // 'invalid-response', never a stretched profile over the track.
  {
    const native = fakeNative(flatProfile(PEAKS_RESOLUTION / 2));
    const port = createExpoPeaksPort(native);
    const result = await port.peaks(
      { handle: 'h-9', durationMs: 60_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'invalid-response');
  }

  // Malformed magnitudes (negative / non-finite) are refused the same
  // way — the contract is finite non-negative pairs only.
  {
    const bad = flatProfile(PEAKS_RESOLUTION);
    bad[10] = -0.5;
    bad[20] = Number.NaN;
    const native = fakeNative(bad);
    const port = createExpoPeaksPort(native);
    const result = await port.peaks(
      { handle: 'h-10', durationMs: 60_000 },
      context(),
    );
    assert(!result.ok && result.error.kind === 'invalid-response');
  }

  // Genuinely silent PCM is a full-length zero profile — it passes
  // strict validation and normalizes to honest zeros.
  {
    const native = fakeNative(
      Array.from({ length: PEAKS_RESOLUTION * 2 }, () => 0),
    );
    const port = createExpoPeaksPort(native);
    const result = await port.peaks(
      { handle: 'h-11', durationMs: 60_000 },
      context(),
    );
    assert(result.ok, 'silent audio is a valid profile');
    assert(
      result.value.every((p) => p.up === 0 && p.down === 0),
      'silence normalizes to zeros',
    );
  }

  // Cancellation forwards to the native sweep and surfaces typed.
  {
    const source = new CancellationSource();
    const nativeCall: { resolve?: (v: readonly number[]) => void } = {};
    const native = fakeNative(
      () =>
        new Promise<readonly number[]>((resolve) => {
          nativeCall.resolve = resolve;
        }),
    );
    const port = createExpoPeaksPort(native);
    const pending = port.peaks(
      { handle: 'h-6', durationMs: 60_000 },
      context(source),
    );
    source.cancel();
    nativeCall.resolve?.([]);
    const result = await pending;
    assertEqual(native.cancels[0], 'peaks-test-1', 'cancel reaches native');
    assert(!result.ok && result.error.kind === 'cancelled');
  }

  // The coarse event relays a measured mid-sweep profile through
  // `onCoarse` — normalized like the final result, requestId-scoped,
  // and unsubscribed when the call settles.
  {
    const nativeCall: { resolve?: (v: readonly number[]) => void } = {};
    const native = fakeNative(
      () =>
        new Promise<readonly number[]>((resolve) => {
          nativeCall.resolve = resolve;
        }),
    );
    const port = createExpoPeaksPort(native);
    const coarse: (readonly { up: number; down: number }[] | null)[] = [];
    const pending = port.peaks(
      {
        handle: 'h-12',
        durationMs: 60_000,
        onCoarse: (peaks) => coarse.push(peaks),
      },
      context(),
    );
    // A foreign request's coarse never reaches this call's callback.
    native.emitCoarse('other-request', flatProfile(PEAKS_RESOLUTION));
    assertEqual(coarse.length, 0, 'coarse is requestId-scoped');
    // A malformed coarse is dropped, never drawn.
    native.emitCoarse('peaks-test-1', [1, 2, 3]);
    assertEqual(coarse.length, 0, 'malformed coarse is ignored');
    native.emitCoarse('peaks-test-1', flatProfile(PEAKS_RESOLUTION));
    assertEqual(coarse.length, 1, 'coarse relays once');
    assert(
      (coarse[0] ?? []).every(
        (p) => p.up >= 0 && p.up <= 1 && p.down >= 0 && p.down <= 1,
      ),
      'coarse peaks land normalized',
    );
    nativeCall.resolve?.(flatProfile(PEAKS_RESOLUTION));
    const result = await pending;
    assert(result.ok, 'final result still lands after coarse');
    assertEqual(
      native.coarseListeners.size,
      0,
      'the coarse subscription is torn down',
    );
    // A late emit after settle is a no-op — no subscription remains.
    native.emitCoarse('peaks-test-1', flatProfile(PEAKS_RESOLUTION));
    assertEqual(coarse.length, 1, 'no coarse after settle');
  }
}
