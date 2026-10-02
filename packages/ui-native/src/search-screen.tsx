import { useContext } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { NavFootprintContext } from './platform-tabs.tsx';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  SkeletonRows,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EntityRail } from './entity-rail.tsx';
import { EmptyState, StateFor } from './states.tsx';
import type { SearchStateModel } from '@auqw/ui-shared';
import {
  useSearchScreenController,
  type SearchHeroView,
  type SearchScreenHandlers,
} from '@auqw/ui-shared/controllers';

function IconRow({
  icon,
  label,
  a11yLabel,
  onPress,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly a11yLabel: string;
  readonly onPress?: (() => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={a11yLabel}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          minHeight: theme.sizes.touch,
          paddingHorizontal: theme.spacing.screen,
          borderRadius: theme.radius.control,
        },
        pressed && { backgroundColor: theme.colors.fg08 },
      ]}
    >
      <Icon name={icon} size={14} color={theme.colors.textSecondary} />
      <Text variant="body" color="primary" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: (() => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={{
        minHeight: 30,
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.control,
        borderWidth: theme.strokes.hairline,
        borderColor: active ? theme.colors.accent : theme.colors.hairline,
        backgroundColor: active ? theme.colors.accentSoft : 'transparent',
      }}
    >
      <Text variant="metadata" color={active ? 'accent' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );
}

// The top-hit card — a track plays straight off the hero; an entity
// opens its page, with a like heart when the card is materialized.
function SearchHero({ hero }: { readonly hero: SearchHeroView }) {
  const theme = useTheme();
  const isEntity = hero.type === 'entity';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        marginHorizontal: theme.spacing.sm,
        marginTop: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radius.card,
        borderWidth: theme.strokes.hairline,
        borderColor: theme.colors.hairline,
        backgroundColor: theme.colors.raised,
      }}
    >
      <Pressable
        compact
        onPress={hero.onPress}
        accessibilityLabel={hero.a11yLabel}
        style={({ pressed }) => [
          {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
          },
          pressed && { opacity: 0.75 },
        ]}
      >
        <Artwork
          url={
            isEntity ? hero.card.artworkUrl : hero.row.artworkUrl
          }
          size={56}
          cornerRadius={
            isEntity && hero.card.kind === 'artist' ? 28 : undefined
          }
          dimmed={!isEntity && hero.row.state !== 'available'}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="title" color="bright" numberOfLines={2}>
            {isEntity ? hero.card.title : hero.row.title}
          </Text>
          <Text variant="metadata" color="secondary" numberOfLines={1}>
            {hero.metaLabel}
          </Text>
        </View>
      </Pressable>
      {isEntity ? (
        <>
          {hero.onToggleLike !== undefined && (
            <IconButton
              icon={hero.card.liked ? 'heart-filled' : 'heart'}
              size={34}
              iconSize={16}
              color={hero.card.liked ? theme.colors.liked : undefined}
              accessibilityLabel={hero.likeA11yLabel}
              onPress={hero.onToggleLike}
            />
          )}
          <IconButton
            icon="chevron-right"
            size={34}
            iconSize={16}
            accessibilityLabel={hero.a11yLabel}
            onPress={hero.onPress}
          />
        </>
      ) : (
        <IconButton
          icon="play"
          size={40}
          iconSize={18}
          color={theme.colors.accent}
          accessibilityLabel={hero.a11yLabel}
          onPress={hero.onPress}
          style={{
            backgroundColor: theme.colors.accentSoft,
            borderRadius: theme.radius.pill,
          }}
        />
      )}
    </View>
  );
}

export type SearchScreenProps = SearchScreenHandlers & {
  readonly state: SearchStateModel;
  /**
   * The live editing text for the input — `state.query` is the
   * *submitted* query (what the hints quote), which can never carry
   * keystrokes back to the box. Falls back to `state.query` so static
   * fixtures still render filled.
   */
  readonly query?: string | undefined;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  /** Submitted queries, newest first — rendered on the idle phase. */
  readonly recents?: readonly string[] | undefined;
  /**
   * Keystroke completions for the live text — rendered whenever the
   * box's text differs from the committed `state.query`, so results
   * from an older search never impersonate matches for the draft.
   */
  readonly suggestions?: readonly string[] | undefined;
};

