import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import type { EntityScreenModel, TrackRowModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';
import type { IconName } from './primitives.tsx';

export type EntityScreenProps = {
  readonly model: EntityScreenModel;
  readonly topInset?: number | undefined;
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
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={disabled ? undefined : onPress}
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        minHeight: 34,
        flex: 1,
        borderRadius: theme.radius.pill,
        backgroundColor: accent
          ? theme.colors.accentSoft
          : theme.colors.fg08,
      }}
    >
      <Icon
        name={icon}
        size={13}
        color={disabled
          ? theme.colors.fg25
          : accent
            ? theme.colors.accent
            : theme.colors.textPrimary}
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
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.spacing.lg,
        marginBottom: theme.spacing.sm,
      }}
    >
      <Pressable
        compact
        onPress={onBack}
        accessibilityLabel={t('common.back')}
        style={{ padding: theme.spacing.xs }}
      >
        <Icon
          name="chevron-left"
          size={16}
          color={theme.colors.textSecondary}
        />
      </Pressable>
    </View>
  );
}

export function EntityScreen({
  model,
  topInset = 0,
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
  const theme = useTheme();
  if (model.phase === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.canvas,
          paddingTop: topInset + theme.spacing.sm,
        }}
      >
        <BackRow onBack={onBack} />
        <LoadingState title={t('state.loading')} />
      </View>
    );
  }
  if (model.phase === 'error') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.canvas,
          paddingTop: topInset + theme.spacing.sm,
        }}
      >
        <BackRow onBack={onBack} />
        <ErrorState
          title={t('entity.errorTitle')}
          hint={model.message}
          onRetry={onRetry}
        />
      </View>
    );
  }
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingTop: topInset + theme.spacing.sm,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: theme.spacing.lg,
        }}
      >
        <Pressable
          compact
          onPress={onBack}
          accessibilityLabel={t('common.back')}
          style={{ padding: theme.spacing.xs }}
        >
          <Icon
            name="chevron-left"
            size={16}
            color={theme.colors.textSecondary}
          />
        </Pressable>
      </View>

      {/* Hero: centered artwork + title block, then the action pills. */}
      <View style={{ alignItems: 'center', paddingHorizontal: theme.spacing.xl }}>
        <Artwork url={model.artworkUrl} size={160} />
        <Text
          variant="metadata"
          color="secondary"
          uppercase
          style={{ marginTop: theme.spacing.md }}
        >
          {model.kind === null ? t('entity.kind.fallback') : t(`entity.kind.${model.kind}`)}
        </Text>
        <Text
          variant="heading"
          color="bright"
          numberOfLines={2}
          style={{ textAlign: 'center' }}
        >
          {model.title}
        </Text>
        {model.subtitle !== null && (
          <Text
            variant="metadata"
            color="secondary"
            numberOfLines={1}
            style={{ marginTop: 2 }}
          >
            {model.subtitle}
          </Text>
        )}
      </View>

      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.sm,
          marginHorizontal: theme.spacing.lg,
          marginTop: theme.spacing.md,
        }}
      >
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
          color={model.liked ? theme.colors.liked : undefined}
          accessibilityLabel={
            model.liked ? t('common.unlike') : t('common.like')
          }
          onPress={model.canLike ? onToggleLike : undefined}
        />
      </View>

      {/* Honesty flags: a partial page is never silently complete. */}
      {(!model.complete || model.message !== null) && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            marginHorizontal: theme.spacing.lg,
            marginTop: theme.spacing.md,
            padding: theme.spacing.md,
            borderRadius: theme.radius.control,
            borderWidth: theme.strokes.hairline,
            borderColor: theme.colors.warn,
          }}
        >
          <Icon name="warn" size={14} color={theme.colors.warn} />
          <Text variant="metadata" color="secondary" style={{ flex: 1 }}>
            {model.message ?? t('entity.partial')}
          </Text>
        </View>
      )}

      {model.items.length === 0 ? (
        <EmptyState
          title={t('entity.empty')}
          hint={t('entity.emptyHint')}
          icon="note"
        />
      ) : (
        <FlatList
          data={model.items}
          keyExtractor={(row) => row.key}
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.sm,
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.xxl,
          }}
          renderItem={({ item }) => (
            <TrackRow
              row={item}
              onPress={
                onPressItem === undefined ? undefined : () => onPressItem(item)
              }
              onContext={
                onContext === undefined ? undefined : () => onContext(item)
              }
            />
          )}
          ListFooterComponent={
            model.hasMore ? (
              <Pressable
                onPress={model.loadingMore ? undefined : onLoadMore}
                accessibilityLabel={t('entity.loadMore')}
                accessibilityState={{ busy: model.loadingMore }}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: theme.spacing.sm,
                    minHeight: theme.sizes.touch,
                    marginTop: theme.spacing.sm,
                    borderRadius: theme.radius.control,
                    borderWidth: theme.strokes.hairline,
                    borderColor: theme.colors.hairline,
                  },
                  pressed && { backgroundColor: theme.colors.fg08 },
                ]}
              >
                {model.loadingMore ? (
                  <Spinner size={13} />
                ) : (
                  <Icon
                    name="chevron-down"
                    size={13}
                    color={theme.colors.textSecondary}
                  />
                )}
                <Text variant="metadata" color="secondary">
                  {model.loadingMore ? t('state.loading') : t('entity.loadMore')}
                </Text>
              </Pressable>
            ) : null
          }
        />
      )}
    </View>
  );
}
