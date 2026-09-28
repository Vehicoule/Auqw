import { appError, err, ok } from '../errors.ts';
import type { Result } from '../errors.ts';
import type { CancellationSignal } from '../cancellation.ts';
import { isSyncDelta } from './sync-engine.ts';
import type { SyncCursor, SyncDelta } from './sync-engine.ts';
import { MAX_SYNC_DOC_BYTES, utf8ByteLength } from './sync-wire.ts';

/**
 * Clipboard delta exchange (settings sync panel): the journal's paged
 * `exportDelta` folded into one transferable document list, and the
 * inverse — a pasted clipboard payload back into validated docs.
 *
 * Both apps ship the same wire shape: one `SyncDelta`, or a JSON array
 * of them when the export needed more than one page. Each page is
 * itself a valid delta so a single-doc paste applies verbatim; the
 * importer folds the array in order.
 *
 * `collectSyncDeltaDocs` walks `more`-paged exports with a coverage
 * cursor: exported entry seqs AND the exporter's known-absent
 * `skipped` claims both advance the watermark — a page that moved
 * nothing but shipped `more: true` terminates rather than spin.
 */

/**
 * One clipboard doc never exceeds the wire's delta envelope — the
 * same cap the sync IPC contract applies per doc.
 */
export const MAX_SYNC_DELTA_DOC_BYTES = MAX_SYNC_DOC_BYTES;
/**
 * Bound on the clipboard text and on a collected batch's serialized
 * size — multi-page arrays can legitimately run past a single doc's
 * 1 MiB; 16 MiB covers ~16 full pages. Loose for JSON.parse (chars
 * are UTF-16 code units) but exact for the export side (utf8 bytes).
 */
export const MAX_SYNC_DELTA_TEXT_CHARS = 16 * 1_048_576;

/** Entry bound a fitted export starts from — the engine's wire cap. */
const MAX_EXPORT_PAGE = 10_000;

function docBytes(doc: SyncDelta): number | null {
  try {
    return utf8ByteLength(JSON.stringify(doc));
  } catch {
    return null;
  }
}

/**
 * Byte-bounded `exportDelta` for the clipboard path: the engine
 * pages by entry count but a doc caps serialized bytes, so refit by
 * halving the entry limit until the page ships — erroring only when
 * a single entry can't fit. The same refit the sync client's
 * `exportFittedPage` and the desktop IPC adapter already run;
 * `more` stays honest because the engine sets it against the
 * applied limit.
 */
export async function exportFittedDeltaDoc(
  exportDelta: (
    since: SyncCursor | undefined,
    limit: number,
    signal: CancellationSignal,
  ) => Promise<Result<SyncDelta>>,
  cursor: SyncCursor,
  signal: CancellationSignal,
): Promise<Result<SyncDelta>> {
  let limit = MAX_EXPORT_PAGE;
  for (;;) {
    const delta = await exportDelta(cursor, limit, signal);
    if (!delta.ok) {
      return delta;
    }
    const bytes = docBytes(delta.value);
    if (bytes !== null && bytes <= MAX_SYNC_DELTA_DOC_BYTES) {
      return delta;
    }
    if (limit === 1) {
      return err(
        appError(
          'invalid-response',
          'single sync entry exceeds the wire bound',
        ),
      );
    }
    limit = Math.max(1, Math.floor(limit / 2));
  }
}

export async function collectSyncDeltaDocs(
  page: (cursor: SyncCursor) => Promise<Result<SyncDelta>>,
): Promise<Result<readonly SyncDelta[]>> {
  const docs: SyncDelta[] = [];
  const covered: Record<string, number> = {};
  let totalBytes = 0;
  for (; ;) {
    // Snapshot per page — the map keeps mutating as coverage advances,
    // and an async exporter must never read it mid-mutation.
    const res = await page({ ...covered });
    if (!res.ok) {
      return res;
    }
    const doc = res.value;
    const bytes = docBytes(doc);
    if (bytes === null || bytes > MAX_SYNC_DELTA_DOC_BYTES) {
      // An exporter shipping an uncapped doc would strand the importer
      // — the wire contract rejects it, so stop instead of copying.
      return err(
        appError('invalid-response', 'sync delta doc exceeds envelope cap'),
      );
    }
    docs.push(doc);
    totalBytes += bytes;
    // Budget the payload as it serializes, not just the docs: a lone
    // doc ships bare while an array adds brackets + a comma per join
    // — accepting on doc bytes alone could mint a payload
    // `parseSyncDeltaDocs` refuses on arrival.
    const framing = docs.length > 1 ? docs.length + 1 : 0;
    if (totalBytes + framing > MAX_SYNC_DELTA_TEXT_CHARS) {
      // The batch outgrew what the parse side accepts — an honest
      // stop beats shipping a payload no peer can import.
      return err(
        appError('budget-exceeded', 'sync delta export exceeds batch cap'),
      );
    }
    let advanced = false;
    for (const entry of doc.entries) {
      if (typeof entry.seq !== 'number' || entry.seq < 0) {
        // A malformed seq can't advance coverage — stop rather than
        // mint a cursor that silently re-ships or stalls forever.
        return err(
          appError('invalid-response', 'sync delta entry seq malformed'),
        );
      }
      if (entry.seq > (covered[entry.deviceId] ?? -1)) {
        covered[entry.deviceId] = entry.seq;
        advanced = true;
      }
    }
    for (const [deviceId, seqs] of Object.entries(doc.skipped)) {
      for (const seq of seqs) {
        if (seq > (covered[deviceId] ?? -1)) {
          covered[deviceId] = seq;
          advanced = true;
        }
      }
    }
    if (!doc.more || !advanced) {
      break;
    }
  }
  return ok(docs);
}

/** `JSON.stringify` of the transferable payload: one doc or the array. */
export function serializeSyncDeltaDocs(
  docs: readonly SyncDelta[],
): string {
  return JSON.stringify(docs.length === 1 ? docs[0] : docs);
}

/**
 * Parse a clipboard payload into the doc list. Validation is the same
 * on both ends of the exchange: envelope `isSyncDelta` plus the wire's
 * per-doc byte cap, checked BEFORE any apply so a malformed element
 * can't strand a half-imported array.
 */
export function parseSyncDeltaDocs(
  text: string,
): readonly SyncDelta[] | null {
  if (text.length === 0 || text.length > MAX_SYNC_DELTA_TEXT_CHARS) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const docs: readonly unknown[] = Array.isArray(parsed)
    ? parsed
    : [parsed];
  if (docs.length === 0) {
    return null;
  }
  for (const doc of docs) {
    if (!isSyncDelta(doc)) {
      return null;
    }
    const bytes = docBytes(doc);
    if (bytes === null || bytes > MAX_SYNC_DELTA_DOC_BYTES) {
      return null;
    }
  }
  return docs as readonly SyncDelta[];
}
