import { FlatList, TextInput, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Spinner, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
} from './states.tsx';
import type { SearchStateModel, TrackRowModel } from './view-models.ts';

export type SearchScreenProps = {
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
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onResultPress?: ((row: TrackRowModel) => void) | undefined;
  readonly onToggleLike?: ((row: TrackRowModel) => void) | undefined;
  readonly onContext?: ((row: TrackRowModel) => void) | undefined;
  /** Submitted queries, newest first — rendered on the idle phase. */
  readonly recents?: readonly string[] | undefined;
  readonly onRecentPress?: ((query: string) => void) | undefined;
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
}: SearchScreenProps) {
  const theme = useTheme();
  const loading = state.phase === 'loading';
  const editing = query ?? state.query;
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingTop: topInset,
      }}
    >
      <View
        style={{
          marginHorizontal: theme.spacing.screen,
          marginTop: theme.spacing.xxs,
          marginBottom: 10,
          backgroundColor: theme.colors.fg08,
          borderRadius: 20,
          paddingHorizontal: 11,
          minHeight: theme.sizes.touch,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Icon name="search" size={14} color={theme.colors.textSecondary} />
        <TextInput
          value={query ?? state.query}
          onChangeText={onQueryChange}
          onSubmitEditing={onSubmit}
          placeholder="search"
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="search"
          style={[
            theme.typography.body,
            {
              flex: 1,
              color: theme.colors.textPrimary,
              paddingVertical: theme.spacing.sm,
            },
          ]}
        />
        {loading && (
          <>
            <Spinner size={14} />
            {onCancel !== undefined && (
              <Pressable
                compact
                onPress={onCancel}
                accessibilityLabel="cancel search"
                style={{ paddingHorizontal: theme.spacing.xs }}
              >
                <Text variant="metadata" color="accent">
                  cancel
                </Text>
              </Pressable>
            )}
          </>
        )}
        {!loading && editing !== '' && onQueryChange !== undefined && (
          <Pressable
            compact
            onPress={() => onQueryChange('')}
            accessibilityLabel="clear search"
            style={{ padding: theme.spacing.xs }}
          >
            <Icon name="close" size={12} color={theme.colors.textSecondary} />
          </Pressable>
        )}
      </View>
      {state.phase === 'ready' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            paddingHorizontal: theme.spacing.screen,
            marginBottom: theme.spacing.sm,
          }}
        >
          <Text variant="heading" color="bright">
            results
          </Text>
          <Text
            variant="metadata"
            color="secondary"
            style={{ marginLeft: 10 }}
          >
            {state.providerId ?? 'catalog'} · {state.results.length} matches
          </Text>
        </View>
      )}
      {state.phase === 'idle' &&
        (recents.length > 0 ? (
          <View>
            <Text
              variant="label"
              color="secondary"
              uppercase
              style={{
                paddingHorizontal: theme.spacing.screen,
                marginBottom: theme.spacing.xs,
              }}
            >
              recent searches
            </Text>
            {recents.map((recent) => (
              <Pressable
                key={recent}
                compact
                onPress={
                  onRecentPress === undefined
                    ? undefined
                    : () => onRecentPress(recent)
                }
                accessibilityLabel={`search again for ${recent}`}
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
                <Icon
                  name="clock"
                  size={14}
                  color={theme.colors.textSecondary}
                />
                <Text variant="body" color="primary" numberOfLines={1}>
                  {recent}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <EmptyState
            title="search the catalog"
            hint="results show up here"
            icon="search"
          />
        ))}
      {state.phase === 'loading' && state.results.length === 0 && (
        <LoadingState title="searching" hint={state.query} />
      )}
      {state.phase === 'empty' && (
        <EmptyState
          title={`no results for “${state.query}”`}
          hint="try a different search"
          icon="search"
        />
      )}
      {state.phase === 'error' && (
        <ErrorState
          title="search failed"
          hint={state.message}
          onRetry={state.retryable ? onRetry : undefined}
        />
      )}
      {state.phase === 'unavailable' && (
        <UnavailableState
          title="search unavailable"
          hint={state.message}
        />
      )}
      {(state.phase === 'ready' || state.phase === 'loading') &&
        state.results.length > 0 && (
          <FlatList
            data={state.results}
            keyExtractor={(row) => row.key}
            scrollEnabled={scrollEnabled}
            contentContainerStyle={{ paddingHorizontal: 6 }}
            renderItem={({ item }) => (
              <TrackRow
                row={item}
                onPress={
                  onResultPress === undefined
                    ? undefined
                    : () => onResultPress(item)
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
            )}
          />
        )}
    </View>
  );
}
