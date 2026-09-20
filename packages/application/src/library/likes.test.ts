import type { EntityKind } from '../domain.ts';
import {
  isEntityLiked,
  isTrackLiked,
  toggleEntityLike,
  toggleTrackLike,
} from './likes.ts';
import { assert, assertEqual } from '../testing/assert.ts';

export function run(): void {
  let likes = toggleTrackLike([], 'rec-1', 100);
  assert(isTrackLiked(likes, 'rec-1'));
  assertEqual(likes.length, 1);
  assertEqual(likes[0]?.likedAtMs, 100);

  // Toggling again removes the like.
  likes = toggleTrackLike(likes, 'rec-1', 200);
  assert(!isTrackLiked(likes, 'rec-1'));
  assertEqual(likes.length, 0);

  // Likes are unique by recording id and independent of other rows.
  likes = toggleTrackLike(likes, 'rec-1', 10);
  likes = toggleTrackLike(likes, 'rec-2', 20);
  likes = toggleTrackLike(likes, 'rec-1', 30);
  assertEqual(likes.length, 1);
  assert(isTrackLiked(likes, 'rec-2'));
  assert(!isTrackLiked(likes, 'rec-1'));

  // Input validation is programmer-invalid -> throws.
  let threw = false;
  try {
    toggleTrackLike([], '  ', 0);
  } catch {
    threw = true;
  }
  assert(threw, 'empty id must throw');
  threw = false;
  try {
    toggleTrackLike([], 'r', -1);
  } catch {
    threw = true;
  }
  assert(threw, 'negative time must throw');

  // ---- entity likes: album/artist, independent of track likes ----
  let entityLikes = toggleEntityLike([], 'album', 'e-1', 100);
  assert(isEntityLiked(entityLikes, 'album', 'e-1'));
  assert(!isEntityLiked(entityLikes, 'artist', 'e-1'));
  assertEqual(entityLikes[0]?.entityKind, 'album');

  entityLikes = toggleEntityLike(entityLikes, 'artist', 'e-1', 200);
  assertEqual(entityLikes.length, 2, 'kind keys the like');
  entityLikes = toggleEntityLike(entityLikes, 'album', 'e-1', 300);
  assertEqual(entityLikes.length, 1);
  assert(!isEntityLiked(entityLikes, 'album', 'e-1'));
  assert(isEntityLiked(entityLikes, 'artist', 'e-1'));

  // Entity likes coexist with a track like on the same targetId.
  let mixed = toggleTrackLike(entityLikes, 'e-1', 400);
  assertEqual(mixed.length, 2);
  assert(isTrackLiked(mixed, 'e-1'));
  assert(isEntityLiked(mixed, 'artist', 'e-1'));
  mixed = toggleEntityLike(mixed, 'artist', 'e-1', 500);
  assert(isTrackLiked(mixed, 'e-1'), 'entity toggle leaves track like');
  assertEqual(mixed.length, 1);

  threw = false;
  try {
    // Forced past the type boundary: runtime still rejects 'track'.
    toggleEntityLike([], 'track' as EntityKind, 'e-1', 0);
  } catch {
    threw = true;
  }
  assert(threw, 'track kind must throw');
  threw = false;
  try {
    toggleEntityLike([], 'album', ' ', 0);
  } catch {
    threw = true;
  }
  assert(threw, 'empty entityId must throw');
}
