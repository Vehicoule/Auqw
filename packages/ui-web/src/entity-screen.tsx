import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  SkeletonRows,
  Spinner,
  Text,
} from './primitives.tsx';
import { TrackRow, indexAdapter, useTrackList } from './track-row.tsx';
import { EmptyState, ErrorState } from './states.tsx';
import type { EntityScreenModel } from '@auqw/ui-shared';
import {
  useEntityScreenController,
  type EntityPillView,
  type EntityScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type EntityScreenProps = EntityScreenHandlers & {
  readonly model: EntityScreenModel;
  readonly scrollEnabled?: boolean | undefined;
};

function HeaderPill({ view }: { readonly view: EntityPillView }) {
  const disabled = view.disabled ?? false;
  const accent = view.accent;
  return (
    <Pressable
      onPress={disabled ? undefined : view.onPress}
      disabled={disabled}
      ariaLabel={view.label}
      className={`uw-pill${accent ? ' uw-pill--accent' : ''}`}
    >
      <Icon
        name={view.icon}
        size={13}
        color={
          disabled
            ? 'var(--fg25)'
            : accent
              ? 'var(--canvas)'
              : 'var(--text-primary)'
        }
      />
      <Text
        variant="metadata"
        color={disabled ? 'secondary' : accent ? 'canvas' : 'primary'}
      >
        {view.label}
      </Text>
    </Pressable>
  );
}

function BackRow({
  a11yLabel,
  onBack,
}: {
  readonly a11yLabel: string;
  readonly onBack?: (() => void) | undefined;
}) {
  return (
    <div className="uw-back-row">
      <Pressable onPress={onBack} ariaLabel={a11yLabel} className="uw-back">
        <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
      </Pressable>
    </div>
  );
}

export function EntityScreen({
  model,
  scrollEnabled = true,
  onBack,
  ...handlers
}: EntityScreenProps) {
  const view = useEntityScreenController({ model, ...handlers });
  const items = model.phase === 'ready' ? model.items : [];
  const list = useTrackList({
    count: items.length,
    onActivate: indexAdapter(items, handlers.onPressItem),
    onContext: indexAdapter(items, handlers.onContext),
  });
  if (view.kind === 'loading') {
    return (
      <div className="uw-screen uw-entity">
        <BackRow a11yLabel={view.backA11yLabel} onBack={onBack} />
        <SkeletonRows count={8} label={view.title} />
      </div>
    );
  }
  if (view.kind === 'error') {
    return (
      <div className="uw-screen uw-entity">
        <BackRow a11yLabel={view.backA11yLabel} onBack={onBack} />
        <ErrorState
          title={view.title}
          hint={view.hint}
          onRetry={view.onRetry}
        />
      </div>
    );
  }
  return (
    <div
      className="uw-screen uw-entity"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <BackRow a11yLabel={view.backA11yLabel} onBack={onBack} />

      {/* Hero: centered artwork + title block, then the action pills. */}
      <div className="uw-entity__hero">
        <Artwork url={model.artworkUrl} size={160} />
        <Text
          variant="metadata"
          color="secondary"
          uppercase
          className="uw-entity__kind"
        >
          {view.kindLabel}
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
        <HeaderPill view={view.shuffle} />
        {/*
         * Like only binds to a materialized entity (canLike); an
         * unmaterialized page shows the heart disabled — an honest
         * absence, never a no-op.
         */}
        <IconButton
          icon={view.like.icon}
          size={34}
          iconSize={16}
          color={view.like.liked ? 'var(--liked)' : undefined}
          ariaLabel={view.like.a11yLabel}
          onPress={view.like.onPress}
        />
      </div>

      {/* Honesty flags: a partial page is never silently complete. */}
      {view.notice !== null && (
        <div className="uw-notice uw-notice--warn">
          <Icon name="warn" size={14} color="var(--warn)" />
          <Text variant="metadata" color="secondary">
            {view.notice.text}
          </Text>
        </div>
      )}

      {view.body.kind === 'empty' ? (
        <EmptyState
          title={view.body.title}
          hint={view.body.hint}
          icon={view.body.icon}
        />
      ) : (
        <div
          role="list"
          aria-label={view.body.listA11yLabel}
          className="uw-list"
          onKeyDown={list.onKeyDown}
        >
          {view.body.rows.map((item, index) => (
            <TrackRow
              key={item.row.key}
              row={item.row}
              tabIndex={list.rowTabIndex(index)}
              onFocusRow={() => list.onRowFocus(index)}
              onPress={item.onPress}
              onIntent={item.onIntent}
              onAddToPlaylist={item.onAddToPlaylist}
              onContext={item.onContext}
            />
          ))}
          {view.body.loadMore !== null && (
            <Pressable
              onPress={view.body.loadMore.onPress}
              ariaLabel={view.body.loadMore.a11yLabel}
              className="uw-load-more"
            >
              {view.body.loadMore.busy ? (
                <Spinner size={13} />
              ) : (
                <Icon
                  name="chevron-down"
                  size={13}
                  color="var(--text-secondary)"
                />
              )}
              <Text variant="metadata" color="secondary">
                {view.body.loadMore.label}
              </Text>
            </Pressable>
          )}
        </div>
      )}
    </div>
  );
}
