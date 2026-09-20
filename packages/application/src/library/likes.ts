import type { Like } from '../domain.ts';

export function toggleTrackLike(
  likes: readonly Like[],
  recordingId: string,
  nowMs: number,
): readonly Like[] {
  if (recordingId.trim().length === 0) {
    throw new TypeError('recordingId must be nonempty');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('nowMs must be a safe nonnegative integer');
  }
  const existing = likes.findIndex(
    (l) => l.entityKind === 'track' && l.targetId === recordingId,
  );
  if (existing >= 0) {
    return likes.filter((_, i) => i !== existing);
  }
  return [
    ...likes,
    { entityKind: 'track' as const, targetId: recordingId, likedAtMs: nowMs },
  ];
}

export function isTrackLiked(
  likes: readonly Like[],
  recordingId: string,
): boolean {
  return likes.some(
    (l) => l.entityKind === 'track' && l.targetId === recordingId,
  );
}
