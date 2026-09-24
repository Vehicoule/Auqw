import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Artwork,
  EqBars,
  Icon,
  IconButton,
  Pressable,
  Text,
} from './primitives.tsx';
import { formatClock } from '@auqw/ui-shared';
import type { TrackRowModel } from '@auqw/ui-shared';
import { reconcileFocusIndex, rowKeyAction } from './keyboard.ts';

export type TrackRowProps = {
  readonly row: TrackRowModel;
  readonly badge?: string | null | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly onContext?: (() => void) | undefined;
  readonly reorderControls?: 'none' | 'drag' | 'buttons' | undefined;
  readonly onDragStart?: (() => void) | undefined;
  readonly onMoveUp?: (() => void) | undefined;
  readonly onMoveDown?: (() => void) | undefined;
  readonly onRemove?: (() => void) | undefined;
  /** Roving tabindex on the row's main action — the list owns it. */
  readonly tabIndex?: number | undefined;
  readonly onFocusRow?: (() => void) | undefined;
};

export function TrackRow({
  row,
  badge = null,
  onPress,
  onToggleLike,
  onContext,
  reorderControls = 'none',
  onDragStart,
  onMoveUp,
  onMoveDown,
  onRemove,
  tabIndex,
  onFocusRow,
}: TrackRowProps) {
  const unavailable = row.state !== 'available';
  const sub =
    row.note ??
    [badge, row.artist, row.versionLabel]
      .filter((part): part is string => part !== null && part !== '')
      .join(' · ');
  return (
    <div
      className="uw-track-row"
      data-state={row.state}
      data-playing={row.playing ? 'true' : undefined}
      data-liked={row.liked ? 'true' : undefined}
      data-download={row.download ?? undefined}
      role="listitem"
    >
      {reorderControls !== 'none' && (
        <div className="uw-track-row__reorder">
          {reorderControls === 'drag' ? (
            <button
              type="button"
              className="uw-track-row__grip"
              aria-label="drag to reorder"
              onMouseDown={onDragStart}
            >
              <Icon name="drag-handle" size={14} color="var(--text-secondary)" />
            </button>
          ) : (
            <div className="uw-track-row__chevrons">
              <IconButton
                icon="chevron-up"
                size={20}
                iconSize={10}
                ariaLabel="move up"
                onPress={onMoveUp}
              />
              <IconButton
                icon="chevron-down"
                size={20}
                iconSize={10}
                ariaLabel="move down"
                onPress={onMoveDown}
              />
            </div>
          )}
        </div>
      )}
      <Pressable
        onPress={onPress}
        onContextMenu={onContext === undefined ? undefined : () => onContext()}
        ariaLabel={`${row.title}${row.artist === null ? '' : `, ${row.artist}`}${unavailable ? ', unavailable' : ''}${row.playing ? ', playing' : ''}${row.liked ? ', liked' : ''}${row.download === null ? '' : `, download ${row.download === 'stored' ? 'complete' : row.download}`}`}
        ariaSelected={row.playing}
        className="uw-track-row__main"
        tabIndex={tabIndex}
        onFocus={onFocusRow}
      >
        <span className="uw-track-row__art">
          <Artwork url={row.artworkUrl} size={28} dimmed={unavailable} />
          {row.playing && (
            <span className="uw-track-row__eq">
              <EqBars size={10} />
            </span>
          )}
        </span>
        <span className="uw-track-row__text">
          <Text
            variant="body"
            color={row.playing ? 'accent' : unavailable ? 'secondary' : 'primary'}
            numberOfLines={1}
            className={row.playing ? 'uw-text--bold' : undefined}
          >
            {row.title}
          </Text>
          {sub !== '' && (
            <em className="uw-track-row__em">· {sub}</em>
          )}
        </span>
      </Pressable>
      <div className="uw-track-row__tail">
        <Text variant="metadata" color="secondary" numeric className="uw-track-row__clock">
          {formatClock(row.durationMs)}
        </Text>
        {row.download !== null && (
          <span
            className="uw-track-row__chip"
            data-chip={row.download}
            title={row.download === 'stored' ? 'downloaded' : `download ${row.download}`}
          >
            <Icon
              name={
                row.download === 'stored'
                  ? 'check'
                  : row.download === 'failed'
                    ? 'warn'
                    : 'download'
              }
              size={13}
              color={
                row.download === 'failed'
                  ? 'var(--warn)'
                  : row.download === 'stored'
                    ? 'var(--accent)'
                    : 'var(--text-secondary)'
              }
            />
          </span>
        )}
        {row.state !== 'available' && (
          <span className="uw-track-row__chip" title={row.state}>
            <Icon name="warn" size={14} color="var(--warn)" />
          </span>
        )}
        {row.liked && onToggleLike === undefined && (
          <span className="uw-track-row__chip" title="liked">
            <Icon name="heart-filled" size={13} color="var(--liked)" />
          </span>
        )}
        {onToggleLike !== undefined && (
          <IconButton
            icon={row.liked ? 'heart-filled' : 'heart'}
            size={26}
            iconSize={13}
            color={row.liked ? 'var(--liked)' : 'var(--text-secondary)'}
            ariaLabel={row.liked ? 'unlike' : 'like'}
            onPress={onToggleLike}
          />
        )}
        {onContext !== undefined && (
          <IconButton
            icon="list-plus"
            size={26}
            iconSize={13}
            color="var(--text-secondary)"
            ariaLabel="row actions"
            onPress={onContext}
            className="uw-track-row__menu"
          />
        )}
        {onRemove !== undefined && (
          <IconButton
            icon="close"
            size={26}
            iconSize={13}
            color="var(--text-secondary)"
            ariaLabel="remove from queue"
            onPress={onRemove}
          />
        )}
      </div>
    </div>
  );
}

