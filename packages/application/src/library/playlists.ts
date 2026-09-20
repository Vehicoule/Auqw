import { isString, isSafeNonNegative, isTrackRef } from '../domain.ts';
import type { SourceRef } from '../domain.ts';
import type { Playlist, PlaylistEntry } from './library.ts';

/**
 * The two playlist sections mutate together: entry writes bump the
 * owning playlist's `updatedMs` and deletes cascade, so every use
 * case returns both sections for one atomic commit.
 */
export type PlaylistState = {
  readonly playlists: readonly Playlist[];
  readonly entries: readonly PlaylistEntry[];
};

/** Where a reordered entry lands: relative to a sibling, or the tail. */
export type EntryMove =
  | { readonly before: string }
  | { readonly after: string };

const MAX_ID = 64;
const MAX_NAME = 512;

function requireId(value: string, label: string): void {
  if (!isString(value, MAX_ID)) {
    throw new TypeError(`${label} must be a nonempty id`);
  }
}

function requireName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > MAX_NAME
  ) {
    throw new TypeError('invalid playlist name');
  }
}

function requireNow(nowMs: number): void {
  if (!isSafeNonNegative(nowMs)) {
    throw new TypeError('nowMs must be a safe nonnegative integer');
  }
}

function siblings(
  entries: readonly PlaylistEntry[],
  playlistId: string,
): PlaylistEntry[] {
  return entries
    .filter((e) => e.playlistId === playlistId)
    .sort((a, b) => a.position - b.position);
}

function bumpUpdated(
  playlists: readonly Playlist[],
  playlistId: string,
  nowMs: number,
): readonly Playlist[] {
  return playlists.map((p) =>
    p.playlistId === playlistId && p.updatedMs !== nowMs
      ? { ...p, updatedMs: nowMs }
      : p,
  );
}

export function createPlaylist(
  state: PlaylistState,
  playlistId: string,
  name: string,
  nowMs: number,
): PlaylistState {
  requireId(playlistId, 'playlistId');
  requireName(name);
  requireNow(nowMs);
  if (state.playlists.some((p) => p.playlistId === playlistId)) {
    throw new TypeError('duplicate playlistId');
  }
  const playlist: Playlist = {
    playlistId,
    name,
    createdMs: nowMs,
    updatedMs: nowMs,
  };
  return {
    playlists: [...state.playlists, playlist],
    entries: state.entries,
  };
}

export function renamePlaylist(
  state: PlaylistState,
  playlistId: string,
  name: string,
  nowMs: number,
): PlaylistState {
  requireId(playlistId, 'playlistId');
  requireName(name);
  requireNow(nowMs);
  const existing = state.playlists.find((p) => p.playlistId === playlistId);
  if (existing === undefined) {
    throw new TypeError('unknown playlist');
  }
  return {
    playlists: state.playlists.map((p) =>
      p.playlistId === playlistId ? { ...p, name, updatedMs: nowMs } : p,
    ),
    entries: state.entries,
  };
}

/** Deletes the playlist and cascades its entries in the same state. */
export function deletePlaylist(
  state: PlaylistState,
  playlistId: string,
): PlaylistState {
  requireId(playlistId, 'playlistId');
  if (!state.playlists.some((p) => p.playlistId === playlistId)) {
    throw new TypeError('unknown playlist');
  }
  return {
    playlists: state.playlists.filter((p) => p.playlistId !== playlistId),
    entries: state.entries.filter((e) => e.playlistId !== playlistId),
  };
}

/**
 * Appends one occurrence row: the same recording may be added twice —
 * each entry keeps its own entryId and `last + 1` position.
 */
