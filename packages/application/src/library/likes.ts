import type { EntityKind, Like, LikeEntityKind } from '../domain.ts';

function toggle(
  likes: readonly Like[],
  entityKind: LikeEntityKind,
  targetId: string,
  nowMs: number,
  label: string,
): readonly Like[] {
  if (targetId.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('nowMs must be a safe nonnegative integer');
  }
  const existing = likes.findIndex(
    (l) => l.entityKind === entityKind && l.targetId === targetId,
  );
  if (existing >= 0) {
    return likes.filter((_, i) => i !== existing);
  }
  return [...likes, { entityKind, targetId, likedAtMs: nowMs }];
}

export function toggleTrackLike(
  likes: readonly Like[],
  recordingId: string,
  nowMs: number,
): readonly Like[] {
  return toggle(likes, 'track', recordingId, nowMs, 'recordingId');
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
  return toggle(likes, kind, entityId, nowMs, 'entityId');
}
