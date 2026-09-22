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
 * Outstanding-byte ceiling the renderer tops the pump's credit up to:
 * ingest (unemitted) + pending (emitted, unappended) bytes. Granting
 * only on append completion would stall an open unit bigger than the
 * window — its next boundary can't arrive without more bytes.
 */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** Buffered-media window kept across evictions (seconds). */
const KEEP_BEHIND_S = 120;
const KEEP_AHEAD_S = 300;
/** A head that still can't classify after this many bytes is refused. */
const SNIFF_LIMIT = 4 * 1024 * 1024;
/** Resync scan window after an estimated seek. */
const RESYNC_LIMIT = 2 * 1024 * 1024;

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
    const head =
      HIGH_WATER_BYTES -
      ingest.length -
      pendingBytes -
      outstandingCredit;
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
    // the cursor; the trailing open unit closes only at EOF.
    for (const b of scan.boundaries) {
      const end = Math.min(b, ingest.length);
      if (ingestBase + b <= emitCursor) {
        continue;
      }
      enqueue(emitCursor - ingestBase, end);
      emitCursor = ingestBase + end;
    }
    if (atEof && emitCursor - ingestBase < ingest.length) {
      enqueue(emitCursor - ingestBase, ingest.length);
      emitCursor = ingestBase + ingest.length;
    }
    trimIngest();
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
  // One eviction retry per appended unit — a later quota hit on a new
  // unit is fresh pressure worth evicting for, not a retry loop.
  let retriedUnit: PendingUnit | null = null;
  const evictQueue: Array<readonly [number, number]> = [];

  function startEviction(): void {
    const ranges = buffer?.buffered;
    if (ranges === undefined) {
      drain();
      return;
    }
    // Anchor on the latest appended media — eviction keeps a window
    // around the ingest head, not the element position (the player's
    // currentTime always trails the append frontier on seeks).
    const last = journal[journal.length - 1];
    const anchorS = last === undefined ? 0 : last.mediaEnd / 1000;
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
      // Pair the appended byte span with the media range it produced —
      // the byte↔time index for seeks, independent of container Cues.
      const duplicated = journal.some(
        (j) => j.byteStart === unit.byteStart,
      );
      if (!duplicated) {
        for (let i = 0; i < ranges.length; i++) {
          const start = ranges.start(i);
          const end = ranges.end(i);
          const known = journal.some(
            (j) => j.mediaStart === start * 1000 && j.mediaEnd === end * 1000,
          );
          if (!known) {
            journal.push({
              byteStart: unit.byteStart,
              byteEnd: unit.byteStart + unit.bytes.byteLength,
              mediaStart: start * 1000,
              mediaEnd: end * 1000,
            });
            break;
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

  function seek(mediaMs: number): void {
    if (destroyed) {
      return;
    }
    // Journal coverage first — bytes already appended map exactly.
    const hit = journal.find(
      (j) => mediaMs >= j.mediaStart && mediaMs < j.mediaEnd,
    );
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
      const journaledBytes = journal.reduce(
        (acc, j) => acc + (j.byteEnd - j.byteStart),
        0,
      );
      const journaledMs = journal.reduce(
        (acc, j) => acc + (j.mediaEnd - j.mediaStart),
        0,
      );
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
