import { FlatList, ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
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
  });
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
      {view.resultsHead !== null && (
        <View
          style={{
            alignItems: 'flex-start',
            paddingHorizontal: theme.spacing.screen,
            paddingTop: topInset,
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
          <SkeletonRows count={8} />
        ) : (
          <StateFor view={view.status} />
        ))}
      {view.results !== null && (
        <FlatList
          data={view.results.rows}
          keyExtractor={(row) => row.row.key}
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{
            // The pinned results head already reserves the inset; when it
            // is absent (loading with retained results) the list carries it.
            paddingTop: view.resultsHead !== null ? 0 : topInset,
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
        />
      )}
    </View>
  );
}
