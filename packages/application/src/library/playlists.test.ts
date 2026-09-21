import type { Recording, SourceRef } from '../domain.ts';
import type { PersistedState } from '../ports/storage.ts';
import {
  addPlaylistEntry,
  createPlaylist,
  deletePlaylist,
  removePlaylistEntry,
  renamePlaylist,
  reorderPlaylistEntry,
} from './playlists.ts';
import type { PlaylistState } from './playlists.ts';
import { isPersistedState } from './library.ts';
import { assert, assertEqual } from '../testing/assert.ts';

function trackRef(provider: string, id: string): SourceRef {
  return { provider, kind: 'track', id };
}

function recording(id: string): Recording {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    durationMs: 300_000,
    releaseYear: 2020,
    artwork: [],
    explicit: null,
    genre: null,
    isrc: null,
    versionLabels: [],
    sourceRefs: [trackRef('itunes', `it-${id}`)],
    mappings: [],
    provenance: 'provider',
  };
}

function emptyState(): PlaylistState {
  return { playlists: [], entries: [] };
}

function assertThrows(fn: () => unknown, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, `${label} must throw`);
}

/** The use-case sections must merge into a valid persisted document. */
function assertPersistable(
  state: PlaylistState,
  recordings: readonly Recording[],
): void {
  const merged: PersistedState = {
    recordings,
    likes: [],
    entities: [],
    entitySourceRefs: [],
    playlists: state.playlists,
    playlistEntries: state.entries,
    playHistory: [],
    playCounts: [],
    matchReviews: [],
    lyricsCache: [],
    artworkCache: [],
    downloads: [],
    localSources: [],
    localFiles: [],
    queue: {
      revision: 0,
      occurrences: [],
      currentOccurrenceId: null,
      positionMs: 0,
      mode: 'stopped',
    },
    settings: {
      catalogProvider: 'itunes',
      playbackProvider: 'youtube-music',
      storefront: 'US',
      qualityKbps: 256,
      theme: 'system',
      prefetch: true,
    },
  };
  assert(isPersistedState(merged), 'playlist sections must persist');
}

function positions(state: PlaylistState, playlistId: string): number[] {
  return state.entries
    .filter((e) => e.playlistId === playlistId)
    .sort((a, b) => a.position - b.position)
    .map((e) => e.position);
}

