import { useContext } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { NavFootprintContext } from './platform-tabs.tsx';
import { Icon, Pressable, SkeletonRows, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState, StateFor } from './states.tsx';
import type { SearchStateModel } from '@auqw/ui-shared';
import {
  useSearchScreenController,
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
  });
  const navPad = useContext(NavFootprintContext);
  // Chips + results head scroll with the rows — pinned siblings each
  // juggling the top inset clipped under the floating field.
  const resultHeader = (
    <>
      {view.filters !== null && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityLabel={view.filters.a11yLabel}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{
            gap: theme.spacing.xs,
            paddingHorizontal: theme.spacing.sm,
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
      )}
      {view.resultsHead !== null && (
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
      )}
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
      {view.results === null &&
        (view.filters !== null || view.resultsHead !== null) && (
          <View
            style={{
              paddingTop: topInset,
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
      {view.results !== null && (
        <FlatList
          data={view.results.rows}
          keyExtractor={(row) => row.row.key}
          scrollEnabled={scrollEnabled}
          ListHeaderComponent={resultHeader}
          contentContainerStyle={{
            paddingTop: topInset,
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
        />
      )}
    </View>
  );
}
