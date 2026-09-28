import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { isRecord } from '../shared/check.ts';
import { isJsonValue, MAX_SYNC_DOC_BYTES } from '../shared/contract.ts';
import { shellError } from '../shared/errors.ts';

/**
 * The SpillJournal collaborator — the applied-outcome outbox the
 * renderer drains (`sync:drainApplied` → `sync:ackApplied`).
 *
 * Every successful applyDelta's 'applied' merge outcomes queue here
 * until the renderer pulls them. Durable mode (`spillPath` set —
 * always in production): outcomes append to the JSONL spill BEFORE
 * the applyDelta ack goes out (the caller awaits `record`), so an
 * acknowledged delta can never lose its projection work — same
 * durability horizon as the sync log itself. Drain PEEKS (read only);
 * `ack` consumes the served lines after the renderer confirms its
 * domain commit — crash windows collapse to at-least-once redelivery,
 * which the projector's materialized snapshots make idempotent.
 * Volatile mode (no path — tests) keeps an in-memory FIFO consumed
 * at drain, bounded drop-oldest.
 */
export interface SpillJournal {
  /** Persist an applyDelta result's applied outcomes before the ack. */
  record(result: unknown): Promise<void>;
  /** One byte-bounded pull — spill lines serve before the FIFO. */
  drain(): Promise<{
    readonly outcomes: readonly unknown[];
    readonly dropped: boolean;
    readonly remaining: number;
  }>;
  /** Consume the served file prefix after the renderer's commit. */
  ack(): Promise<void>;
  /** Settle in-flight spill IO — close() awaits it before teardown. */
  settle(): Promise<void>;
}

