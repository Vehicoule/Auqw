import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { useTrackList } from './track-row.tsx';
import { t } from '@auqw/ui-shared';
import type { QueueItemModel, QueueModel } from '@auqw/ui-shared';

// ---- optimistic reorder bookkeeping ----------------------------------

export type PendingMove = { readonly id: string; readonly dir: -1 | 1 };

// Unacknowledged pending ops expire after this window: the caller
// contract carries no reject signal, so a bounded TTL is the honest
// way to bound how long a truly-failed move can ghost the order.
export const PENDING_TTL_MS = 30_000;

export function idsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function applyPendingMove(
  ids: readonly string[],
  move: PendingMove,
): readonly string[] {
  const from = ids.indexOf(move.id);
  const to = from + move.dir;
  const swapped = ids[to];
  if (from < 0 || swapped === undefined) {
    return ids;
  }
  const next = ids.slice();
  next[from] = swapped;
  next[to] = move.id;
  return next;
}

function applyMoves(ids: readonly string[], ops: readonly PendingMove[]): readonly string[] {
  let order = ids;
  for (const op of ops) {
    order = applyPendingMove(order, op);
  }
  return order;
}

/**
 * Reconcile a newly published queue order against the dispatched-but-
 * unacknowledged move ops: the largest ops prefix that reproduces the
 * published order is the acknowledged part; the tail keeps pending on
 * top of it. Null when the update is incompatible (external reorder,
 * membership change) — callers rebase by dropping the pending state.
 */
export function reconcilePendingOps(
  lastAuth: readonly string[],
  ops: readonly PendingMove[],
  auth: readonly string[],
): { readonly ops: readonly PendingMove[]; readonly ids: readonly string[] } | null {
  let cursor = lastAuth;
  if (idsEqual(cursor, auth)) {
    return { ops, ids: applyMoves(auth, ops) };
  }
  for (const [i, op] of ops.entries()) {
    cursor = applyPendingMove(cursor, op);
    if (idsEqual(cursor, auth)) {
      const rest = ops.slice(i + 1);
      return { ops: rest, ids: applyMoves(auth, rest) };
    }
  }
  return null;
}

export type QueueListProps = {
  readonly queue: QueueModel;
  readonly reordering?: boolean | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressItem?: ((occurrenceId: string) => void) | undefined;
  readonly onRemoveItem?: ((occurrenceId: string) => void) | undefined;
  readonly onMoveItem?:
    | ((occurrenceId: string, direction: -1 | 1) => void)
    | undefined;
  readonly onMoveItemTo?:
    | ((occurrenceId: string, toIndex: number) => void)
    | undefined;
};

