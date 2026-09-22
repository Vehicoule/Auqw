import type { StreamPortLike } from '../shared/contract.ts';
import {
  isPumpServerMessage,
  type PumpData,
} from '../shared/pump-protocol.ts';
import {
  boundaryScan,
  carve,
  resyncScan,
  type WebmCue,
} from './containers.ts';

/**
 * The renderer's MSE stream source — the primary desktop playback path.
 * Bytes ride a brokered MessagePort from the utility pump; this loop
 * carves them into container-aligned media segments (webm Cluster /
 * mp4 moof boundaries via `containers.ts`) and feeds a SourceBuffer.
 *
 * Seek indexing: a byte↔media journal is recorded from `buffered`
 * deltas after each append, plus the webm Cues index once the element
 * is ingested. Uncovered seeks fall back to a bitrate estimate and a
 * boundary resync scan. `QuotaExceededError` evicts buffered media
 * outside the play window, then retries once.
 */

export type TimeRangesLike = {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
};

export type SourceBufferLike = {
  readonly updating: boolean;
  readonly buffered: TimeRangesLike;
  appendBuffer(data: Uint8Array): void;
  remove(start: number, end: number): void;
  addEventListener(type: string, listener: () => void): void;
};

export type MediaSourceLike = {
  readonly readyState: string;
  duration: number;
  addSourceBuffer(mime: string): SourceBufferLike;
  endOfStream(): void;
  addEventListener(type: string, listener: () => void): void;
};

export type MseFactories = {
  readonly isTypeSupported?: (mime: string) => boolean;
  readonly createSource: () => MediaSourceLike;
  readonly createObjectURL: (source: unknown) => string;
  readonly revokeObjectURL: (url: string) => void;
};

/** Rejects `attach` with this name → caller takes the serve-url path. */
export class MseUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MseUnsupported';
  }
}

export interface MseSource {
  readonly url: string;
  seekTo(positionMs: number): void;
  /**
   * The element's playback position — quota eviction keeps a window
   * around the playhead. Without it a download that outruns playback
   * would evict the media about to play.
   */
  notePosition(positionMs: number): void;
  /**
   * Terminal failure after the attach resolved — pump or SourceBuffer
   * death. The element keeps the (dead) blob URL with no error event of
   * its own, so the player uses this to mark the attempt failed instead
   * of buffering forever.
   */
  onFail(listener: (error: Error) => void): void;
  destroy(): void;
}

/**
 * The attach outcome splits URL creation from readiness: `url` must be
 * assigned to the element for `sourceopen` to fire at all, so waiting
 * on first-append readiness before returning it deadlocks the caller.
 * `ready` settles once a segment actually lands (or rejects on
 * MseUnsupported/pump failure → caller takes the loopback leg).
 */
export interface MseAttach {
  readonly url: string;
  readonly ready: Promise<MseSource>;
  /**
   * Abandon the attach before its URL reaches an element: closes the
   * pump/port and revokes the object URL, and leaves `ready` unsettled
   * — callers on a stale op must not let it fall through to the
   * serve-url arm and mint a stream for a dead playback.
   */
  abort(): void;
}

type JournalEntry = {
  byteStart: number;
  byteEnd: number;
  mediaStart: number;
  mediaEnd: number;
};

type PendingUnit = { readonly byteStart: number; readonly bytes: Uint8Array };

/**
 * `[start, end)` minus the `before` coverage — the media interval an
 * append actually added. `before` is sorted (TimeRanges are by
 * construction); disjoint pieces come back in order.
 */
function uncovered(
  start: number,
  end: number,
  before: ReadonlyArray<readonly [number, number]>,
): Array<readonly [number, number]> {
  const pieces: Array<readonly [number, number]> = [];
  let cursor = start;
  for (const [bs, be] of before) {
    if (be <= cursor || bs >= end) {
      continue;
    }
    if (bs > cursor) {
      pieces.push([cursor, Math.min(bs, end)]);
    }
    cursor = Math.max(cursor, be);
    if (cursor >= end) {
      break;
    }
  }
  if (cursor < end) {
    pieces.push([cursor, end]);
  }
  return pieces;
}

