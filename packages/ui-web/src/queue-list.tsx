import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { useTrackList } from './track-row.tsx';
import type { QueueItemModel, QueueModel } from '@auqw/ui-shared';

// ---- optimistic reorder bookkeeping ----------------------------------

export type PendingMove = { readonly id: string; readonly dir: -1 | 1 };

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
  const list = useTrackList({
    count: queue.items.length,
    onActivate:
      onPressItem === undefined || reordering
        ? undefined
        : (index) => {
            const item = queue.items[index];
            if (item !== undefined) {
              onPressItem(item.occurrenceId);
            }
          },
    onContext: undefined,
  });
  // Optimistic reorder bookkeeping: queue.items is controlled by the
  // caller, so each dispatched move is kept as a pending op. Publishes
  // acknowledge the ops in order — a partial publish keeps the tail,
  // an incompatible update rebases the whole pending state.
  const pendingOps = useRef<readonly PendingMove[]>([]);
  const pendingIds = useRef<readonly string[] | null>(null);
  const lastAuthIds = useRef<readonly string[] | null>(null);
  const trackFocusId = useRef<string | null>(null);
  const authIds = queue.items.map((item) => item.occurrenceId);
  if (lastAuthIds.current === null) {
    lastAuthIds.current = authIds;
  } else if (pendingIds.current !== null) {
    const res = reconcilePendingOps(lastAuthIds.current, pendingOps.current, authIds);
    if (res === null) {
      pendingOps.current = [];
      pendingIds.current = null;
    } else {
      pendingOps.current = res.ops;
      pendingIds.current = res.ops.length === 0 ? null : res.ids;
    }
    lastAuthIds.current = authIds;
  } else if (!idsEqual(lastAuthIds.current, authIds)) {
    lastAuthIds.current = authIds;
  }
  // Focus follows the moved row through publishes: once the
  // authoritative order lands, point the roving index at it again.
  useEffect(() => {
    const id = trackFocusId.current;
    if (id === null) {
      return;
    }
    trackFocusId.current = null;
    const index = queue.items.findIndex((item) => item.occurrenceId === id);
    if (index >= 0) {
      list.onRowFocus(index);
    }
  }, [queue.items, list]);
  if (queue.items.length === 0) {
    return <EmptyState title="queue is empty" icon="queue" />;
  }
  const canReorder = onMoveItem !== undefined || onMoveItemTo !== undefined;
  const orderedIds = pendingIds.current ?? authIds;
  const moveItem = (occurrenceId: string, direction: -1 | 1) => {
    const from = orderedIds.indexOf(occurrenceId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= orderedIds.length) {
      return;
    }
    const op: PendingMove = { id: occurrenceId, dir: direction };
    pendingOps.current = [...pendingOps.current, op];
    pendingIds.current = applyPendingMove(orderedIds, op);
    if (onMoveItem !== undefined) {
      onMoveItem(occurrenceId, direction);
    } else {
      onMoveItemTo?.(occurrenceId, to);
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
      aria-label="queue"
      className="uw-list"
      data-scroll={scrollEnabled ? 'true' : 'false'}
      onKeyDown={onKeyDown}
    >
      {queue.items.map((item, index) => (
        <div key={item.occurrenceId}>
          {item.current && (
            <Text
              variant="label"
              color="accent"
              uppercase
              className="uw-now-playing-label"
            >
              now playing
            </Text>
          )}
          <TrackRow
            row={item.row}
            badge={item.duplicate ? 'repeat' : null}
            reorderControls={reordering ? 'buttons' : 'none'}
            tabIndex={list.rowTabIndex(index)}
            onFocusRow={() => {
              trackFocusId.current = null;
              list.onRowFocus(index);
            }}
            onPress={
              onPressItem === undefined || reordering
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
