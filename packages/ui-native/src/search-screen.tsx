import { FlatList, ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
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
import { SEARCH_FAB_RESERVE } from './search-fab.tsx';
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

// The paging control — shared by the track list footer and the
// entities-only scroller so both branches page identically.
function LoadMoreRow({
  control,
}: {
  readonly control: {
    readonly busy: boolean;
    readonly label: string;
    readonly a11yLabel: string;
    readonly onPress?: (() => void) | undefined;
  };
}) {
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={control.onPress}
      accessibilityLabel={control.a11yLabel}
      accessibilityState={{ busy: control.busy }}
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
      {control.busy ? (
        <Spinner size={13} />
      ) : (
        <Icon name="chevron-down" size={13} color={theme.colors.textSecondary} />
      )}
      <Text variant="metadata" color="secondary">
        {control.label}
      </Text>
    </Pressable>
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
  /** The system top inset — the screen adds the floating loupe's
   *  reserve itself where content must clear it. */
  readonly topInset?: number | undefined;
  /**
   * Whether the floating search field is expanded. Pinned rows drop
   * below it while open (it spans the width), hug the inset when it
   * is collapsed back to the loupe.
   */
  readonly fabOpen?: boolean | undefined;
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
  fabOpen = false,
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
  // Chips stay pinned above the list (the explore contract); the
  // heading rides inside it. Pinned rows hug the raw inset — the
  // collapsed loupe only overlays the row's right edge, cleared by
  // the scroller's right padding; the expanded field spans the full
  // width, so pinned rows drop the full reserve below it while open.
  // Scrollables carry the reserve inside their content — it scrolls
  // away instead of sitting dead above the viewport.
  const fabInset = topInset + SEARCH_FAB_RESERVE;
  const pinnedTop = fabOpen === true ? fabInset : topInset;
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
  // Hero + songs band + entity rails ride the results scroller; when
  // a page is entities-only (no track rows) the rails get their own
  // scroller. The band leads like the web layout — songs were the
  // buried result type under a full-width hero and three rails.
  const discovery =
    view.topRow === null && view.rails.length === 0 ? null : (
      <>
        {view.topRow !== null && <SearchHero hero={view.topRow.hero} />}
        {view.topRow !== null && view.topRow.songs.length > 0 && (
          <>
            <Text
              variant="heading"
              color="bright"
              style={{
                paddingHorizontal: theme.spacing.sm,
                marginTop: theme.spacing.md,
                marginBottom: theme.spacing.xs,
              }}
            >
              {view.topRow.songsTitle}
            </Text>
            {view.topRow.songs.map((row) => (
              <TrackRow
                key={row.row.key}
                row={row.row}
                onPress={row.onPress}
                onIntent={row.onIntent}
                onToggleLike={row.onToggleLike}
                onContext={row.onContext}
              />
            ))}
          </>
        )}
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
            paddingTop: fabInset,
            // Clears the floating miniplayer's strip.
            paddingBottom:
              theme.spacing.xxl + theme.sizes.miniPlayer + theme.spacing.md,
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
        <View
          style={{
            // Pinned like the other chrome: drops below the field
            // while it is open, hugs the inset when it collapses.
            paddingTop: pinnedTop,
            // The floating loupe overlays this band's right edge —
            // clipping the viewport here keeps chips from sliding
            // under it at any scroll position.
            paddingRight: theme.spacing.screen + SEARCH_FAB_RESERVE,
          }}
        >
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
            paddingTop: view.filters !== null ? 0 : pinnedTop,
            paddingHorizontal: theme.spacing.screen - theme.spacing.sm,
          }}
        >
          {resultHeader}
        </View>
      )}
      {view.idle !== null &&
        (view.idle.kind === 'recents' ? (
          <View style={{ paddingTop: pinnedTop }}>
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
            // Pinned like the other chrome — hugging the raw inset
            // when the field is collapsed keeps the rows out of the
            // dead band the scrollables reserve for the loupe.
            style={{ paddingTop: pinnedTop }}
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
                : fabInset,
            paddingBottom:
              theme.spacing.xxl + theme.sizes.miniPlayer + theme.spacing.md,
          }}
        >
          {discovery}
          {view.loadMore !== null && <LoadMoreRow control={view.loadMore} />}
        </ScrollView>
      )}
      {view.results !== null && (
        <FlatList
          // The songs band leads with the same first rows — partition
          // by key so they don't double up under 'all results' (the
          // full result model is untouched: counts, paging and the
          // play context all still see every row).
          data={view.results.rows.filter(
            (row) =>
              !(view.topRow?.songs.some(
                (song) => song.row.key === row.row.key,
              ) ?? false),
          )}
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
            paddingTop: view.filters !== null ? 0 : fabInset,
            paddingHorizontal: theme.spacing.screen - theme.spacing.sm,
            // Clears the floating miniplayer's strip.
            paddingBottom:
              theme.spacing.xxl + theme.sizes.miniPlayer + theme.spacing.md,
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
              <LoadMoreRow control={view.loadMore} />
            ) : null
          }
        />
      )}
    </View>
  );
}