export function addPlaylistEntry(
  state: PlaylistState,
  input: {
    readonly entryId: string;
    readonly playlistId: string;
    readonly recordingId: string;
    readonly selectedRef: SourceRef | null;
    readonly addedMs: number;
  },
): PlaylistState {
  requireId(input.entryId, 'entryId');
  requireId(input.playlistId, 'playlistId');
  requireId(input.recordingId, 'recordingId');
  if (input.selectedRef !== null && !isTrackRef(input.selectedRef)) {
    throw new TypeError('selectedRef must be a track ref or null');
  }
  requireNow(input.addedMs);
  const playlist = state.playlists.find(
    (p) => p.playlistId === input.playlistId,
  );
  if (playlist === undefined) {
    throw new TypeError('unknown playlist');
  }
  if (state.entries.some((e) => e.entryId === input.entryId)) {
    throw new TypeError('duplicate entryId');
  }
  const last = siblings(state.entries, input.playlistId).at(-1);
  const entry: PlaylistEntry = {
    entryId: input.entryId,
    playlistId: input.playlistId,
    recordingId: input.recordingId,
    position: last === undefined ? 1 : last.position + 1,
    selectedRef: input.selectedRef,
    addedMs: input.addedMs,
  };
  return {
    playlists: bumpUpdated(
      state.playlists,
      input.playlistId,
      input.addedMs,
    ),
    entries: [...state.entries, entry],
  };
}

export function removePlaylistEntry(
  state: PlaylistState,
  entryId: string,
  nowMs: number,
): PlaylistState {
  requireId(entryId, 'entryId');
  requireNow(nowMs);
  const entry = state.entries.find((e) => e.entryId === entryId);
  if (entry === undefined) {
    throw new TypeError('unknown entry');
  }
  return {
    playlists: bumpUpdated(state.playlists, entry.playlistId, nowMs),
    entries: state.entries.filter((e) => e.entryId !== entryId),
  };
}

/**
 * Fractional-position reorder: the entry lands strictly between its
 * new neighbors (midpoint), past the tail (`last + 1`), or ahead of
 * the head (`first - 1`). Only when no representable double separates
 * the neighbors are the playlist's positions compacted back to
 * integers — positions stay finite and unique.
 */
export function reorderPlaylistEntry(
  state: PlaylistState,
  entryId: string,
  move: EntryMove | null,
  nowMs: number,
): PlaylistState {
  requireId(entryId, 'entryId');
  requireNow(nowMs);
  const entry = state.entries.find((e) => e.entryId === entryId);
  if (entry === undefined) {
    throw new TypeError('unknown entry');
  }
  const rest = siblings(state.entries, entry.playlistId).filter(
    (e) => e.entryId !== entryId,
  );
  let index: number;
  if (move === null) {
    index = rest.length;
  } else {
    const targetId = 'before' in move ? move.before : move.after;
    const at = rest.findIndex((e) => e.entryId === targetId);
    if (at < 0) {
      throw new TypeError('unknown move target');
    }
    index = 'before' in move ? at : at + 1;
  }
  const before = index > 0 ? rest[index - 1] : undefined;
  const after = index < rest.length ? rest[index] : undefined;
  // Null means no strictly-new finite double exists at the slot —
  // the playlist's positions compact back to integers.
  let position: number | null = null;
  if (before === undefined) {
    if (after === undefined) {
      position = 1;
    } else {
      const head = after.position - 1;
      position = head < after.position ? head : null;
    }
  } else if (after === undefined) {
    const tail = before.position + 1;
    position = tail > before.position ? tail : null;
  } else {
    const mid = (before.position + after.position) / 2;
    position = mid > before.position && mid < after.position ? mid : null;
  }
  if (position === null) {
    const order = new Map(
      [...rest.slice(0, index), entry, ...rest.slice(index)].map(
        (e, i) => [e.entryId, i + 1],
      ),
    );
    return {
      playlists: bumpUpdated(state.playlists, entry.playlistId, nowMs),
      entries: state.entries.map((e) => {
        const renumbered = order.get(e.entryId);
        return renumbered === undefined ? e : { ...e, position: renumbered };
      }),
    };
  }
  const moved: PlaylistEntry = { ...entry, position };
  return {
    playlists: bumpUpdated(state.playlists, entry.playlistId, nowMs),
    entries: state.entries.map((e) => (e.entryId === entryId ? moved : e)),
  };
}
