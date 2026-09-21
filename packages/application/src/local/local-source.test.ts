import { CancellationSource } from '../cancellation.ts';
import {
  isLocalFile,
  isLocalSource,
  type Settings,
} from '../domain.ts';
import { ok, type Result } from '../errors.ts';
import type { PersistedState } from '../ports/storage.ts';
import type { QueueSnapshot } from '../queue/queue-engine.ts';
import type {
  FileFingerprint,
  LocalEntry,
  LocalTags,
  PickedFolder,
} from '../ports/tag-reader.ts';
import {
  FakeClock,
  FakeLog,
  FakeStorage,
  FakeTagReader,
  SequenceIds,
} from '../testing/fakes.ts';
import { assert, assertEqual } from '../testing/assert.ts';
import { LocalFileSource } from './local-source.ts';

const SETTINGS: Settings = {
  catalogProvider: 'itunes',
  playbackProvider: 'youtube-music',
  storefront: 'US',
  qualityKbps: 256,
  theme: 'system',
  prefetch: true,
};

function emptyQueue(): QueueSnapshot {
  return {
    revision: 0,
    occurrences: [],
    currentOccurrenceId: null,
    positionMs: 0,
    mode: 'stopped',
  };
}

function persisted(partial: Partial<PersistedState> = {}): PersistedState {
  return {
    recordings: partial.recordings ?? [],
    likes: partial.likes ?? [],
    entities: partial.entities ?? [],
    entitySourceRefs: partial.entitySourceRefs ?? [],
    playlists: partial.playlists ?? [],
    playlistEntries: partial.playlistEntries ?? [],
    playHistory: partial.playHistory ?? [],
    playCounts: partial.playCounts ?? [],
    matchReviews: partial.matchReviews ?? [],
    lyricsCache: partial.lyricsCache ?? [],
    artworkCache: partial.artworkCache ?? [],
    downloads: partial.downloads ?? [],
    localSources: partial.localSources ?? [],
    localFiles: partial.localFiles ?? [],
    queue: partial.queue ?? emptyQueue(),
    settings: partial.settings ?? SETTINGS,
  };
}

const TREE = 'content://com.android.externalstorage.documents/tree/music';
const docUri = (docId: string) => `${TREE}/document/${docId}`;

function entry(
  docId: string,
  size: number,
  name = `${docId}.mp3`,
  modifiedMs: number | null = 1_700_000_000_000,
): LocalEntry {
  return { docId, name, size, mime: 'audio/mpeg', modifiedMs };
}

function fp(docId: string, fingerprint: string): FileFingerprint {
  return { docId, fingerprint };
}

function tags(
  docId: string,
  title: string | null,
  extra: Partial<LocalTags> = {},
): LocalTags {
  return {
    docId,
    title,
    artist: null,
    album: null,
    durationMs: null,
    genre: null,
    ...extra,
  };
}

function rig(initial: Partial<PersistedState> = {}) {
  const storage = new FakeStorage(persisted(initial));
  const tagReader = new FakeTagReader();
  const ids = new SequenceIds();
  const clock = new FakeClock(1000);
  const log = new FakeLog();
  const source = new LocalFileSource(
    { storage, tagReader, ids, clock, log },
    {
      localSources: initial.localSources ?? [],
      localFiles: initial.localFiles ?? [],
      recordings: initial.recordings ?? [],
    },
  );
  return { storage, tagReader, ids, clock, log, source };
}

const signal = () => new CancellationSource().signal;