export function SearchScreen({
  state,
  query,
  topInset = 0,
  scrollEnabled = true,
  onQueryChange,
  onSubmit,
  onCancel,
  onRetry,
  onResultPress,
  onToggleLike,
  onContext,
  recents = [],
  onRecentPress,
  suggestions = [],
  onSuggestionPress,
  onFilterPress,
  onEntityCardPress,
  onEntityCardLike,
  onLoadMore,
}: SearchScreenProps) {
  const theme = useTheme();
  const view = useSearchScreenController({
    state,
    query,
    onQueryChange,
    onSubmit,
    onCancel,
    onRetry,
    onResultPress,
    onToggleLike,
    onContext,
    recents,
    onRecentPress,
    suggestions,
    onSuggestionPress,
    onFilterPress,
    onEntityCardPress,
    onEntityCardLike,
    onLoadMore,
  });
  const navPad = useContext(NavFootprintContext);
  // Chips stay pinned above the list (the explore contract); the
  // heading rides inside it. The pinned row carries the inset on its
  // wrapper — padding inside the horizontal scroller was what clipped
  // the chips under the floating field on device.
  const resultHeader =
    view.resultsHead === null ? null : (
      <View
        style={{
          alignItems: 'flex-start',
          paddingHorizontal: theme.spacing.sm,
          marginBottom: theme.spacing.sm,
        }}
      >
        <Text variant="heading" color="bright">
          {view.resultsHead.title}
        </Text>
        <Text
          variant="metadata"
          color="secondary"
          style={{ marginTop: theme.spacing.xxs }}
        >
          {view.resultsHead.metaLabel}
        </Text>
      </View>
    );
  // Hero + entity rails ride the results scroller; when a page is
  // entities-only (no track rows) the rails get their own scroller.
  const discovery =
    view.topRow === null && view.rails.length === 0 ? null : (
      <>
        {view.topRow !== null && <SearchHero hero={view.topRow.hero} />}
        {view.rails.map((rail) => (
          <EntityRail key={rail.key} rail={rail} />
        ))}
      </>
    );
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
      }}
    >
      {/* The one search field is the floating loupe (SearchFab) —
          the screen keeps recents, completions, and results only.
          Edge-to-edge: the inset lives inside each scroller's content
          so rows glide under the status-bar fade; pinned blocks carry
          it as plain padding. */}
      {view.suggestions !== null && (
        <ScrollView
          style={{ flex: 1 }}
          scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: topInset,
            // Clears the floating miniplayer's strip.
            paddingBottom:
              theme.spacing.xxl + theme.sizes.miniPlayer + theme.spacing.md + navPad,
          }}
        >
          <Text
            variant="label"
            color="secondary"
            uppercase
            style={{
              paddingHorizontal: theme.spacing.screen,
              marginBottom: theme.spacing.xs,
            }}
          >
            {view.suggestions.heading}
          </Text>
          <IconRow
            icon="search"
            label={view.suggestions.commit.label}
            a11yLabel={view.suggestions.commit.a11yLabel}
            onPress={view.suggestions.commit.onPress}
          />
          {view.suggestions.items.map((suggestion) => (
            <IconRow
              key={suggestion.label}
              icon="search"
              label={suggestion.label}
              a11yLabel={suggestion.a11yLabel}
              onPress={suggestion.onPress}
            />
          ))}
        </ScrollView>
      )}
      {view.filters !== null && (
        <View style={{ paddingTop: topInset }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityLabel={view.filters.a11yLabel}
            style={{ flexGrow: 0 }}
            contentContainerStyle={{
              gap: theme.spacing.xs,
              paddingHorizontal: theme.spacing.screen,
              paddingBottom: theme.spacing.sm,
            }}
          >
            {view.filters.chips.map((chip) => (
              <FilterChip
                key={chip.key}
                label={chip.label}
                active={chip.active}
                onPress={chip.onPress}
              />
            ))}
          </ScrollView>
        </View>
      )}
      {view.results === null && view.resultsHead !== null && (
        <View
          style={{
            paddingTop: view.filters !== null ? 0 : topInset,
            paddingHorizontal: theme.spacing.screen - theme.spacing.sm,
          }}
        >
          {resultHeader}
        </View>
      )}
      {view.idle !== null &&
        (view.idle.kind === 'recents' ? (
          <View style={{ paddingTop: topInset }}>
            <Text
              variant="label"
              color="secondary"
              uppercase
              style={{
                paddingHorizontal: theme.spacing.screen,
                marginBottom: theme.spacing.xs,
              }}
            >
              {view.idle.heading}
            </Text>
            {view.idle.items.map((recent) => (
              <IconRow
                key={recent.label}
                icon="clock"
                label={recent.label}
                a11yLabel={recent.a11yLabel}
                onPress={recent.onPress}
              />
            ))}
          </View>
        ) : (
          <EmptyState
            title={view.idle.title}
            hint={view.idle.hint}
            icon={view.idle.icon}
          />
        ))}
      {view.status !== null &&
        (view.status.kind === 'loading' ? (
          <SkeletonRows
            count={8}
            label={
              view.status.hint
                ? `${view.status.title} · ${view.status.hint}`
                : view.status.title
            }
            style={{ paddingTop: topInset }}
          />
        ) : (
          <StateFor view={view.status} />
        ))}
      {view.results === null && discovery !== null && (
        <ScrollView
          style={{ flex: 1 }}
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{
            paddingTop:
              view.resultsHead !== null || view.filters !== null
                ? 0
                : topInset,
            paddingBottom:
              theme.spacing.xxl + theme.sizes.miniPlayer + theme.spacing.md + navPad,
          }}
        >
          {discovery}
        </ScrollView>
      )}
      {view.results !== null && (
        <FlatList
          data={view.results.rows}
          keyExtractor={(row) => row.row.key}
          scrollEnabled={scrollEnabled}
          ListHeaderComponent={
            <>
              {discovery}
              {resultHeader}
            </>
          }
          contentContainerStyle={{
            // The pinned chips row owns the inset when present.
            paddingTop: view.filters !== null ? 0 : topInset,
            paddingHorizontal: theme.spacing.screen - theme.spacing.sm,
            // Clears the floating miniplayer's strip.
            paddingBottom:
              theme.spacing.xxl + theme.sizes.miniPlayer + theme.spacing.md + navPad,
          }}
          renderItem={({ item }) => (
            <TrackRow
              row={item.row}
              onPress={item.onPress}
              onIntent={item.onIntent}
              onToggleLike={item.onToggleLike}
              onContext={item.onContext}
            />
          )}
          ListFooterComponent={
            view.loadMore !== null ? (
              <Pressable
                compact
                onPress={view.loadMore.onPress}
                accessibilityLabel={view.loadMore.a11yLabel}
                accessibilityState={{ busy: view.loadMore.busy }}
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
                {view.loadMore.busy ? (
                  <Spinner size={13} />
                ) : (
                  <Icon
                    name="chevron-down"
                    size={13}
                    color={theme.colors.textSecondary}
                  />
                )}
                <Text variant="metadata" color="secondary">
                  {view.loadMore.label}
                </Text>
              </Pressable>
            ) : null
          }
        />
      )}
    </View>
  );
}
