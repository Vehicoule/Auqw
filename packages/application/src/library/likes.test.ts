import { isTrackLiked, toggleTrackLike } from './likes.ts';
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
}
