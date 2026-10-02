import type { OperationContext } from '../cancellation.ts';
import type { ClockPort } from '../ports/clock.ts';
import type { Result } from '../errors.ts';
import { appError, err, ok } from '../errors.ts';
import { isSafeNonNegative, portableArtwork } from '../domain.ts';
import type { StoragePort } from '../ports/storage.ts';
import type { ExportDocument } from './library.ts';
import { isExportDocument } from './library.ts';

/**
 * Owned-library export/import use cases.
 *
 * The document is the boundary: `exportLibrary` serializes the
 * StoragePort's owned-state snapshot; `previewImport` validates a
 * candidate file WITHOUT touching storage so the caller can show a
 * confirm screen; `applyImport` commits the validated document
 * atomically. File transport (pick/share) is the caller's job — these
 * functions move JSON text, not files.
 */

export type ExportResult = {
  /** The serialized document — write this verbatim to the file. */
  readonly json: string;
  readonly doc: ExportDocument;
};

/** Per-section row counts for the import confirm screen. */
export type ImportPreview = {
  readonly doc: ExportDocument;
  readonly exportedAtMs: number;
  readonly counts: {
    readonly recordings: number;
    readonly sourceRefs: number;
    readonly mappings: number;
    readonly likes: number;
    readonly entities: number;
    readonly entitySourceRefs: number;
    readonly playlists: number;
    readonly playlistEntries: number;
    readonly playEvents: number;
    readonly playCounts: number;
    readonly matchReviews: number;
  };
};

function invalidImport(message: string) {
  return appError('invalid-response', message);
}

/**
 * Parse and fully validate an export document's JSON text. Every
 * section shape and every cross-record reference is checked — an
 * invalid document produces a typed error and nothing else.
 */
export function parseExportJson(text: string): Result<ExportDocument> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return err(invalidImport('import document is empty'));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(invalidImport('import document is not valid JSON'));
  }
  if (!isExportDocument(parsed)) {
    return err(invalidImport('import document failed validation'));
  }
  return ok(portableDoc(parsed));
}

/**
 * Validate a candidate document and compute the confirm-screen
 * summary. Does not mutate storage — apply is a separate, explicit
 * step.
 */
export function previewImport(text: string): Result<ImportPreview> {
  const parsed = parseExportJson(text);
  if (!parsed.ok) {
    return parsed;
  }
  const doc = parsed.value;
  return ok({
    doc,
    exportedAtMs: doc.exportedAtMs,
    counts: {
      recordings: doc.recordings.length,
      sourceRefs: doc.sourceRefs.length,
      mappings: doc.mappings.length,
      likes: doc.likes.length,
      entities: doc.entities.length,
      entitySourceRefs: doc.entitySourceRefs.length,
      playlists: doc.playlists.length,
      playlistEntries: doc.playlistEntries.length,
      playEvents: doc.playHistory.length,
      playCounts: doc.playCounts.length,
      matchReviews: doc.matchReviews.length,
    },
  });
}

/** Serialize the owned library to export-document JSON text. */
export async function exportLibrary(
  storage: StoragePort,
  clock: ClockPort,
  context: OperationContext,
): Promise<Result<ExportResult>> {
  // An unguarded clock throws inside `exportOwned` or stamps a bogus
  // exportedAtMs into the document — validate before the port call.
  let nowMs: number;
  try {
    nowMs = clock.nowMs();
  } catch {
    return err(appError('internal', 'clock read failed'));
  }
  if (!isSafeNonNegative(nowMs)) {
    return err(appError('internal', 'clock returned an unsafe timestamp'));
  }
  const exported = await storage.exportOwned(nowMs, context);
  if (!exported.ok) {
    return exported;
  }
  const doc = portableDoc(exported.value);
  return ok({
    json: `${JSON.stringify(doc, null, 2)}\n`,
    doc,
  });
}

/**
 * Artwork in its portable form on both sides of the boundary:
 * device-local `file://` art-store refs (embedded covers) are stripped
 * — the receiving device re-derives them from the backing file's own
 * tags via the local-source backfill. A catalog (https) ref travels.
 */
function portableDoc(doc: ExportDocument): ExportDocument {
  return {
    ...doc,
    recordings: doc.recordings.map((r) => ({
      ...r,
      artwork: portableArtwork(r.artwork),
    })),
    entities: doc.entities.map((e) => ({
      ...e,
      artwork: portableArtwork(e.artwork),
    })),
  };
}

/**
 * Commit a validated document atomically — replaces every owned
 * section in one transaction; session rows and recording-keyed caches
 * reset, diagnostics and the artwork cache survive. The caller is
 * responsible for rehydrating app state afterwards.
 */
export async function applyImport(
  storage: StoragePort,
  doc: ExportDocument,
  context: OperationContext,
): Promise<Result<void>> {
  // localCount is this device's own committed play total — a value
  // an import can neither trust (a foreign document's plays were
  // committed elsewhere and would be claimed twice on the wire) nor
  // blanket-strip (re-importing our own export would lose the real
  // baseline). The sync log survives the import, so the only honest
  // baseline is the one this device already holds for a recording
  // it knew before.
  const ownBaseline = new Map<
    string,
    { localCount?: number; loggedRemote?: number; loggedOurs?: number }
  >();
  const prior = await storage.load(context);
  if (!prior.ok) {
    // A failed read must not silently drop every baseline this
    // device holds — the import would commit with localCount
    // evidence erased.
    return prior;
  }
  for (const count of prior.value.playCounts) {
    ownBaseline.set(count.recordingId, {
      ...(count.localCount !== undefined
        ? { localCount: count.localCount }
        : {}),
      ...(count.loggedRemote !== undefined
        ? { loggedRemote: count.loggedRemote }
        : {}),
      ...(count.loggedOurs !== undefined
        ? { loggedOurs: count.loggedOurs }
        : {}),
    });
  }
  const owned: ExportDocument = {
    ...doc,
    playCounts: doc.playCounts.map((count) => {
      const {
        localCount: _importedLocal,
        loggedRemote: _importedLogged,
        loggedOurs: _importedLoggedOurs,
        ...rest
      } = count;
      const own = ownBaseline.get(count.recordingId);
      if (own === undefined) {
        return rest;
      }
      return {
        ...rest,
        ...(own.localCount !== undefined
          ? { localCount: own.localCount }
          : {}),
        // The log baseline survives the import untouched — the doc's
        // count stays entirely unsent until the next absolute page.
        ...(own.loggedRemote !== undefined
          ? { loggedRemote: own.loggedRemote }
          : {}),
        ...(own.loggedOurs !== undefined
          ? { loggedOurs: own.loggedOurs }
          : {}),
        // The merged total can't sit below this device's own
        // stamped component — the sync log survives the import, so
        // a doc that under-reports it gets the honest floor, not a
        // row where the next play emits an aggregate peers can't
        // advance.
        count: Math.max(rest.count, own.localCount ?? 0),
      };
    }),
  };
  return storage.importOwned(owned, context);
}