// Web reordering is button-driven: Alt+ArrowUp/ArrowDown moves the
// focused row (the pointer path is the visible chevrons) — no pointer
// drag library for one list.
export function QueueList({
  queue,
  reordering = false,
  scrollEnabled = true,
  onPressItem,
  onRemoveItem,
  onMoveItem,
  onMoveItemTo,
}: QueueListProps) {
  // Optimistic reorder bookkeeping: queue.items is controlled by the
  // caller, so each intended move is kept as a pending op. Publishes
  // acknowledge dispatched ops in order — a partial publish keeps the
  // tail; an incompatible update (external reorder, membership change)
  // rebases the whole pending state. An unchanged-order republish is
  // NOT read as rejection - callers send no explicit reject signal -
  // so a bounded TTL clears ops that stay unacknowledged too long.
  // With only a relative callback, one op stays in flight per publish
  // round-trip; the rest queue locally so a stale-order read can't
  // collapse repeated moves of the same row.
  const pendingOps = useRef<readonly PendingMove[]>([]);
  const queuedOps = useRef<readonly PendingMove[]>([]);
  const pendingIds = useRef<readonly string[] | null>(null);
  const pendingSince = useRef(0);
  const lastItems = useRef<QueueModel['items'] | null>(null);
  const lastAuthIds = useRef<readonly string[] | null>(null);
  const trackFocusId = useRef<string | null>(null);
  const seenItems = useRef<QueueModel['items'] | null>(null);
  const [, setPendingTick] = useState(0);
  const list = useTrackList({
    count: queue.items.length,
    onActivate:
      onPressItem === undefined || reordering
        ? undefined
        : (index) => {
            // Resolve against the live optimistic order — rendered
            // rows and keyboard activation must see one sequence.
            const ids = pendingIds.current ?? queue.items.map((i) => i.occurrenceId);
            const id = ids[index];
            const item =
              id === undefined
                ? undefined
                : queue.items.find((i) => i.occurrenceId === id);
            if (item !== undefined) {
              onPressItem(item.occurrenceId);
            }
          },
    onContext: undefined,
  });
  const authIds = queue.items.map((item) => item.occurrenceId);
  const useAbsolute = onMoveItemTo !== undefined;
  const stale =
    pendingIds.current !== null && Date.now() - pendingSince.current > PENDING_TTL_MS;
  if (lastItems.current !== queue.items) {
    const prevAuth = lastAuthIds.current;
    lastItems.current = queue.items;
    lastAuthIds.current = authIds;
    if (prevAuth !== null && pendingIds.current !== null) {
      if (idsEqual(prevAuth, authIds)) {
        // Unchanged order — not proof of rejection, keep pending
        // (the TTL bounds how long an unacked op can linger).
      } else {
        const res = reconcilePendingOps(prevAuth, pendingOps.current, authIds);
        if (res === null) {
          pendingOps.current = [];
          queuedOps.current = [];
          pendingIds.current = null;
        } else {
          pendingOps.current = res.ops;
          const tail = [...res.ops, ...queuedOps.current];
          pendingIds.current = tail.length === 0 ? null : applyMoves(authIds, tail);
        }
      }
    }
  }
  if (stale) {
    pendingOps.current = [];
    queuedOps.current = [];
    pendingIds.current = null;
  }
  // The TTL must fire even while the component idles: an expiry
  // timer re-arms on every render, clears the pending refs, and
  // bumps state so the rollback actually paints.
  useEffect(() => {
    if (pendingIds.current === null) {
      return;
    }
    const remaining = PENDING_TTL_MS - (Date.now() - pendingSince.current);
    const expire = () => {
      pendingOps.current = [];
      queuedOps.current = [];
      pendingIds.current = null;
      setPendingTick((tick) => tick + 1);
    };
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  });
  // Focus follows the moved row through publishes: once the
  // authoritative order lands, point the roving index at it again.
  // Also where serialized relative moves flush: a queued op ships
  // only when no dispatched op is still unacknowledged. Both arms
  // are gated on a real queue.items change — a pending-tick render
  // must not resolve trackFocusId against the pre-move order.
  useEffect(() => {
    if (seenItems.current === queue.items) {
      return;
    }
    seenItems.current = queue.items;
    const id = trackFocusId.current;
    if (id !== null) {
      trackFocusId.current = null;
      const index = queue.items.findIndex((item) => item.occurrenceId === id);
      if (index >= 0) {
        list.onRowFocus(index);
      }
    }
    if (
      !useAbsolute &&
      onMoveItem !== undefined &&
      pendingOps.current.length === 0 &&
      queuedOps.current.length > 0
    ) {
      const [head, ...rest] = queuedOps.current;
      queuedOps.current = rest;
      if (head !== undefined) {
        pendingOps.current = [...pendingOps.current, head];
        onMoveItem(head.id, head.dir);
      }
    }
  }, [queue.items, list, useAbsolute, onMoveItem]);
  if (queue.items.length === 0) {
    return <EmptyState title={t('queue.empty')} icon="queue" />;
  }
  const canReorder = onMoveItem !== undefined || onMoveItemTo !== undefined;
  const orderedIds = pendingIds.current ?? authIds;
  // Rows render in the optimistic order too, so the roving index and
  // DOM focus never index into different sequences mid-persist.
  const itemById = new Map(queue.items.map((item) => [item.occurrenceId, item]));
  const orderedItems = orderedIds.flatMap((id) => {
    const item = itemById.get(id);
    return item === undefined ? [] : [item];
  });
  const moveItem = (occurrenceId: string, direction: -1 | 1) => {
    const from = orderedIds.indexOf(occurrenceId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= orderedIds.length) {
      return;
    }
    const op: PendingMove = { id: occurrenceId, dir: direction };
    pendingIds.current = applyPendingMove(orderedIds, op);
    pendingSince.current = Date.now();
    // Ref-only updates are invisible to React: bump the pending tick
    // so the optimistic order paints even when onRowFocus no-ops and
    // the expiry timer re-arms against the new deadline.
    setPendingTick((tick) => tick + 1);
    if (useAbsolute) {
      // Absolute destinations carry the optimistic intent — the
      // caller applies them in order, no stale-index collapse.
      pendingOps.current = [...pendingOps.current, op];
      onMoveItemTo(occurrenceId, to);
    } else if (
      onMoveItem !== undefined &&
      pendingOps.current.length === 0 &&
      queuedOps.current.length === 0
    ) {
      pendingOps.current = [op];
      onMoveItem(occurrenceId, direction);
    } else {
      queuedOps.current = [...queuedOps.current, op];
    }
    // The moved row keeps DOM focus — point the roving index at its
    // destination so the next move or arrow press starts from it.
    trackFocusId.current = occurrenceId;
    list.onRowFocus(to);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      reordering &&
      canReorder &&
      event.altKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      const focusedId = orderedIds[list.focusIndex];
      if (focusedId !== undefined) {
        event.preventDefault();
        moveItem(focusedId, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
    }
    list.listProps.onKeyDown(event);
  };
  return (
    <div
      role="list"
      aria-label={t('queue.title')}
      className="uw-list"
      data-scroll={scrollEnabled ? 'true' : 'false'}
      onKeyDown={onKeyDown}
    >
      {orderedItems.map((item, index) => (
        <div key={item.occurrenceId}>
          {item.current && (
            <Text
              variant="label"
              color="accent"
              uppercase
              className="uw-now-playing-label"
            >
              {t('queue.nowPlaying')}
            </Text>
          )}
          <TrackRow
            row={item.row}
            badge={item.duplicate ? t('queue.badge.repeat') : null}
            reorderControls={reordering ? 'buttons' : 'none'}
            tabIndex={list.rowTabIndex(index)}
            onFocusRow={() => {
              trackFocusId.current = null;
              list.onRowFocus(index);
            }}
            onPress={
              reordering
                ? // Stay enabled + focusable in reorder mode — Alt+Arrow
                  // owns moves and list activation is already suppressed.
                  () => undefined
                : onPressItem === undefined
                  ? undefined
                  : () => onPressItem(item.occurrenceId)
            }
            onRemove={
              onRemoveItem === undefined || item.current || reordering
                ? undefined
                : () => onRemoveItem(item.occurrenceId)
            }
            onMoveUp={
              reordering && index > 0 && canReorder
                ? () => moveItem(item.occurrenceId, -1)
                : undefined
            }
            onMoveDown={
              reordering && index < queue.items.length - 1 && canReorder
                ? () => moveItem(item.occurrenceId, 1)
                : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}
