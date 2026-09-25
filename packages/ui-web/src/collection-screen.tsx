import { Icon, Pressable, Text } from './primitives.tsx';
import { TrackRow, useTrackList } from './track-row.tsx';
import { EmptyState } from './states.tsx';
import { t } from '@auqw/ui-shared';
import type { CollectionModel, CollectionRowModel, MessageId } from '@auqw/ui-shared';

export type CollectionScreenProps = {
  readonly model: CollectionModel;
  readonly scrollEnabled?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onPlayAll?: (() => void) | undefined;
  readonly onPressItem?: ((row: CollectionRowModel) => void) | undefined;
  readonly onToggleLike?: ((row: CollectionRowModel) => void) | undefined;
  readonly onContext?: ((row: CollectionRowModel) => void) | undefined;
};

// Hint ids resolve at render — never cache translated strings at
// module scope or they go stale on a locale switch.
const EMPTY_HINTS: Record<CollectionModel['key'], MessageId> = {
  liked: 'collection.emptyHint.liked',
  top50: 'collection.emptyHint.top50',
  history: 'collection.emptyHint.history',
  downloads: 'collection.emptyHint.downloads',
};

export function CollectionScreen({
  model,
  scrollEnabled = true,
  onBack,
  onPlayAll,
  onPressItem,
  onToggleLike,
  onContext,
}: CollectionScreenProps) {
  const list = useTrackList({
    count: model.rows.length,
    onActivate:
      onPressItem === undefined
        ? undefined
        : (index) => {
            const row = model.rows[index];
            if (row !== undefined) {
              onPressItem(row);
            }
          },
    onContext:
      onContext === undefined
        ? undefined
        : (index) => {
            const row = model.rows[index];
            if (row !== undefined) {
              onContext(row);
            }
          },
  });
  return (
    <div
      className="uw-screen uw-collection-screen"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-collection-screen__head">
        <Pressable onPress={onBack} ariaLabel={t('common.back')} className="uw-back">
          <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
        </Pressable>
        <Text variant="display" color="bright" className="uw-collection-screen__title">
          {model.title}
        </Text>
        <Text variant="metadata" color="secondary">
          {t('common.trackCount', { count: model.rows.length })}
        </Text>
        <Pressable
          onPress={model.rows.length === 0 ? undefined : onPlayAll}
          ariaLabel={t('collection.playAllA11y', { title: model.title })}
          className={`uw-playall${model.rows.length === 0 ? ' uw-off' : ''}`}
        >
          <Text
            variant="metadata"
            color={model.rows.length === 0 ? 'secondary' : 'accent'}
          >
            {t('collection.playAll')}
          </Text>
        </Pressable>
      </div>
      {model.rows.length === 0 ? (
        <EmptyState
          title={t('collection.empty', { title: model.title })}
          hint={t(EMPTY_HINTS[model.key])}
          icon={model.key === 'history' ? 'clock' : 'note'}
        />
      ) : (
        <div
          role="list"
          aria-label={model.title}
          className="uw-list"
          onKeyDown={list.listProps.onKeyDown}
        >
          {model.rows.map((item, index) => (
            <TrackRow
              key={item.key}
              row={item.row}
              badge={item.badge}
              tabIndex={list.rowTabIndex(index)}
              onFocusRow={() => list.onRowFocus(index)}
              onPress={
                onPressItem === undefined
                  ? undefined
                  : () => onPressItem(item)
              }
              onToggleLike={
                onToggleLike === undefined
                  ? undefined
                  : () => onToggleLike(item)
              }
              onContext={
                onContext === undefined ? undefined : () => onContext(item)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