// ---- roving-focus track lists ------------------------------------

export type TrackListController = {
  readonly focusIndex: number;
  readonly listProps: {
    readonly role: 'list';
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  };
  readonly rowTabIndex: (index: number) => number;
  readonly onRowFocus: (index: number) => void;
};

/**
 * Shared roving-focus controller for every track list (search results,
 * queue, collection rows, library rows). Arrow/Home/End move the
 * roving index and DOM focus follows; Enter/Space activates; the
 * ContextMenu key (and right-click) routes to onContext.
 */
export function useTrackList({
  count,
  onActivate,
  onContext,
}: {
  readonly count: number;
  readonly onActivate?: ((index: number) => void) | undefined;
  readonly onContext?: ((index: number) => void) | undefined;
}): TrackListController {
  const [rawFocusIndex, setFocusIndex] = useState(-1);
  // A shrunk list can strand the stored index past the end — reconcile
  // before any read so a surviving row always owns the Tab slot.
  const focusIndex = reconcileFocusIndex(rawFocusIndex, count);
  const listRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys the list owns belong to the row's main action only — nested
    // buttons (like, menu, chevrons) keep their own Enter/Space so a
    // bubbling keypress can't double-fire the row's play callback.
    const target = event.target;
    if (
      typeof HTMLElement === 'undefined' ||
      !(target instanceof HTMLElement) ||
      !target.classList.contains('uw-track-row__main')
    ) {
      return;
    }
    const action = rowKeyAction(event.key, focusIndex < 0 ? 0 : focusIndex, count);
    if (action === null) {
      return;
    }
    event.preventDefault();
    if (action.type === 'move') {
      setFocusIndex(action.index);
      listRef.current
        ?.querySelectorAll<HTMLElement>('.uw-track-row__main')
        [action.index]?.focus();
    } else if (action.type === 'activate') {
      onActivate?.(focusIndex < 0 ? 0 : focusIndex);
    } else if (action.type === 'context') {
      onContext?.(focusIndex < 0 ? 0 : focusIndex);
    }
  };
  return {
    focusIndex,
    listProps: {
      role: 'list',
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        listRef.current = event.currentTarget;
        onKeyDown(event);
      },
    },
    rowTabIndex: (index: number) => (focusIndex === -1 ? (index === 0 ? 0 : -1) : index === focusIndex ? 0 : -1),
    onRowFocus: (index: number) => setFocusIndex(index),
  };
}
