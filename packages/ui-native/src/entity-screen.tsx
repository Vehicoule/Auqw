import {
  FlatList,
  Image,
  PixelRatio,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg';
import { useResolvedArtworkUri } from './artwork.tsx';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  BackButton,
  Icon,
  IconButton,
  PillButton,
  Pressable,
  SkeletonRows,
  Spinner,
  Text,
} from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EntityRail } from './entity-rail.tsx';
import { EmptyState, StateFor } from './states.tsx';
import type { EntityScreenModel } from '@auqw/ui-shared';
import { useLatestCallback, useStableRows } from '@auqw/ui-shared';
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

/** Blurred artwork wash behind the hero — resolved through the
 *  artwork cache like every other surface (a screen-wide scaled
 *  variant, not the provider's full-size URL), decode-time blur like
 *  the stage backdrop, and an Svg gradient fading it into the canvas
 *  before the tracklist. Absent while resolution is pending. */
function HeroBackdrop({ url }: { readonly url: string }) {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const { uri, markSourceError } = useResolvedArtworkUri(
    url,
    Math.ceil(windowWidth * PixelRatio.get()),
  );
  if (uri === null) {
    return null;
  }
  return (
    <>
      <Image
        source={{ uri }}
        blurRadius={40}
        style={[StyleSheet.absoluteFill, { opacity: 0.3 }]}
        resizeMode="cover"
        onError={markSourceError}
        accessibilityIgnoresInvertColors
      />
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id="uw-entity-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop
              offset="0"
              stopColor={theme.colors.canvas}
              stopOpacity="0"
            />
            <Stop
              offset="0.95"
              stopColor={theme.colors.canvas}
              stopOpacity="1"
            />
          </LinearGradient>
        </Defs>
        <Rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="url(#uw-entity-fade)"
        />
      </Svg>
    </>
  );
}

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
  onRowIntent,
  onContext,
  onLoadMore,
  onRetry,
  onEntityCardPress,
  onEntityCardLike,
}: EntityScreenProps) {
  const theme = useTheme();
  // Handlers bound into retained rows/cards go through ref-trampolines:
  // a stale wrapper then still calls the latest prop (e.g. a press
  // handler re-keyed on connectivity), never its own era's closure.
  const pressItem = useLatestCallback(onPressItem);
  const rowIntent = useLatestCallback(onRowIntent);
  const rowContext = useLatestCallback(onContext);
  const cardPress = useLatestCallback(onEntityCardPress);
  const cardLike = useLatestCallback(onEntityCardLike);
  const view = useEntityScreenController({
    model,
    onPlayAll,
    onShuffleAll,
    onToggleLike,
    onPressItem: pressItem,
    onRowIntent: rowIntent,
    onContext: rowContext,
    onLoadMore,
    onRetry,
    onEntityCardPress: cardPress,
    onEntityCardLike: cardLike,
  });
  // The controller re-maps view rows every render — serving the
  // previous array while the wrapped items are unchanged keeps the
  // list's `data` identical between playback ticks (fresh refs re-arm
  // VirtualizedList's batched cell-update setState — the update-depth
  // storm chain).
  const bodyRows = useStableRows(
    view.kind === 'ready' && view.body.kind === 'rows'
      ? view.body.rows
      : [],
    (item) => item.row,
  );
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
        {view.kind === 'loading' ? (
          <SkeletonRows count={8} label={view.title} />
        ) : (
          <StateFor view={view} />
        )}
      </View>
    );
  }
  // The whole hero — artwork, title block, pills, honesty flags —
  // rides the tracklist's header so a scroll carries it away instead
  // of pinning most of the screen.
  const header = (
    <>
      <View
        style={{
          alignItems: 'center',
          paddingHorizontal: theme.spacing.xl,
          overflow: 'hidden',
        }}
      >
        {/* Pure decoration — absent entirely when the page has no
            cover. */}
        {model.artworkUrl !== null && (
          <HeroBackdrop url={model.artworkUrl} />
        )}
        {/* Artist pages conventionally round the portrait; album and
            playlist covers stay square. */}
        <Artwork
          url={model.artworkUrl}
          size={160}
          cornerRadius={model.kind === 'artist' ? 80 : undefined}
        />
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
            style={{ marginTop: theme.spacing.xxs }}
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
    </>
  );

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

      {view.body.kind === 'empty' ? (
        <ScrollView
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{
            // flexGrow keeps the empty state centered when the hero
            // is short, scrolls the whole block when it overflows.
            flexGrow: 1,
            paddingHorizontal: theme.spacing.sm,
            paddingBottom:
              theme.spacing.xxl +
              theme.sizes.miniPlayer +
              theme.spacing.md,
          }}
        >
          {header}
          <EmptyState
            title={view.body.title}
            hint={view.body.hint}
            icon={view.body.icon}
          />
        </ScrollView>
      ) : (
        <FlatList
          data={bodyRows}
          keyExtractor={(item) => item.row.key}
          scrollEnabled={scrollEnabled}
          ListHeaderComponent={header}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.sm,
            paddingTop: theme.spacing.md,
            paddingBottom:
              theme.spacing.xxl +
              theme.sizes.miniPlayer +
              theme.spacing.md,
          }}
          renderItem={({ item }) => (
            <TrackRow
              row={item.row}
              onPress={item.onPress}
              onIntent={item.onIntent}
              onContext={item.onContext}
            />
          )}
          ListFooterComponent={
            <>
              {view.body.loadMore !== null && (
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
              )}
              {view.rails.map((rail) => (
                <EntityRail key={rail.key} rail={rail} />
              ))}
            </>
          }
        />
      )}
    </View>
  );
}
