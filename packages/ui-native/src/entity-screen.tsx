import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  BackButton,
  Icon,
  IconButton,
  PillButton,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState, StateFor } from './states.tsx';
import type { EntityScreenModel } from '@auqw/ui-shared';
import {
  useEntityScreenController,
  type EntityPillView,
  type EntityScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type EntityScreenProps = EntityScreenHandlers & {
  readonly model: EntityScreenModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
};

function HeaderPill({ view }: { readonly view: EntityPillView }) {
  return (
    <PillButton
      label={view.label}
      icon={view.icon}
      tone={view.accent ? 'accent' : 'outline'}
      disabled={view.disabled ?? false}
      onPress={view.onPress}
      minHeight={34}
      style={{ flex: 1 }}
    />
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
  const view = useEntityScreenController({
    model,
    onPlayAll,
    onShuffleAll,
    onToggleLike,
    onPressItem,
    onContext,
    onLoadMore,
    onRetry,
  });
  if (view.kind !== 'ready') {
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
            marginBottom: theme.spacing.sm,
          }}
        >
          <BackButton
            onPress={onBack}
            accessibilityLabel={view.backA11yLabel}
          />
        </View>
        <StateFor view={view} />
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
        <BackButton
          onPress={onBack}
          accessibilityLabel={view.backA11yLabel}
        />
      </View>

      {/* Hero: centered artwork + title block, then the action pills. */}
      <View
        style={{ alignItems: 'center', paddingHorizontal: theme.spacing.xl }}
      >
        <Artwork url={model.artworkUrl} size={160} />
        <Text
          variant="metadata"
          color="secondary"
          uppercase
          style={{ marginTop: theme.spacing.md }}
        >
          {view.kindLabel}
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
        <HeaderPill view={view.play} />
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
          color={view.like.liked ? theme.colors.liked : undefined}
          accessibilityLabel={view.like.a11yLabel}
          onPress={view.like.onPress}
        />
      </View>

      {/* Honesty flags: a partial page is never silently complete. */}
      {view.notice !== null && (
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
            {view.notice.text}
          </Text>
        </View>
      )}

      {view.body.kind === 'empty' ? (
        <EmptyState
          title={view.body.title}
          hint={view.body.hint}
          icon={view.body.icon}
        />
      ) : (
        <FlatList
          data={view.body.rows}
          keyExtractor={(item) => item.row.key}
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.sm,
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.xxl,
          }}
          renderItem={({ item }) => (
            <TrackRow
              row={item.row}
              onPress={item.onPress}
              onContext={item.onContext}
            />
          )}
          ListFooterComponent={
            view.body.loadMore !== null ? (
              <Pressable
                onPress={view.body.loadMore.onPress}
                accessibilityLabel={view.body.loadMore.a11yLabel}
                accessibilityState={{ busy: view.body.loadMore.busy }}
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
                {view.body.loadMore.busy ? (
                  <Spinner size={13} />
                ) : (
                  <Icon
                    name="chevron-down"
                    size={13}
                    color={theme.colors.textSecondary}
                  />
                )}
                <Text variant="metadata" color="secondary">
                  {view.body.loadMore.label}
                </Text>
              </Pressable>
            ) : null
          }
        />
      )}
    </View>
  );
}