function must<T>(res: Result<T>, what = 'result'): T {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.error.kind}`);
  }
  return res.value;
}

function pick(tagReader: FakeTagReader, label = 'Music'): void {
  tagReader.pickResult = ok<PickedFolder>({ treeUri: TREE, label });
}

async function runAddFolderScan(): Promise<void> {
  const { storage, tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100, 'alpha.mp3')]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  tagReader.tags.set('d1', tags('d1', 'Alpha', { artist: 'A', durationMs: 9000 }));

  const added = must(await source.addFolder(signal()));
  assert(source.list().length === 1, 'one source listed');
  const files = source.filesFor(added.sourceId);
  assert(files.length === 1, 'one file row');
  assert(files[0]!.title === 'Alpha', 'tag title stored');
  assert(
    isLocalFile(files[0]) && isLocalSource(source.list()[0]),
    'rows satisfy validators',
  );
  const recs = source.recordings();
  assert(recs.length === 1, 'one recording materialized');
  assert(recs[0]!.provenance === 'local', 'provenance local');
  assert(recs[0]!.title === 'Alpha', 'recording title');
  assert(
    recs[0]!.sourceRefs.some(
      (s) => s.provider === 'local' && s.id === files[0]!.fileId,
    ),
    'recording carries the local ref',
  );
  // uriFor resolves through the treeUri + docId — the session hook.
  const uri = source.uriFor(recs[0]!.id);
  assert(uri === docUri('d1'), `uriFor resolves, got ${uri}`);
  // Persisted sections carry the full arrays — `recordings` travels
  // as an in-transaction merge, so it proves out through a read-back
  // rather than the batch fields.
  const last = storage.commits.at(-1)!.batch;
  assert((last.localFiles?.length ?? 0) === 1, 'commit carries localFiles');
  const persisted = must(
    await storage.load({
      requestId: 't-readback',
      deadlineMs: 60_000,
      signal: signal(),
    }),
    'read-back load',
  );
  assert(persisted.recordings.length === 1, 'commit wrote recordings');
  assert(source.list()[0]!.lastScanMs !== null, 'lastScanMs set');
}

async function runUntaggedTitleFromName(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d9', 50, 'My Song File.ogg')]);
  tagReader.fingerprints.set('d9', fp('d9', 'fp9'));
  // No tag entry → null.
  const added = must(await source.addFolder(signal()));
  const recs = source.recordings();
  assert(recs.length === 1, 'recording created');
  assert(recs[0]!.title === 'My Song File', 'title falls back to filename');
  assert(recs[0]!.durationMs === null, 'duration stays null');
}

async function runRescanIncremental(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  const added = must(await source.addFolder(signal()));
  assert(tagReader.fingerprintCalls.length === 1, 'one fp batch');
  const again = must(await source.rescan(undefined, signal()));
  assert(tagReader.fingerprintCalls.length === 1, 'unchanged → no refingerprint');
  const report = again[0]!;
  assert(
    report.added === 0 && report.removed === 0 && report.updated === 0,
    'clean rescan',
  );
}

async function runMovedFileKeepsIdentity(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  const added = must(await source.addFolder(signal()));
  const before = source.filesFor(added.sourceId)[0]!;

  // Same content under a new docId (user moved the file).
  tagReader.entries.set(TREE, [entry('d2', 100, 'alpha.mp3')]);
  tagReader.fingerprints.set('d2', fp('d2', 'fpa'));
  const res = must(await source.rescan(added.sourceId, signal()));
  assert(res[0]!.updated === 1, 'locator refresh counts as updated');
  const after = source.filesFor(added.sourceId);
  assert(after.length === 1, 'still one row');
  assert(after[0]!.fileId === before.fileId, 'fileId survives the move');
  assert(after[0]!.docId === 'd2', 'docId refreshed');
  assert(after[0]!.recordingId === before.recordingId, 'recording kept');
}

async function runChangedContentNewFileId(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  const added = must(await source.addFolder(signal()));
  const before = source.filesFor(added.sourceId)[0]!;

  // New bytes at the same path: size changed → new fingerprint.
  tagReader.entries.set(TREE, [entry('d1', 140)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpb'));
  const res = must(await source.rescan(added.sourceId, signal()));
  const after = source.filesFor(added.sourceId);
  assert(after.length === 1, 'one row');
  assert(after[0]!.fileId !== before.fileId, 'new fingerprint → new fileId');
  assert(
    after[0]!.recordingId === before.recordingId,
    'same docId keeps the recording',
  );
  const rec = source.recordings()[0]!;
  // New bytes keep the recording identity and gain the live ref; the
  // dead ref becomes an `fp:` tombstone — if those exact old bytes
  // ever reappear under another folder they re-link here instead of
  // duplicating the recording.
  assert(
    rec.sourceRefs.length === 2 &&
      rec.sourceRefs.some((s) => s.id === after[0]!.fileId) &&
      rec.sourceRefs.some((s) => s.id === 'fp:fpa'),
    'dead local ref tombstoned, new ref present',
  );
}

async function runTwoFoldersTwoRows(): Promise<void> {
  const { tagReader, source } = rig();
  // Folder 1.
  tagReader.pickResult = ok<PickedFolder>({ treeUri: TREE, label: 'A' });
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'samefp'));
  const a = must(await source.addFolder(signal()));
  // Folder 2 with the same content.
  const TREE2 = 'content://x/tree/other';
  tagReader.pickResult = ok<PickedFolder>({ treeUri: TREE2, label: 'B' });
  tagReader.entries.set(TREE2, [entry('e1', 100)]);
  tagReader.fingerprints.set('e1', fp('e1', 'samefp'));
  const b = must(await source.addFolder(signal()));

  const fa = source.filesFor(a.sourceId);
  const fb = source.filesFor(b.sourceId);
  assert(fa.length === 1 && fb.length === 1, 'one row per folder');
  assert(fa[0]!.fileId !== fb[0]!.fileId, 'two rows get distinct fileIds');
  assert(
    fa[0]!.recordingId === fb[0]!.recordingId,
    'same content shares the recording',
  );
  const rec = source.recordings()[0]!;
  assert(rec.sourceRefs.length === 2, 'recording carries both local refs');
}

async function runRescanRemovesMissing(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100), entry('d2', 200)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  tagReader.fingerprints.set('d2', fp('d2', 'fpb'));
  const added = must(await source.addFolder(signal()));
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  const res = must(await source.rescan(added.sourceId, signal()));
  assert(res[0]!.removed === 1, 'one removed');
  const files = source.filesFor(added.sourceId);
  assert(files.length === 1 && files[0]!.docId === 'd1', 'gone row dropped');
  const rec = source.recordings().find((r) => r.sourceRefs.length === 0);
  assert(rec === undefined, 'a local-only row keeps its inert ref');
}

async function runUnreadableKeepsRow(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  const added = must(await source.addFolder(signal()));
  // File grew but the fingerprint read fails → prior row survives.
  tagReader.entries.set(TREE, [entry('d1', 140)]);
  tagReader.fingerprints.delete('d1');
  const res = must(await source.rescan(added.sourceId, signal()));
  assert(res[0]!.unreadable === 1, 'unreadable counted');
  const files = source.filesFor(added.sourceId);
  assert(files.length === 1 && files[0]!.size === 100, 'prior row kept');
}

async function runRemoveSource(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  const added = must(await source.addFolder(signal()));
  const rec = source.recordings()[0]!;
  const removed = await source.removeSource(added.sourceId, signal());
  assert(removed.ok, 'remove ok');
  assert(source.list().length === 0, 'source gone');
  assert(source.filesFor(added.sourceId).length === 0, 'rows gone');
  assert(source.uriFor(rec.id) === null, 'no playable uri');
  const persistedRec = source.recordings().find((r) => r.id === rec.id);
  assert(persistedRec !== undefined, 'recording persists');
  // Local-only row: its dead ref stays as an `fp:` tombstone — inert
  // (uriFor already returned null above) so the ≥1-ref invariant
  // holds and sqlite's commit validation accepts the batch, while the
  // fingerprint key re-links the same content if it ever returns.
  // FakeStorage now validates the merged document the same way, so a
  // regression to zero refs would fail `removed.ok` above, not this line.
  assertEqual(persistedRec!.sourceRefs.length, 1, 'inert ref kept');
  assertEqual(
    persistedRec!.sourceRefs[0]!.provider,
    'local',
    'kept ref is the dead local fingerprint',
  );
  assert(
    persistedRec!.sourceRefs[0]!.id === 'fp:fpa',
    'tombstone keyed by fingerprint',
  );
}

async function runReaddRelinksRecording(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  const added = must(await source.addFolder(signal()));
  const rec = source.recordings()[0]!;

  must(await source.removeSource(added.sourceId, signal()));

  // Re-adding the same folder mints a new sourceId — the tombstone's
  // fingerprint still re-links to the original recording, so likes
  // and playlist entries survive remove→add.
  const readded = must(await source.addFolder(signal()));
  assert(readded.sourceId !== added.sourceId, 'fresh sourceId');
  const relinked = source.recordings()[0]!;
  assertEqual(
    source.recordings().length,
    1,
    'no duplicate recording allocated',
  );
  assertEqual(relinked.id, rec.id, 'recording identity re-linked');
  assert(
    relinked.sourceRefs.some(
      (s) =>
        s.provider === 'local' &&
        s.id === source.filesFor(readded.sourceId)[0]!.fileId,
    ),
    'live local ref restored',
  );
  assert(source.uriFor(rec.id) !== null, 'playable uri again');
}

async function runMixedRemoveRelinksRecording(): Promise<void> {
  const { storage, tagReader, ids, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  const added = must(await source.addFolder(signal()));
  const rec = source.recordings()[0]!;

  // Resolution appended a provider ref — the row isn't local-only, so
  // removal must still tombstone the dead local ref for re-linking.
  must(
    await storage.commit(
      {
        recordings: [
          {
            ...rec,
            sourceRefs: [
              ...rec.sourceRefs,
              { provider: 'deezer', kind: 'track', id: 'dz-1' },
            ],
          },
        ],
      },
      { requestId: ids.next('w'), deadlineMs: 0, signal: signal() },
    ),
  );

  must(await source.removeSource(added.sourceId, signal()));
  const orphan = source.recordings()[0]!;
  assert(
    orphan.sourceRefs.some((s) => s.provider === 'deezer') &&
      orphan.sourceRefs.some(
        (s) => s.provider === 'local' && s.id === 'fp:fpa',
      ),
    'provider ref + fingerprint tombstone survive removal',
  );

  must(await source.addFolder(signal()));
  assertEqual(source.recordings().length, 1, 'no duplicate recording');
  const relinked = source.recordings()[0]!;
  assertEqual(relinked.id, rec.id, 'mixed row re-links via tombstone');
  assert(
    !relinked.sourceRefs.some((s) => s.id === 'fp:fpa') &&
      relinked.sourceRefs.some(
        (s) => s.provider === 'local' && s.id !== 'fp:fpa',
      ),
    'live local ref restored, tombstone retired',
  );
}

async function runPickCancelled(): Promise<void> {
  const { tagReader, storage, source } = rig();
  // FakeTagReader default pickResult is a no-result err — as a user cancel.
  const res = await source.addFolder(signal());
  assert(!res.ok && res.error.kind === 'no-result', 'cancel surfaces honestly');
  assert(storage.commits.length === 0, 'nothing persisted');
  assert(source.list().length === 0, 'no source row');
}

async function runRescanMergesFreshRecordings(): Promise<void> {
  const { storage, tagReader, ids, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  tagReader.tags.set('d1', tags('d1', 'Alpha'));
  await source.addFolder(signal());
  const localRec = source.recordings()[0]!;

  // A session write lands between scans: a new catalog recording and
  // an edited local title. The source's boot snapshot is stale now.
  const catalog = {
    id: 'rec-catalog',
    title: 'Catalog Song',
    artist: 'B',
    album: null,
    durationMs: null,
    releaseYear: null,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs: [{ provider: 'youtube-music', kind: 'track', id: 'yt-1' }],
    mappings: [],
    provenance: 'provider',
  } as const;
  const sessionWrite = must(
    await storage.commit(
      {
        recordings: [
          { ...localRec, title: 'Alpha (remaster)' },
          catalog,
        ],
      },
      {
        requestId: ids.next('session-write'),
        deadlineMs: 0,
        signal: signal(),
      },
    ),
  );
  void sessionWrite;

  // A second file arrives; the rescan must merge over the fresh set —
  // neither the catalog row nor the edited title may be lost.
  tagReader.entries.set(TREE, [entry('d1', 100), entry('d2', 200)]);
  tagReader.fingerprints.set('d2', fp('d2', 'fpb'));
  tagReader.tags.set('d2', tags('d2', 'Beta'));
  must(await source.rescan(undefined, signal()));

  // `recordings` now travels as an in-transaction merge — assert on
  // the post-commit state, which is exactly what the merge produced
  // over the freshest rows.
  const reloaded = must(
    await storage.load({
      requestId: 't',
      deadlineMs: 0,
      signal: signal(),
    }),
  );
  const committed = reloaded.recordings;
  const byId = new Map(committed.map((r) => [r.id, r]));
  assert(byId.has('rec-catalog'), 'catalog row survives the rescan');
  assert(
    byId.get(localRec.id)!.title === 'Alpha (remaster)',
    'session edit survives the rescan',
  );
  assert(
    committed.some((r) => r.title === 'Beta'),
    'new local recording upserted',
  );
}

/**
 * Two folders scanned concurrently — each commit must merge over
 * live state, so neither scan's rows are lost to a stale snapshot.
 */
async function runConcurrentScansKeepBoth(): Promise<void> {
  const TREE2 =
    'content://com.android.externalstorage.documents/tree/other';
  const { storage, tagReader, source } = rig({
    localSources: [
      {
        sourceId: 's1',
        treeUri: TREE,
        label: 'A',
        addedMs: 1,
        lastScanMs: null,
      },
      {
        sourceId: 's2',
        treeUri: TREE2,
        label: 'B',
        addedMs: 1,
        lastScanMs: null,
      },
    ],
  });
  tagReader.entries.set(TREE, [entry('d1', 100, 'alpha.mp3')]);
  tagReader.entries.set(TREE2, [entry('d2', 200, 'beta.mp3')]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  tagReader.fingerprints.set('d2', fp('d2', 'fpb'));
  tagReader.tags.set('d1', tags('d1', 'Alpha'));
  tagReader.tags.set('d2', tags('d2', 'Beta'));

  const [a, b] = await Promise.all([
    source.rescan('s1', signal()),
    source.rescan('s2', signal()),
  ]);
  assert(a.ok && b.ok, 'both scans ok');
  assert(source.filesFor('s1').length === 1, 's1 row survives');
  assert(source.filesFor('s2').length === 1, 's2 row survives');
  const last = storage.commits.at(-1)!.batch;
  assertEqual(last.localFiles?.length, 2, 'commit carries both rows');
  assert(source.recordings().length === 2, 'both recordings materialized');
}

/**
 * Two copies of identical bytes under one folder: same fingerprint
 * must not collide the fileId — the second gets a docId-disambiguated
 * id, both rows index, and both join one shared recording.
 */
async function runDuplicateFilesOneFolder(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100), entry('d2', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpdup'));
  tagReader.fingerprints.set('d2', fp('d2', 'fpdup'));
  tagReader.tags.set('d1', tags('d1', 'Alpha'));
  tagReader.tags.set('d2', tags('d2', 'Alpha'));

  const added = must(await source.addFolder(signal()));
  const files = source.filesFor(added.sourceId);
  assert(files.length === 2, 'both duplicates indexed');
  assert(files[0]!.fileId !== files[1]!.fileId, 'distinct fileIds');
  assert(
    files[0]!.recordingId === files[1]!.recordingId,
    'duplicates share one recording',
  );
  assert(source.recordings().length === 1, 'one recording');

  // Rescan is stable: both rows match by docId and keep their ids.
  const before = files.map((f) => `${f.docId}:${f.fileId}`).sort();
  must(await source.rescan(added.sourceId, signal()));
  const after = source
    .filesFor(added.sourceId)
    .map((f) => `${f.docId}:${f.fileId}`)
    .sort();
  assert(
    before.length === 2 && before.every((v, i) => v === after[i]),
    'fileIds stable across rescans',
  );
}

/**
 * Import clears file rows but keeps recordings with live `local`
 * refs. A rescan recomputes the same fileId — it must rejoin the
 * imported recording, not mint a duplicate.
 */
async function runRescanRelinksImported(): Promise<void> {
  // Learn the deterministic fileId for (sourceId, fingerprint) —
  // the same pair recomputes it after the import wipes the rows.
  const learn = rig();
  pick(learn.tagReader);
  learn.tagReader.entries.set(TREE, [entry('d1', 100, 'alpha.mp3')]);
  learn.tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  learn.tagReader.tags.set('d1', tags('d1', 'Alpha'));
  const learned = must(await learn.source.addFolder(signal()));
  const fileId = learn.source.filesFor(learned.sourceId)[0]!.fileId;

  const { tagReader, source } = rig({
    localSources: [
      {
        sourceId: learned.sourceId,
        treeUri: TREE,
        label: 'Music',
        addedMs: 1,
        lastScanMs: 1,
      },
    ],
    recordings: [
      {
        id: 'rec-imported',
        title: 'Alpha',
        artist: 'A',
        album: null,
        durationMs: 9000,
        releaseYear: null,
        artwork: [],
        explicit: null,
        genre: null,
        isrc: null,
        versionLabels: [],
        sourceRefs: [
          { provider: 'local', kind: 'track', id: fileId },
        ],
        mappings: [],
        provenance: 'local',
      },
    ],
  });
  tagReader.entries.set(TREE, [entry('d1', 100, 'alpha.mp3')]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  tagReader.tags.set('d1', tags('d1', 'Alpha'));

  must(await source.rescan(learned.sourceId, signal()));
  const files = source.filesFor(learned.sourceId);
  assert(files.length === 1, 'one file row');
  assertEqual(
    files[0]!.recordingId,
    'rec-imported',
    'rejoined imported recording',
  );
  assert(source.recordings().length === 1, 'no duplicate recording');
}

/**
 * Same docId + same size but a different provider mtime is an
 * in-place content replace — the cheap skip can't trust size alone.
 */
async function runSameSizeReplaceRefingerprints(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  tagReader.tags.set('d1', tags('d1', 'Alpha'));
  const added = must(await source.addFolder(signal()));
  const before = source.filesFor(added.sourceId)[0]!;
  const fpCallsAfterAdd = tagReader.fingerprintCalls.length;

  tagReader.entries.set(TREE, [entry('d1', 100, 'd1.mp3', 1_700_000_100_000)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpb'));
  tagReader.tags.set('d1', tags('d1', 'Beta'));
  const res = must(await source.rescan(added.sourceId, signal()));
  assertEqual(
    tagReader.fingerprintCalls.length,
    fpCallsAfterAdd + 1,
    'mtime change re-fingerprints',
  );
  assert(res[0]!.added === 1 && res[0]!.removed === 1, 'row replaced');
  const after = source.filesFor(added.sourceId);
  assert(after.length === 1, 'one row');
  assert(after[0]!.fileId !== before.fileId, 'new content → new fileId');
  assert(
    after[0]!.modifiedMs === 1_700_000_100_000,
    'new stamp persisted',
  );
  assert(
    after[0]!.recordingId === before.recordingId,
    'same docId keeps the recording',
  );
}

/**
 * A provider that cannot report a modified stamp gets no cheap skip:
 * every rescan verifies same-size rows by fingerprint. Equal bytes
 * reclaim the same row — nothing churns.
 */
async function runNoMtimeAlwaysFingerprints(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [entry('d1', 100, 'd1.mp3', null)]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpa'));
  tagReader.tags.set('d1', tags('d1', 'Alpha'));
  const added = must(await source.addFolder(signal()));
  const before = source.filesFor(added.sourceId)[0]!;

  const res = must(await source.rescan(added.sourceId, signal()));
  assertEqual(tagReader.fingerprintCalls.length, 2, 'fingerprinted again');
  const report = res[0]!;
  assert(
    report.added === 0 && report.removed === 0 && report.updated === 0,
    'identical bytes → clean report',
  );
  const after = source.filesFor(added.sourceId);
  assertEqual(after[0]!.fileId, before.fileId, 'same fp → same row');
}

/**
 * SAF doc ids may carry non-ASCII: 'i' and 'é' share low 7 bits —
 * a masked hash would collide the disambiguated fileIds.
 */
async function runUnicodeDocIdsNoCollision(): Promise<void> {
  const { tagReader, source } = rig();
  pick(tagReader);
  tagReader.entries.set(TREE, [
    entry('d1', 100),
    entry('i', 100),
    entry('é', 100),
  ]);
  tagReader.fingerprints.set('d1', fp('d1', 'fpdup'));
  tagReader.fingerprints.set('i', fp('i', 'fpdup'));
  tagReader.fingerprints.set('é', fp('é', 'fpdup'));
  tagReader.tags.set('d1', tags('d1', 'Alpha'));
  tagReader.tags.set('i', tags('i', 'Alpha'));
  tagReader.tags.set('é', tags('é', 'Alpha'));

  const added = must(await source.addFolder(signal()));
  const files = source.filesFor(added.sourceId);
  assert(files.length === 3, 'all three indexed');
  assert(
    new Set(files.map((f) => f.fileId)).size === 3,
    'distinct fileIds for non-ASCII docIds',
  );
}

export async function run(): Promise<void> {
  await runAddFolderScan();
  await runUntaggedTitleFromName();
  await runRescanIncremental();
  await runMovedFileKeepsIdentity();
  await runChangedContentNewFileId();
  await runTwoFoldersTwoRows();
  await runRescanRemovesMissing();
  await runUnreadableKeepsRow();
  await runRemoveSource();
  await runReaddRelinksRecording();
  await runMixedRemoveRelinksRecording();
  await runPickCancelled();
  await runRescanMergesFreshRecordings();
  await runSameSizeReplaceRefingerprints();
  await runNoMtimeAlwaysFingerprints();
  await runConcurrentScansKeepBoth();
  await runDuplicateFilesOneFolder();
  await runRescanRelinksImported();
  await runUnicodeDocIdsNoCollision();
}
