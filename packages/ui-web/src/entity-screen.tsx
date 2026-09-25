import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { TrackRow, useTrackList } from './track-row.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import { t } from '@auqw/ui-shared';
import type { EntityScreenModel, TrackRowModel } from '@auqw/ui-shared';

export type EntityScreenProps = {
  readonly model: EntityScreenModel;
  readonly scrollEnabled?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onPlayAll?: (() => void) | undefined;
  readonly onShuffleAll?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly onPressItem?: ((row: TrackRowModel) => void) | undefined;
  readonly onContext?: ((row: TrackRowModel) => void) | undefined;
  readonly onLoadMore?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
};

function HeaderPill({
  label,
  icon,
  accent = false,
  disabled = false,
  onPress,
}: {
  readonly label: string;
  readonly icon: IconName;
  readonly accent?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onPress?: (() => void) | undefined;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      ariaLabel={label}
      className={`uw-pill${accent ? ' uw-pill--accent' : ''}`}
    >
      <Icon
        name={icon}
        size={13}
        color={
          disabled
            ? 'var(--fg25)'
            : accent
              ? 'var(--accent)'
              : 'var(--text-primary)'
        }
      />
      <Text
        variant="metadata"
        color={disabled ? 'secondary' : accent ? 'accent' : 'primary'}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function BackRow({ onBack }: { readonly onBack?: (() => void) | undefined }) {
  return (
    <div className="uw-back-row">
      <Pressable onPress={onBack} ariaLabel={t('common.back')} className="uw-back">
        <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
      </Pressable>
    </div>
  );
}

export function EntityScreen({
  model,
  scrollEnabled = true,
  onBack,
  onPlayAll,
  onShuffleAll,
  onToggleLike,
  onPressItem,
  onContext,
  onLoadMore,
  onRetry,
}: EntityScreenProps) {
  const items = model.phase === 'ready' ? model.items : [];
  const list = useTrackList({
    count: items.length,
    onActivate:
      onPressItem === undefined
        ? undefined
        : (index) => {
            const row = items[index];
            if (row !== undefined) {
              onPressItem(row);
            }
          },
    onContext:
      onContext === undefined
        ? undefined
        : (index) => {
            const row = items[index];
            if (row !== undefined) {
              onContext(row);
            }
          },
  });
  if (model.phase === 'loading') {
    return (
      <div className="uw-screen uw-entity">
        <BackRow onBack={onBack} />
        <LoadingState title={t('state.loading')} />
      </div>
    );
  }
  if (model.phase === 'error') {
    return (
      <div className="uw-screen uw-entity">
        <BackRow onBack={onBack} />
        <ErrorState
          title={t('entity.errorTitle')}
          hint={model.message}
          onRetry={onRetry}
        />
      </div>
    );
  }
  return (
    <div
      className="uw-screen uw-entity"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <BackRow onBack={onBack} />

      {/* Hero: centered artwork + title block, then the action pills. */}
      <div className="uw-entity__hero">
        <Artwork url={model.artworkUrl} size={160} />
        <Text
          variant="metadata"
          color="secondary"
          uppercase
          className="uw-entity__kind"
        >
          {model.kind === null ? t('entity.kind.fallback') : t(`entity.kind.${model.kind}`)}
        </Text>
        <Text variant="heading" color="bright" numberOfLines={2}>
          {model.title}
        </Text>
        {model.subtitle !== null && (
          <Text variant="metadata" color="secondary" numberOfLines={1}>
            {model.subtitle}
          </Text>
        )}
      </div>

      <div className="uw-entity__actions">
        <HeaderPill
          label={t('common.play')}
          icon="play"
          accent
          disabled={model.items.length === 0}
          onPress={onPlayAll}
        />
        <HeaderPill
          label={t('entity.shuffle')}
          icon="shuffle"
          disabled={model.items.length === 0}
          onPress={onShuffleAll}
        />
        {/*
         * Like only binds to a materialized entity (canLike); an
         * unmaterialized page shows the heart disabled — an honest
         * absence, never a no-op.
         */}
        <IconButton
          icon={model.liked ? 'heart-filled' : 'heart'}
          size={34}
          iconSize={16}
          color={model.liked ? 'var(--liked)' : undefined}
          ariaLabel={model.liked ? t('common.unlike') : t('common.like')}
          onPress={model.canLike ? onToggleLike : undefined}
        />
      </div>

      {/* Honesty flags: a partial page is never silently complete. */}
      {(!model.complete || model.message !== null) && (
        <div className="uw-notice uw-notice--warn">
          <Icon name="warn" size={14} color="var(--warn)" />
          <Text variant="metadata" color="secondary">
            {model.message ?? t('entity.partial')}
          </Text>
        </div>
      )}

      {model.items.length === 0 ? (
        <EmptyState
          title={t('entity.empty')}
          hint={t('entity.emptyHint')}
          icon="note"
        />
      ) : (
        <div
          role="list"
          aria-label={model.title ?? undefined}
          className="uw-list"
          onKeyDown={list.listProps.onKeyDown}
        >
          {items.map((item, index) => (
            <TrackRow
              key={item.key}
              row={item}
              tabIndex={list.rowTabIndex(index)}
              onFocusRow={() => list.onRowFocus(index)}
              onPress={
                onPressItem === undefined ? undefined : () => onPressItem(item)
              }
              onContext={
                onContext === undefined ? undefined : () => onContext(item)
              }
            />
          ))}
          {model.hasMore && (
            <Pressable
              onPress={model.loadingMore ? undefined : onLoadMore}
              ariaLabel={t('entity.loadMore')}
              className="uw-load-more"
            >
              {model.loadingMore ? (
                <Spinner size={13} />
              ) : (
                <Icon
                  name="chevron-down"
                  size={13}
                  color="var(--text-secondary)"
                />
              )}
              <Text variant="metadata" color="secondary">
                {model.loadingMore ? t('state.loading') : t('entity.loadMore')}
              </Text>
            </Pressable>
          )}
        </div>
      )}
    </div>
  );
}
