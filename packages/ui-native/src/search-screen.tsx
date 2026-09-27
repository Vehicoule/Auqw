import { FlatList, ScrollView, TextInput, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Spinner, Text } from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
} from './states.tsx';
import type { SearchStateModel, TrackRowModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

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
  /**
   * Keystroke completions for the live text — rendered whenever the
   * box's text differs from the committed `state.query`, so results
   * from an older search never impersonate matches for the draft.
   */
  readonly suggestions?: readonly string[] | undefined;
  readonly onSuggestionPress?: ((query: string) => void) | undefined;
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
  const loading = state.phase === 'loading';
  const editing = query ?? state.query;
  // Draft mode: the box carries text that was never committed as the
  // shown query — completions own the pane until submit.
  const draft = editing.trim() !== '' && editing.trim() !== state.query;
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
          placeholder={t('search.fieldLabel')}
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('search.fieldLabel')}
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
                accessibilityLabel={t('search.a11y.cancel')}
                style={{ paddingHorizontal: theme.spacing.xs }}
              >
                <Text variant="metadata" color="accent">
                  {t('common.cancel')}
                </Text>
              </Pressable>
            )}
          </>
        )}
        {!loading && editing !== '' && onQueryChange !== undefined && (
          <Pressable
            compact
            onPress={() => onQueryChange('')}
            accessibilityLabel={t('search.a11y.clear')}
            style={{ padding: theme.spacing.xs }}
          >
            <Icon name="close" size={12} color={theme.colors.textSecondary} />
          </Pressable>
        )}
      </View>
      {draft && (
        <ScrollView
          style={{ flex: 1 }}
          scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
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
            {t('search.suggestions')}
          </Text>
          <Pressable
            compact
            onPress={onSubmit}
            accessibilityLabel={t('search.a11y.suggestion', {
              query: editing.trim(),
            })}
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
            <Icon name="search" size={14} color={theme.colors.textSecondary} />
            <Text variant="body" color="primary" numberOfLines={1}>
              {t('search.commitQuery', { query: editing.trim() })}
            </Text>
          </Pressable>
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion}
              compact
              onPress={
                onSuggestionPress === undefined
                  ? undefined
                  : () => onSuggestionPress(suggestion)
              }
              accessibilityLabel={t('search.a11y.suggestion', {
                query: suggestion,
              })}
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
                name="search"
                size={14}
                color={theme.colors.textSecondary}
              />
              <Text variant="body" color="primary" numberOfLines={1}>
                {suggestion}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {!draft && state.phase === 'ready' && (
        <View
          style={{
            alignItems: 'flex-start',
            paddingHorizontal: theme.spacing.screen,
            marginBottom: theme.spacing.sm,
          }}
        >
          <Text variant="heading" color="bright">
            {t('search.results')}
          </Text>
          <Text
            variant="metadata"
            color="secondary"
            style={{ marginTop: theme.spacing.xxs }}
          >
            {t('search.resultsMeta', {
              provider: state.providerId ?? t('search.providerFallback'),
              count: state.results.length,
            })}
          </Text>
        </View>
      )}
      {!draft &&
        state.phase === 'idle' &&
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
              {t('search.recent')}
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
                accessibilityLabel={t('search.a11y.again', { query: recent })}
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
            title={t('search.emptyTitle')}
            hint={t('search.emptyHint')}
            icon="search"
          />
        ))}
      {!draft && state.phase === 'loading' && state.results.length === 0 && (
        <LoadingState title={t('search.loading')} hint={state.query} />
      )}
      {!draft && state.phase === 'empty' && (
        <EmptyState
          title={t('search.noResults', { query: state.query })}
          hint={t('search.noResultsHint')}
          icon="search"
        />
      )}
      {!draft && state.phase === 'error' && (
        <ErrorState
          title={t('search.failed')}
          hint={state.message}
          onRetry={state.retryable ? onRetry : undefined}
        />
      )}
      {!draft && state.phase === 'unavailable' && (
        <UnavailableState
          title={t('search.unavailableTitle')}
          hint={state.message}
        />
      )}
      {!draft &&
        (state.phase === 'ready' || state.phase === 'loading') &&
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
