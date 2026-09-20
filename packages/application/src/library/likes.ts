import type { TrackLike } from '../domain.ts';

export function toggleTrackLike(
  likes: readonly TrackLike[],
  recordingId: string,
  nowMs: number,
): readonly TrackLike[] {
  if (recordingId.trim().length === 0) {
    throw new TypeError('recordingId must be nonempty');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('nowMs must be a safe nonnegative integer');
  }
  const existing = likes.findIndex((l) => l.recordingId === recordingId);
  if (existing >= 0) {
    return likes.filter((_, i) => i !== existing);
  }
  return [...likes, { recordingId, likedAtMs: nowMs }];
}

export function isTrackLiked(
  likes: readonly TrackLike[],
  recordingId: string,
): boolean {
  return likes.some((l) => l.recordingId === recordingId);
}