export function createSpillJournal(opts: {
  /** JSONL spill path — absent keeps the volatile in-memory FIFO. */
  spillPath?: string | undefined;
  /** Push hint toward the renderer; errors are swallowed. */
  notifyApplied?: ((pending: number) => unknown) | undefined;
}): SpillJournal {
  const APPLIED_OUTBOX_MAX = 4_096;
  const appliedOutbox: unknown[] = [];
  let appliedDropped = false;
  /** Serializes spill appends against drain reads and ack rewrites. */
  let spillTail: Promise<unknown> = Promise.resolve();
  /** Bytes served by the most recent drain, awaiting ack. */
  let awaitingAckBytes = 0;

  /**
   * Incremental line walk over the spill starting at `startOff` —
   * memory bounded by the page budget, not the backlog: served lines
   * stop at the budget but the walk keeps counting for `remaining`.
   * `servedBytes` is the exact byte length the ack advances the
   * durable offset by (line + its newline).
   */
  async function spillScan(
    path: string,
    startOff: number,
    budgetBytes: number,
  ): Promise<{
    readonly served: readonly string[];
    readonly servedBytes: number;
    readonly totalLines: number;
    readonly skippedLines: number;
  }> {
    const served: string[] = [];
    let servedBytes = 0;
    let totalLines = 0;
    let skippedLines = 0;
    let fits = true;
    const take = (line: string, terminated: boolean): void => {
      totalLines += 1;
      // The byte count is what the durable offset advances by — the
      // newline exists on disk only for a terminated line. Charging
      // one for the final unterminated carry would land `.off` a byte
      // past EOF and drop the next line appended.
      const lineBytes =
        Buffer.byteLength(line, 'utf8') + (terminated ? 1 : 0);
      if (fits && servedBytes + lineBytes <= budgetBytes) {
        served.push(line);
        servedBytes += lineBytes;
        return;
      }
      if (served.length === 0 && servedBytes === 0) {
        // Poison line: bigger than the whole page, so NO offset ever
        // fits it — leaving it would wedge the drain forever
        // (Review #46 round-9). Consume its bytes so the ack
        // advances past it; the dropped flag surfaces the loss and
        // the materialized reconcile rebuilds the row anyway.
        servedBytes += lineBytes;
        skippedLines += 1;
        return;
      }
      fits = false;
    };
    const stream = createReadStream(path, { start: startOff });
    stream.setEncoding('utf8');
    let carry = '';
    try {
      for await (const chunk of stream) {
        let buf = carry + (chunk as string);
        carry = '';
        for (; ;) {
          const nl = buf.indexOf('\n');
          if (nl < 0) {
            break;
          }
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            take(line, true);
          }
        }
        carry = buf;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { served: [], servedBytes: 0, totalLines: 0, skippedLines: 0 };
      }
      throw e;
    }
    if (carry.length > 0) {
      take(carry, false);
    }
    return { served, servedBytes, totalLines, skippedLines };
  }

  /** The ack sidecar: the byte offset the served prefix ends at. */
  function spillOffsetPath(path: string): string {
    return `${path}.off`;
  }

  /**
   * Durable ack position for the spill, in bytes. A sidecar past EOF
   * is stale — a crash between a compact's rename and its offset
   * reset — so rescan from 0: the compacted file already starts at
   * the old offset and re-serving is correct, not a duplicate.
   */
  async function readSpillOffset(
    offPath: string,
    path: string,
  ): Promise<number> {
    const raw = await readFile(offPath, 'utf8').catch(() => '');
    const off = Number.parseInt(raw.trim(), 10);
    if (!Number.isSafeInteger(off) || off < 0) {
      return 0;
    }
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    return off > size ? 0 : off;
  }

  /**
   * fsync a file's current contents — used before the renames that
   * commit a compaction, so a power-loss can't resurrect a torn
   * generation boundary.
   */
  async function fsyncFile(path: string): Promise<void> {
    const fh = await open(path, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /**
   * Drop the consumed prefix by streaming the rest into a fresh file
   * — bounded IO per ack: only runs once the dead prefix dominates
   * the file, so each byte is rewritten O(1) times across the
   * backlog's life instead of the whole remainder per page.
   */
  async function compactSpill(
    path: string,
    offPath: string,
    startOff: number,
  ): Promise<void> {
    // Commit the zeroed sidecar BEFORE the compacted file: the only
    // bad generation state would be `off > 0` beside the NEW layout
    // (the offset was measured against the old one and would skip
    // unserved rows — Review #46 round-8). Resetting first means a
    // crash mid-compact leaves `off = 0` + the OLD file → rescan
    // and re-serve a prefix (at-least-once, which the projection
    // tolerates), never a stale offset on the new file.
    const offTmp = `${offPath}.tmp`;
    await writeFile(offTmp, '0');
    await fsyncFile(offTmp);
    await rename(offTmp, offPath);
    const tmp = `${path}.tmp`;
    await pipeline(
      createReadStream(path, { start: startOff }),
      createWriteStream(tmp),
    );
    await fsyncFile(tmp);
    await rename(tmp, path);
  }

  function notifyApplied(pending: number): void {
    try {
      void Promise.resolve(opts.notifyApplied?.(pending)).catch(
        () => undefined,
      );
    } catch {
      // The push path is a hint — the pull drain never depends on it.
    }
  }

  function recordApplied(result: unknown): Promise<void> {
    if (!isRecord(result) || !Array.isArray(result['outcomes'])) {
      return Promise.resolve();
    }
    const collected: unknown[] = [];
    for (const outcome of result['outcomes']) {
      if (
        !isRecord(outcome) ||
        outcome['type'] !== 'applied' ||
        !isJsonValue(outcome)
      ) {
        continue;
      }
      collected.push(outcome);
    }
    if (collected.length === 0) {
      return Promise.resolve();
    }
    const path = opts.spillPath;
    if (path !== undefined) {
      const lines = `${collected.map((o) => JSON.stringify(o)).join('\n')}\n`;
      const append = spillTail.then(() => appendFile(path, lines));
      spillTail = append.then(
        () => undefined,
        () => {
          appliedDropped = true;
        },
      );
      notifyApplied(collected.length);
      return append.catch(() => {
        appliedDropped = true;
      });
    }
    for (const outcome of collected) {
      appliedOutbox.push(outcome);
      if (appliedOutbox.length > APPLIED_OUTBOX_MAX) {
        appliedOutbox.shift();
        appliedDropped = true;
      }
    }
    notifyApplied(collected.length);
    return Promise.resolve();
  }

  /**
   * Advance the durable offset: persist the new position first, then
   * compact the dead prefix once it dominates the file — linear
   * recovery, never quadratic. Shared by the renderer ack and the
   * drain's poison-skip self-advance.
   */
  async function advanceSpillOffset(
    path: string,
    offPath: string,
    newOff: number,
  ): Promise<void> {
    await writeFile(offPath, String(newOff));
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    if (newOff >= Math.max(1_048_576, size / 2)) {
      await compactSpill(path, offPath, newOff);
    }
  }

  /**
   * One byte-bounded pull: pack outcomes until the encoded payload
   * would approach `MAX_SYNC_DOC_BYTES`, leaving headroom for the
   * envelope keys. Spill lines serve before the memory queue (FIFO
   * across both). The read is a PEEK — served file lines stay on
   * disk until `ack` confirms the renderer's domain commit, so a
   * crash between serve and commit replays rather than loses (the
   * projector's snapshots keep replay idempotent). Corrupt or
   * oversized file lines count as served so the ack can drop them —
   * a poison head must not block the queue forever.
   */
  async function drainAppliedChunk(): Promise<{
    readonly outcomes: readonly unknown[];
    readonly dropped: boolean;
    readonly remaining: number;
  }> {
    const budget = MAX_SYNC_DOC_BYTES - 16_384;
    const chunk: unknown[] = [];
    let bytes = 2; // '[]'
    const sizeOf = (next: unknown): number => {
      try {
        // The contract validates the RESULT in UTF-8 bytes — string
        // length undercounts multi-byte metadata, and an over-budget
        // chunk is rejected AFTER these entries were dequeued.
        return Buffer.byteLength(JSON.stringify(next), 'utf8') + 1;
      } catch {
        return -1;
      }
    };

    const path = opts.spillPath;
    let spilledBacklog = 0;
    let servedFileBytes = 0;
    if (path !== undefined) {
      // Peek inside `spillTail` so a concurrent append or ack rewrite
      // can't interleave with the read — and scan incrementally so a
      // huge backlog can't exhaust utility memory (Review #46).
      const drainFile = spillTail.then(async () => {
        const offPath = spillOffsetPath(path);
        const off = await readSpillOffset(offPath, path);
        const scan = await spillScan(path, off, budget - bytes);
        servedFileBytes = scan.servedBytes;
        let parsedLines = 0;
        for (const line of scan.served) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (isJsonValue(parsed)) {
              bytes += Buffer.byteLength(line, 'utf8') + 1;
              chunk.push(parsed);
              parsedLines += 1;
            } else {
              appliedDropped = true;
            }
          } catch {
            // Torn tail line (killed mid-append) — count it served so
            // the ack drops it rather than poison-blocking the queue.
            appliedDropped = true;
          }
        }
        // Poison-skipped lines were consumed without being served —
        // they are neither backlog nor deliverable; the dropped flag
        // reports the loss honestly (materialized reconcile covers).
        if (scan.skippedLines > 0) {
          appliedDropped = true;
        }
        // A page that committed nothing — only poison skips, or every
        // served line unparseable — holds nothing the renderer could
        // ack, and the ack path is what advances the durable offset.
        // Advance it here, inside the serialized tail, or the same
        // lines re-scan on every later drain (Review #46 round-9).
        if (parsedLines === 0 && scan.servedBytes > 0) {
          servedFileBytes = 0;
          await advanceSpillOffset(path, offPath, off + scan.servedBytes);
        }
        spilledBacklog =
          scan.totalLines - scan.served.length - scan.skippedLines;
      });
      spillTail = drainFile.then(
        () => undefined,
        () => undefined,
      );
      await drainFile;
    }
    awaitingAckBytes = servedFileBytes;

    while (appliedOutbox.length > 0) {
      const next = appliedOutbox[0];
      const size = sizeOf(next);
      if (size < 0) {
        appliedOutbox.shift();
        appliedDropped = true;
        continue;
      }
      if (bytes + size > budget) {
        if (chunk.length === 0) {
          appliedOutbox.shift();
          appliedDropped = true;
          continue;
        }
        break;
      }
      appliedOutbox.shift();
      bytes += size;
      chunk.push(next);
    }
    const dropped = appliedDropped;
    appliedDropped = false;
    return {
      outcomes: chunk,
      dropped,
      remaining: spilledBacklog + appliedOutbox.length,
    };
  }

  /**
   * Consume the file bytes the most recent drain served — called by
   * the renderer only after its domain commit landed, so served
   * outcomes leave durable storage exactly once they're reflected
   * downstream. The ack persists a byte-offset sidecar (tiny write)
   * instead of rewriting the whole remainder; the dead prefix is
   * compacted only once it dominates the file, so recovery stays
   * linear rather than quadratic (Review #46). A failed ack must
   * REJECT, not swallow: the served prefix stays on disk either way,
   * but the renderer's drain loop stops here instead of re-fetching
   * the same page forever.
   */
  async function ackApplied(): Promise<void> {
    const path = opts.spillPath;
    const dropBytes = awaitingAckBytes;
    awaitingAckBytes = 0;
    if (path === undefined || dropBytes === 0) {
      return;
    }
    const offPath = spillOffsetPath(path);
    const rewrite = spillTail.then(async () => {
      const off = await readSpillOffset(offPath, path);
      await advanceSpillOffset(path, offPath, off + dropBytes);
    });
    spillTail = rewrite.then(
      () => undefined,
      () => undefined,
    );
    await rewrite.catch(() => {
      throw shellError(
        'io-error',
        'sync applied ack could not persist; drain stopped',
      );
    });
  }

  return {
    record: recordApplied,
    drain: drainAppliedChunk,
    ack: ackApplied,
    settle() {
      return spillTail.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