/**
 * Outstanding-byte ceiling the renderer tops the pump's credit up to:
 * pending (emitted, unappended) + in-flight granted bytes. The still-open
 * unit in ingest is exempt — its terminating boundary is upstream, so
 * counting it deadlocks any segment bigger than the window (it is
 * bounded separately by MAX_UNIT_BYTES).
 */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** Buffered-media window kept across evictions (seconds). */
const KEEP_BEHIND_S = 120;
const KEEP_AHEAD_S = 300;
/** A head that still can't classify after this many bytes is refused. */
const SNIFF_LIMIT = 4 * 1024 * 1024;
/** Resync scan window after an estimated seek. */
const RESYNC_LIMIT = 2 * 1024 * 1024;
/** One media segment's byte cap — past this the unit can't complete and
 * the stream is refused. The credit window excludes the open unit, so
 * a segment up to this size still flows; anything larger is not a
 * shape this path can append. (Matches resyncScan's moof sanity bound.) */
const MAX_UNIT_BYTES = 64 * 1024 * 1024;

export function attachMseSource(deps: {
  readonly handle: string;
  readonly mime: string;
  readonly channel: (args: { handle: string }) => Promise<StreamPortLike>;
  readonly mse: MseFactories;
}): Promise<MseAttach> {
  if (
    deps.mse.isTypeSupported !== undefined &&
    !deps.mse.isTypeSupported(deps.mime)
  ) {
    return Promise.reject(
      new MseUnsupported(`mime not MSE-decodable: ${deps.mime}`),
    );
  }
  const media = deps.mse.createSource();
  const url = deps.mse.createObjectURL(media);
  let revoked = false;
  let sessionDestroy: (() => void) | null = null;
  const revoke = (): void => {
    if (!revoked) {
      revoked = true;
      deps.mse.revokeObjectURL(url);
    }
  };
  const abort = (): void => {
    sessionDestroy?.();
    revoke();
  };
  return deps
    .channel({ handle: deps.handle })
    .then((port) => {
      const ready = new Promise<MseSource>((resolve, reject) => {
        sessionDestroy = runSession(
          deps.mime,
          deps.mse,
          media,
          url,
          port,
          resolve,
          reject,
          revoke,
        );
      });
      // A failed session revokes the object URL itself via destroy();
      // this catch keeps `ready` handled for callers that ignore it.
      ready.catch(() => revoke());
      return { url, ready, abort };
    })
    .catch((thrown: unknown) => {
      revoke();
      throw thrown;
    });
}

