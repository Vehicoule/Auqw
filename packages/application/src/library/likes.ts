import type { EntityKind, Like } from '../domain.ts';

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

/**
 * Album/artist likes key on the entity id, independent of track likes
 * — the same targetId under a different kind is a different like.
 */
export function toggleEntityLike(
  likes: readonly Like[],
  kind: EntityKind,
  entityId: string,
  nowMs: number,
): readonly Like[] {
  if (kind !== 'album' && kind !== 'artist') {
    throw new TypeError('kind must be album or artist');
  }
  if (entityId.trim().length === 0) {
    throw new TypeError('entityId must be nonempty');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('nowMs must be a safe nonnegative integer');
  }
  const existing = likes.findIndex(
    (l) => l.entityKind === kind && l.targetId === entityId,
  );
  if (existing >= 0) {
    return likes.filter((_, i) => i !== existing);
  }
  return [
    ...likes,
    { entityKind: kind, targetId: entityId, likedAtMs: nowMs },
  ];
}

export function isEntityLiked(
  likes: readonly Like[],
  kind: EntityKind,
  entityId: string,
): boolean {
  return likes.some(
    (l) => l.entityKind === kind && l.targetId === entityId,
  );
}