export function run(): void {
  // ---- create / rename / delete ----
  let state = createPlaylist(emptyState(), 'pl-1', 'Roadtrip', 100);
  assertEqual(state.playlists.length, 1);
  assertEqual(state.playlists[0]?.name, 'Roadtrip');
  assertEqual(state.playlists[0]?.createdMs, 100);
  assertEqual(state.playlists[0]?.updatedMs, 100);
  assertPersistable(state, []);

  assertThrows(
    () => createPlaylist(emptyState(), 'pl-1', '', 0),
    'empty name',
  );
  assertThrows(
    () => createPlaylist(emptyState(), 'pl-1', '   ', 0),
    'blank name',
  );
  assertThrows(
    () => createPlaylist(emptyState(), 'pl-1', 'x'.repeat(513), 0),
    'overlong name',
  );
  assertThrows(
    () => createPlaylist(state, 'pl-1', 'Again', 0),
    'duplicate id',
  );
  assertThrows(
    () => createPlaylist(emptyState(), '', 'Name', 0),
    'empty id',
  );
  assertThrows(
    () => createPlaylist(emptyState(), 'pl-2', 'Name', -1),
    'negative time',
  );

  state = renamePlaylist(state, 'pl-1', 'Renamed', 250);
  assertEqual(state.playlists[0]?.name, 'Renamed');
  assertEqual(state.playlists[0]?.updatedMs, 250);
  assertEqual(state.playlists[0]?.createdMs, 100, 'createdMs untouched');
  assertThrows(() => renamePlaylist(state, 'pl-9', 'X', 1), 'rename missing');
  assertThrows(
    () => renamePlaylist(state, 'pl-1', ' ', 1),
    'rename blank',
  );

  // ---- addEntry: occurrences keep distinct ids ----
  state = addPlaylistEntry(state, {
    entryId: 'e-1',
    playlistId: 'pl-1',
    recordingId: 'rA',
    selectedRef: null,
    addedMs: 300,
  });
  state = addPlaylistEntry(state, {
    entryId: 'e-2',
    playlistId: 'pl-1',
    recordingId: 'rA',
    selectedRef: null,
    addedMs: 301,
  });
  state = addPlaylistEntry(state, {
    entryId: 'e-3',
    playlistId: 'pl-1',
    recordingId: 'rB',
    selectedRef: trackRef('itunes', 'it-rB'),
    addedMs: 302,
  });
  const ids = state.entries.map((e) => e.entryId);
  assertDeep(ids, ['e-1', 'e-2', 'e-3'], 'duplicates keep distinct ids');
  assertDeep(
    positions(state, 'pl-1'),
    [1, 2, 3],
    'append positions',
  );
  assertEqual(
    state.playlists[0]?.updatedMs,
    302,
    'add bumps updatedMs',
  );
  assertPersistable(state, [recording('rA'), recording('rB')]);

  assertThrows(
    () =>
      addPlaylistEntry(state, {
        entryId: 'e-1',
        playlistId: 'pl-1',
        recordingId: 'rA',
        selectedRef: null,
        addedMs: 400,
      }),
    'duplicate entryId',
  );
  assertThrows(
    () =>
      addPlaylistEntry(state, {
        entryId: 'e-9',
        playlistId: 'pl-9',
        recordingId: 'rA',
        selectedRef: null,
        addedMs: 400,
      }),
    'entry into missing playlist',
  );
  assertThrows(
    () =>
      addPlaylistEntry(state, {
        entryId: 'e-9',
        playlistId: 'pl-1',
        recordingId: 'rA',
        selectedRef: { provider: 'itunes', kind: 'album', id: 'a1' },
        addedMs: 400,
      }),
    'non-track selectedRef',
  );

  // ---- reorder: fractional midpoints ----
  // Move e-3 before e-1: lands ahead of the head at position 0.
  state = reorderPlaylistEntry(state, 'e-3', { before: 'e-1' }, 400);
  assertDeep(
    state.entries.map((e) => e.entryId),
    ['e-1', 'e-2', 'e-3'],
    'entry array keeps row identity',
  );
  assertDeep(
    orderedIds(state, 'pl-1'),
    ['e-3', 'e-1', 'e-2'],
    'before-head order',
  );
  assertEqual(
    state.entries.find((e) => e.entryId === 'e-3')?.position,
    0,
    'before head is first - 1',
  );

  // Move e-1 after e-2: the tail, so last + 1 = 3.
  state = reorderPlaylistEntry(state, 'e-1', { after: 'e-2' }, 410);
  assertDeep(orderedIds(state, 'pl-1'), ['e-3', 'e-2', 'e-1']);
  assertEqual(
    state.entries.find((e) => e.entryId === 'e-1')?.position,
    3,
    'after tail is last + 1',
  );

  // Move e-1 before e-2: midpoint of neighbors (e-3=0, e-2=2) = 1.
  state = reorderPlaylistEntry(state, 'e-1', { before: 'e-2' }, 420);
  assertDeep(orderedIds(state, 'pl-1'), ['e-3', 'e-1', 'e-2']);
  assertEqual(
    state.entries.find((e) => e.entryId === 'e-1')?.position,
    1,
    'midpoint between neighbors',
  );
  // Null move lands on the tail: last + 1.
  state = reorderPlaylistEntry(state, 'e-3', null, 430);
  assertDeep(orderedIds(state, 'pl-1'), ['e-1', 'e-2', 'e-3']);
  assertEqual(
    state.entries.find((e) => e.entryId === 'e-3')?.position,
    3,
    'tail move is last + 1',
  );
  assertEqual(state.playlists[0]?.updatedMs, 430, 'reorder bumps');
  assertPersistable(state, [recording('rA'), recording('rB')]);

  // Compaction: adjacent doubles leave no midpoint; positions renumber.
  let tight: PlaylistState = {
    playlists: [{ playlistId: 'pl-t', name: 'T', createdMs: 0, updatedMs: 0 }],
    entries: [
      {
        entryId: 't-1',
        playlistId: 'pl-t',
        recordingId: 'rA',
        position: 1,
        selectedRef: null,
        addedMs: 0,
      },
      {
        entryId: 't-2',
        playlistId: 'pl-t',
        recordingId: 'rB',
        position: 1 + Number.EPSILON,
        selectedRef: null,
        addedMs: 0,
      },
      {
        entryId: 't-3',
        playlistId: 'pl-t',
        recordingId: 'rC',
        position: 9,
        selectedRef: null,
        addedMs: 0,
      },
    ],
  };
  tight = reorderPlaylistEntry(tight, 't-3', { before: 't-2' }, 500);
  assertDeep(
    positions(tight, 'pl-t'),
    [1, 2, 3],
    'exhausted precision compacts to integers',
  );
  assertDeep(orderedIds(tight, 'pl-t'), ['t-1', 't-3', 't-2']);
  assertPersistable(tight, [recording('rA'), recording('rB'), recording('rC')]);

  assertThrows(
    () => reorderPlaylistEntry(state, 'e-9', null, 1),
    'reorder missing entry',
  );
  assertThrows(
    () => reorderPlaylistEntry(state, 'e-1', { before: 'e-9' }, 1),
    'reorder to missing target',
  );
  assertThrows(
    () => reorderPlaylistEntry(state, 'e-1', { after: 'e-1' }, 1),
    'reorder relative to itself',
  );

  // ---- removeEntry / delete ----
  state = removePlaylistEntry(state, 'e-2', 500);
  assertDeep(orderedIds(state, 'pl-1'), ['e-1', 'e-3']);
  assertEqual(state.playlists[0]?.updatedMs, 500, 'remove bumps');
  assertThrows(() => removePlaylistEntry(state, 'e-9', 1), 'remove missing');

  state = deletePlaylist(state, 'pl-1');
  assertEqual(state.playlists.length, 0);
  assertEqual(state.entries.length, 0, 'delete cascades entries');
  assertThrows(() => deletePlaylist(state, 'pl-1'), 'delete missing');
  assertPersistable(state, []);
}

function orderedIds(state: PlaylistState, playlistId: string): string[] {
  return state.entries
    .filter((e) => e.playlistId === playlistId)
    .sort((a, b) => a.position - b.position)
    .map((e) => e.entryId);
}

function assertDeep(
  actual: readonly string[] | readonly number[],
  expected: readonly string[] | readonly number[],
  label = 'assertDeep',
): void {
  assertEqual(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < actual.length; i += 1) {
    assertEqual(actual[i], expected[i], `${label}: index ${i}`);
  }
}
