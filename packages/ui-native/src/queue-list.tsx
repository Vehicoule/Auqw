import type { ReactNode } from 'react';
import { useRef } from 'react';
import { FlatList, View } from 'react-native';
import type { ViewToken } from 'react-native';
import { useTheme } from './theme.tsx';
import { Pressable, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import type { QueueItemModel, QueueModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';
import { queueSectionLabel } from '@auqw/ui-shared/controllers';

/** Section-header + repeat-badge chrome shared by both QueueList variants. */
export function QueueRowChrome({
  item,
  sectionStart,
  sectionHeading,
  clear,
  children,
}: {
  readonly item: QueueItemModel;
  readonly sectionStart: boolean;
  /** The model's localized section header — falls back to the key's base label. */
  readonly sectionHeading?: string | undefined;
  /**
   * Section-scoped Clear — the up-next header carries it; the ids the
   * caller pre-bound are that section's items.
   */
  readonly clear?:
    | { readonly label: string; readonly onPress: () => void }
    | undefined;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View>
      {sectionStart && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            paddingHorizontal: theme.spacing.sm,
            gap: theme.spacing.sm,
          }}
        >
          <Text
            variant="label"
            color={item.section === 'nowPlaying' ? 'accent' : 'secondary'}
            style={{ marginBottom: 2 }}
            uppercase
          >
            {sectionHeading ?? queueSectionLabel(item.section)}
          </Text>
          {clear !== undefined && (
            <Pressable
              onPress={clear.onPress}
              accessibilityRole="button"
              accessibilityLabel={clear.label}
              compact
              feedback="opacity"
            >
              <Text variant="label" color="secondary">
                {clear.label}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {item.duplicate && (
        <View
          style={{
            alignSelf: 'flex-start',
            marginHorizontal: theme.spacing.sm,
            marginTop: theme.spacing.xs,
            paddingHorizontal: theme.spacing.sm,
            borderRadius: theme.radius.pill,
            borderWidth: theme.strokes.hairline,
            borderColor: theme.colors.hairline,
          }}
        >
          <Text variant="label" color="secondary" uppercase>
            {t('queue.badge.repeat')}
          </Text>
        </View>
      )}
      {/* Radio suggestions sit one step dimmer than user-minted rows. */}
      <View style={{ opacity: item.section === 'autoplay' ? 0.75 : 1 }}>
        {children}
      </View>
    </View>
  );
}

// Shared fallback (web/desktop + any platform without gesture-handler):
// reorder uses paired chevron controls; the native variant swaps this
// whole list for DraggableFlatList + drag handles.
export type QueueListProps = {
  readonly queue: QueueModel;
  readonly reordering?: boolean | undefined;
  readonly scrollEnabled?: boolean | undefined;
  /** Bottom inset inside the scroll content — the stage's floating
      mode segment overlays this zone; the pad lets the last row
      scroll fully clear of it. */
  readonly contentPaddingBottom?: number | undefined;
  readonly onPressItem?: ((occurrenceId: string) => void) | undefined;
  /** Advisory row intent — touch-down on a row; the caller warms it. */
  readonly onRowIntent?: ((occurrenceId: string) => void) | undefined;
  /** Advisory viewport report — the occurrence ids currently on
      screen (display order, nowPlaying excluded — it is already
      playing, a warm would mint dead bytes). The caller warms the
      set as a wholesale hand. */
  readonly onViewportRows?:
  | ((occurrenceIds: readonly string[]) => void)
  | undefined;
  readonly onRemoveItem?: ((occurrenceId: string) => void) | undefined;
  readonly onMoveItem?:
  | ((occurrenceId: string, direction: -1 | 1) => void)
  | undefined;
  readonly onMoveItemTo?:
  | ((occurrenceId: string, toIndex: number) => void)
  | undefined;
  /**
   * Up-next section Clear — that header's action; the list hands the
   * section's occurrence ids for a batch remove.
   */
  readonly onClearUpcoming?:
    | ((occurrenceIds: readonly string[]) => void)
    | undefined;
};

export function QueueList({
  queue,
  reordering = false,
  scrollEnabled = true,
  contentPaddingBottom = 0,
  onPressItem,
  onRowIntent,
  onViewportRows,
  onRemoveItem,
  onMoveItem,
  onMoveItemTo,
  onClearUpcoming,
}: QueueListProps) {
  // FlatList requires a stable onViewableItemsChanged — rebind it
  // per render and the list throws, so the latest callback lives in
  // a ref the stable callback reads through.
  const viewportRows = useRef(onViewportRows);
  viewportRows.current = onViewportRows;
  const viewableChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const ids = viewableItems
        .map((token) => token.item as QueueItemModel)
        .filter((item) => item.section !== 'nowPlaying')
        .map((item) => item.occurrenceId);
      viewportRows.current?.(ids);
    },
  );
  if (queue.items.length === 0) {
    return (
      <EmptyState
        title={t('queue.empty')}
        hint={t('queue.emptyHint')}
        icon="queue"
      />
    );
  }
  // Display order (nowPlaying → upNext → history) is the order the
  // session's move contract indexes — under shuffle it is the dealt
  // walk, so display slots, not canonical `item.index`, drive moves.
  const items = queue.sections.flatMap((section) => section.items);
  const sectionByKey = new Map(queue.sections.map((s) => [s.key, s]));
  const upNextIds =
    sectionByKey.get('upNext')?.items.map((item) => item.occurrenceId) ?? [];
  const canMove = onMoveItem !== undefined || onMoveItemTo !== undefined;
  const move = (item: QueueItemModel, from: number, neighborIndex: number) => {
    const neighbor = items[neighborIndex];
    if (
      item.section !== 'upNext' ||
      neighbor === undefined ||
      neighbor.section !== 'upNext'
    ) {
      return;
    }
    const direction: -1 | 1 = neighborIndex < from ? -1 : 1;
    if (onMoveItem !== undefined) {
      onMoveItem(item.occurrenceId, direction);
    } else {
      onMoveItemTo?.(item.occurrenceId, neighborIndex);
    }
  };
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.occurrenceId}
      scrollEnabled={scrollEnabled}
      initialNumToRender={15}
      onViewableItemsChanged={viewableChanged.current}
      contentContainerStyle={{ paddingBottom: contentPaddingBottom }}
      renderItem={({ item, index }) => (
        <QueueRowChrome
          item={item}
          sectionStart={items[index - 1]?.section !== item.section}
          sectionHeading={sectionByKey.get(item.section)?.heading}
          clear={
            item.section === 'upNext' &&
            onClearUpcoming !== undefined &&
            !reordering
              ? {
                  label: t('queue.clearSection'),
                  onPress: () => onClearUpcoming(upNextIds),
                }
              : undefined
          }
        >
          <TrackRow
            row={item.row}
            reorderControls={reordering ? 'buttons' : 'none'}
            onPress={
              onPressItem === undefined || reordering
                ? undefined
                : () => onPressItem(item.occurrenceId)
            }
            onIntent={
              onRowIntent === undefined
                ? undefined
                : () => onRowIntent(item.occurrenceId)
            }
            onRemove={
              onRemoveItem === undefined ||
              item.current ||
              reordering ||
              item.section === 'autoplay'
                ? undefined
                : () => onRemoveItem(item.occurrenceId)
            }
            onMoveUp={
              reordering && canMove &&
              item.section === 'upNext' &&
              items[index - 1]?.section === 'upNext'
                ? () => move(item, index, index - 1)
                : undefined
            }
            onMoveDown={
              reordering && canMove &&
              item.section === 'upNext' &&
              items[index + 1]?.section === 'upNext'
                ? () => move(item, index, index + 1)
                : undefined
            }
          />
        </QueueRowChrome>
      )}
    />
  );
}