function runSession(
  mime: string,
  mse: MseFactories,
  media: MediaSourceLike,
  url: string,
  port: StreamPortLike,
  resolve: (source: MseSource) => void,
  reject: (error: Error) => void,
  revoke: () => void,
): () => void {
  let buffer: SourceBufferLike | null = null;
  let ingest = new Uint8Array(0);
  let ingestBase = 0;
  let emitCursor = 0;
  const pending: PendingUnit[] = [];
  let journal: JournalEntry[] = [];
  let cues: readonly WebmCue[] = [];
  let container: 'webm' | 'mp4' | null = null;
  let segDataStart = 0;
  let scaleMs = 1;
  let epoch = 0;
  let eof = false;
  let ended = false;
  let destroyed = false;
  let resync = false;
  let lastAppended: PendingUnit | null = null;
  let resolved = false;
  // Granted-but-undelivered bytes — the pump may still send this much
  // under the current epoch, so it counts against the window or grants
  // accumulate past the ceiling. The pump zeroes its credit on seek;
  // the counter mirrors that (see `seek`).
  let outstandingCredit = 0;
  /** Re-grant whatever head-room the byte window freed — consumed
   * ingest drops off the window at trimIngest, so a unit larger than
   * the initial grant still pulls bytes until it closes. */
  function maybeGrant(): void {
    if (destroyed || eof) {
      return;
    }
    let pendingBytes = 0;
    for (const unit of pending) {
      pendingBytes += unit.bytes.byteLength;
    }
    // The ingest tail is the OPEN unit — its bytes can't release the
    // window until its terminating boundary arrives upstream, so
    // counting them deadlocks any segment bigger than the window. Only
    // emitted (pending) and in-flight (credit) work counts; the open
    // unit is bounded separately by MAX_UNIT_BYTES.
    const head =
      HIGH_WATER_BYTES - pendingBytes - outstandingCredit;
    if (head > 0) {
      outstandingCredit += head;
      port.send({ kind: 'grant', bytes: head });
    }
  }

  const failListeners: Array<(error: Error) => void> = [];
  let terminalError: Error | null = null;

  function fail(error: Error): void {
    if (!resolved) {
      destroy();
      reject(error);
      return;
    }
    destroy();
    terminalError = error;
    for (const listener of failListeners) {
      listener(error);
    }
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    try {
      port.send({ kind: 'close' });
      port.close();
    } catch {
      // The pump port may already be dead — close is best-effort.
    }
    revoke();
  }

  function sniffContainer(): 'webm' | 'mp4' | null {
    const result = carve(ingest);
    if (result.kind === 'unsupported') {
      return null;
    }
    return result.kind === 'ok' ? result.container : null;
  }

  function enqueue(startOff: number, endOff: number): void {
    if (endOff <= startOff) {
      return;
    }
    pending.push({
      byteStart: ingestBase + startOff,
      bytes: ingest.slice(startOff, endOff),
    });
  }

  /**
   * Drop consumed bytes off the ingest head once the emit cursor has
   * moved past them — keeps the buffer O(window), not O(filesize).
   */
  function trimIngest(): void {
    const consumed = emitCursor - ingestBase;
    if (consumed > 0 && consumed <= ingest.length) {
      ingest = ingest.slice(consumed);
      ingestBase += consumed;
    }
  }

  function flush(atEof: boolean): void {
    if (destroyed) {
      return;
    }
    if (resync) {
      if (container === null) {
        const found = sniffContainer();
        if (found === null) {
          if (ingest.length > SNIFF_LIMIT || atEof) {
            fail(new MseUnsupported('unrecognised stream head'));
          }
          return;
        }
        container = found;
      }
      const off = resyncScan(ingest, container);
      if (off < 0) {
        if (ingest.length > RESYNC_LIMIT || atEof) {
          fail(
            new MseUnsupported(
              'no segment boundary in resync window',
            ),
          );
        }
        return;
      }
      ingest = ingest.slice(off);
      ingestBase += off;
      emitCursor = ingestBase;
      resync = false;
    }
    if (container === null) {
      const result = carve(ingest);
      if (result.kind === 'unsupported') {
        fail(
          new MseUnsupported(
            'container has no media segments to append (non-fragmented)',
          ),
        );
        return;
      }
      if (result.kind === 'need-more') {
        if (ingest.length > SNIFF_LIMIT || atEof) {
          fail(new MseUnsupported('unrecognised stream head'));
        }
        return;
      }
      container = result.container;
      segDataStart = result.segDataStart;
      scaleMs = result.scaleMs;
      emitCursor = ingestBase;
      if (result.cues.length > 0) {
        cues = result.cues;
      }
    }
    // Steady state: the ingest head is a segment boundary by
    // construction (emitCursor only lands on one) — scan siblings, not
    // the file-head parser, or mid-stream data would misclassify.
    const scan = boundaryScan(ingest, container, segDataStart, scaleMs);
    if (scan.cues.length > 0) {
      cues = scan.cues;
    }
    // Emit units: [cursor .. nextBoundary) for each boundary ahead of
    // the cursor; the trailing open unit closes only at EOF. The cap
    // applies to emitted units too — a segment that closes at 65MiB is
    // just as unappendable as one still open at 64.
    for (const b of scan.boundaries) {
      const end = Math.min(b, ingest.length);
      if (ingestBase + b <= emitCursor) {
        continue;
      }
      if (end - (emitCursor - ingestBase) > MAX_UNIT_BYTES) {
        fail(
          new MseUnsupported(
            `media segment exceeds ${MAX_UNIT_BYTES} bytes`,
          ),
        );
        return;
      }
      enqueue(emitCursor - ingestBase, end);
      emitCursor = ingestBase + end;
    }
    if (atEof && emitCursor - ingestBase < ingest.length) {
      if (ingest.length - (emitCursor - ingestBase) > MAX_UNIT_BYTES) {
        fail(
          new MseUnsupported(
            `media segment exceeds ${MAX_UNIT_BYTES} bytes`,
          ),
        );
        return;
      }
      enqueue(emitCursor - ingestBase, ingest.length);
      emitCursor = ingestBase + ingest.length;
    }
    trimIngest();
    // The still-open tail is exempt from the credit window but not
    // unbounded — a segment past the cap is one this path can't append.
    if (ingest.length > MAX_UNIT_BYTES) {
      fail(
        new MseUnsupported(
          `media segment exceeds ${MAX_UNIT_BYTES} bytes`,
        ),
      );
      return;
    }
    drain();
    // Consumed ingest frees window even mid-open-unit — without this a
    // segment bigger than the initial grant could never close (its next
    // boundary can't arrive until more bytes do).
    maybeGrant();
  }

  function isQuotaError(thrown: unknown): boolean {
    return (
      thrown instanceof Error &&
      thrown.name === 'QuotaExceededError'
    );
  }

  // Eviction is itself an asynchronous SourceBuffer operation — remove()
  // sets `updating` until its own updateend, so appends and further
  // removes must wait behind it. The queue drains one range at a time;
  // the final updateend hands back to `drain` for the queued retry.
  let evicting = false;
  /** Reported element position in seconds — the eviction anchor;
   * `-1` until the player reports one (pre-play attaches fall back
   * to the append frontier). */
  let playheadS = -1;
  // One eviction retry per appended unit — a later quota hit on a new
  // unit is fresh pressure worth evicting for, not a retry loop.
  let retriedUnit: PendingUnit | null = null;
  const evictQueue: Array<readonly [number, number]> = [];
  // `buffered` snapshot taken right before appendBuffer — the journal
  // pairs a unit's bytes only with the media interval it ADDED. A
  // merged range's earlier span belongs to the units that produced it;
  // crediting the whole range double-counts durations and misplaces
  // the bitrate estimate.
  let preAppendRanges: Array<readonly [number, number]> = [];

  function startEviction(): void {
    const ranges = buffer?.buffered;
    if (ranges === undefined) {
      drain();
      return;
    }
    // Anchor on the playhead — eviction protects the media the
    // element is about to play. Anchoring on the append frontier would
    // evict the playhead itself whenever the download outruns playback
    // by more than KEEP_BEHIND_S. Before a report lands, the frontier
    // stands in (a pre-play attach is all there is to keep).
    const last = journal[journal.length - 1];
    const anchorS =
      playheadS >= 0 ? playheadS : last === undefined ? 0 : last.mediaEnd / 1000;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      // Clamp to the out-of-window part — adjacent appends surface as
      // one merged range, and its stale prefix/suffix is evictable even
      // while the range as a whole overlaps the keep window.
      const behindEnd = Math.min(end, anchorS - KEEP_BEHIND_S);
      if (behindEnd > start) {
        evictQueue.push([start, behindEnd]);
      }
      const aheadStart = Math.max(start, anchorS + KEEP_AHEAD_S);
      if (end > aheadStart) {
        evictQueue.push([aheadStart, end]);
      }
    }
    // Journal entries wholly inside an evicted span lose their media;
    // straddling entries keep mapping the still-buffered coverage.
    journal = journal.filter(
      (j) =>
        !evictQueue.some(
          ([s, e]) => j.mediaStart >= s * 1000 && j.mediaEnd <= e * 1000,
        ),
    );
    evicting = true;
    removeNext();
  }

  function removeNext(): void {
    const next = evictQueue.shift();
    if (next === undefined || buffer === null) {
      evicting = false;
      drain(); // the evicted append retries here, behind the removals
      return;
    }
    try {
      buffer.remove(next[0], next[1]);
    } catch {
      // Eviction is best-effort; a refused range skips to the next.
      removeNext();
    }
  }

  function drain(): void {
    if (
      destroyed ||
      evicting ||
      buffer === null ||
      buffer.updating ||
      pending.length === 0
    ) {
      return;
    }
    const unit = pending.shift();
    if (unit === undefined) {
      return;
    }
    lastAppended = unit;
    preAppendRanges = [];
    const beforeRanges = buffer.buffered;
    for (let i = 0; i < beforeRanges.length; i++) {
      preAppendRanges.push([beforeRanges.start(i), beforeRanges.end(i)]);
    }
    try {
      buffer.appendBuffer(unit.bytes);
    } catch (thrown) {
      if (isQuotaError(thrown) && retriedUnit !== unit) {
        retriedUnit = unit;
        pending.unshift(unit);
        lastAppended = null;
        startEviction();
        return;
      }
      fail(
        thrown instanceof Error
          ? thrown
          : new Error('append failed'),
      );
    }
  }

  /**
   * Terminal bookkeeping once the pump reports EOF. `pending` drains
   * before `lastAppended`'s `updateend` fires, so an in-flight append
   * counts as occupied — checking only `pending.length` would call a
   * resolved-in-flight attach 'never landed' and reject it.
   */
  function checkEnd(): void {
    if (!eof || destroyed || pending.length > 0) {
      return;
    }
    if (buffer !== null && buffer.updating) {
      return;
    }
    if (!resolved) {
      fail(
        new MseUnsupported('stream ended before a segment landed'),
      );
      return;
    }
    if (!ended) {
      ended = true;
      try {
        media.endOfStream();
      } catch {
        // Detached sources throw — terminal either way.
      }
    }
  }

  function onAppended(): void {
    if (destroyed) {
      return;
    }
    if (evicting) {
      // A removal's updateend, not an append's — continue the eviction
      // chain; append bookkeeping resumes once `drain` re-arms it.
      removeNext();
      return;
    }
    const unit = lastAppended;
    if (unit !== null && buffer !== null) {
      const ranges = buffer.buffered;
      // Pair the appended byte span with the media it ADDED —
      // the byte↔time index for seeks, independent of container Cues.
      const duplicated = journal.some(
        (j) => j.byteStart === unit.byteStart,
      );
      if (!duplicated) {
        for (let i = 0; i < ranges.length; i++) {
          for (const [s, e] of uncovered(
            ranges.start(i),
            ranges.end(i),
            preAppendRanges,
          )) {
            if (e - s < 0.001) {
              continue; // sub-millisecond rounding dust
            }
            journal.push({
              byteStart: unit.byteStart,
              byteEnd: unit.byteStart + unit.bytes.byteLength,
              mediaStart: s * 1000,
              mediaEnd: e * 1000,
            });
          }
        }
      }
    }
    if (!resolved && journal.length > 0) {
      // Resolve only once a media range exists — an init-segment append
      // produces no `buffered` range, so a stream that dies right after
      // its header still rejects and falls back instead of attaching a
      // source that will never play.
      resolved = true;
      resolve({
        url,
        seekTo: (ms) => seek(ms),
        notePosition: (ms) => {
          playheadS = ms / 1000;
        },
        onFail: (listener) => {
          // A failure that already landed fires immediately — the
          // caller subscribes a microtask after resolve at the earliest.
          if (terminalError !== null) {
            listener(terminalError);
            return;
          }
          failListeners.push(listener);
        },
        destroy,
      });
    }
    drain();
    checkEnd();
    maybeGrant(); // freed appended bytes pull the next read window
  }

  function onData(frame: PumpData): void {
    if (frame.epoch !== epoch) {
      return; // stale-epoch chunk — pump re-anchored while in flight
    }
    // Its credit is spent whether or not the bytes line up.
    outstandingCredit = Math.max(
      0,
      outstandingCredit - frame.bytes.byteLength,
    );
    const base = ingestBase + ingest.length;
    if (frame.position !== base) {
      return; // non-contiguous — dropped until the pump resyncs
    }
    const merged = new Uint8Array(ingest.length + frame.bytes.byteLength);
    merged.set(ingest, 0);
    merged.set(frame.bytes, ingest.length);
    ingest = merged;
    flush(false);
  }

  function isBuffered(seconds: number): boolean {
    const ranges = buffer?.buffered;
    if (ranges === undefined) {
      return false;
    }
    for (let i = 0; i < ranges.length; i++) {
      if (seconds >= ranges.start(i) && seconds < ranges.end(i)) {
        return true;
      }
    }
    return false;
  }

  function seek(mediaMs: number): void {
    if (destroyed) {
      return;
    }
    // Journal coverage first — bytes already appended map exactly.
    const hit = journal.find(
      (j) => mediaMs >= j.mediaStart && mediaMs < j.mediaEnd,
    );
    // A target still buffered needs no pump work — the element plays
    // it directly. Re-anchoring would refetch media the buffer already
    // holds — and past EOF the append on the ended source would fail.
    if (
      hit !== undefined &&
      buffer !== null &&
      isBuffered(mediaMs / 1000)
    ) {
      return;
    }
    let byte: number | null = hit?.byteStart ?? null;
    if (byte === null && cues.length > 0) {
      // Cues index: greatest cue at or before the target timecode.
      let best: WebmCue | null = null;
      for (const cue of cues) {
        if (
          cue.mediaMs <= mediaMs &&
          (best === null || cue.mediaMs > best.mediaMs)
        ) {
          best = cue;
        }
      }
      if (best !== null) {
        byte = best.byte;
      }
    }
    if (byte === null) {
      // Bitrate estimate from journaled coverage, then boundary resync.
      // One unit can yield several media pieces (a delta split by a
      // gap) — bytes count once per unit, media intervals are disjoint
      // by construction.
      const seenUnits = new Set<number>();
      let journaledBytes = 0;
      let journaledMs = 0;
      for (const j of journal) {
        if (!seenUnits.has(j.byteStart)) {
          seenUnits.add(j.byteStart);
          journaledBytes += j.byteEnd - j.byteStart;
        }
        journaledMs += j.mediaEnd - j.mediaStart;
      }
      if (journaledBytes === 0 || journaledMs === 0) {
        return;
      }
      byte = Math.floor((mediaMs / journaledMs) * journaledBytes);
      resync = true;
    }
    epoch += 1;
    pending.length = 0;
    ingest = new Uint8Array(0);
    ingestBase = byte;
    emitCursor = byte;
    eof = false;
    // The pump zeroes its credit on seek — granted-but-undelivered
    // bytes under the old epoch are gone on both sides.
    outstandingCredit = 0;
    port.send({ kind: 'seek', position: byte, epoch });
    maybeGrant();
  }

  media.addEventListener('sourceopen', () => {
    if (buffer !== null) {
      // An append on an ended source re-opens it — the same
      // SourceBuffer comes back (adding a second would throw), and
      // the stream may legitimately end again later.
      ended = false;
      return;
    }
    try {
      buffer = media.addSourceBuffer(mime);
    } catch {
      fail(new MseUnsupported(`SourceBuffer refused ${mime}`));
      return;
    }
    buffer.addEventListener('updateend', onAppended);
    buffer.addEventListener('error', () =>
      fail(new Error('SourceBuffer error')),
    );
    maybeGrant();
  });

  port.onMessage((raw) => {
    if (destroyed || !isPumpServerMessage(raw)) {
      return;
    }
    switch (raw.kind) {
      case 'data':
        onData(raw);
        break;
      case 'eof':
        if (raw.epoch === epoch) {
          eof = true;
          flush(true);
          checkEnd();
        }
        break;
      case 'error':
        fail(new Error(`pump ${raw.code}: ${raw.message}`));
        break;
      case 'ready':
        break;
    }
  });
  return destroy;
}
