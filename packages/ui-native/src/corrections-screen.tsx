import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { BackRow, Icon, PillButton, Pressable, Text } from './primitives.tsx';
import { StateFor } from './states.tsx';
import type { CorrectionsModel } from '@auqw/ui-shared';
import {
  useCorrectionsScreenController,
  type CorrectionsRowView,
  type CorrectionsScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type CorrectionsScreenProps = CorrectionsScreenHandlers & {
  readonly model: CorrectionsModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
};

/**
 * The management surface for `MatchReview` rows — correction, not
 * consumption: status filters, candidate pickers, confirm / reject /
 * undo, pending + resolved counts. A row with no candidates only
 * offers reject (there is nothing to confirm); resolved rows only
 * offer undo.
 */
export function CorrectionsScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onBack,
  onFilter,
  onConfirm,
  onReject,
  onUndo,
  onRetry,
}: CorrectionsScreenProps) {
  const theme = useTheme();
  const view = useCorrectionsScreenController({
    model,
    onFilter,
    onConfirm,
    onReject,
    onUndo,
    onRetry,
  });
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingTop: topInset + theme.spacing.sm,
      }}
    >
      <BackRow onPress={onBack} accessibilityLabel={view.backA11yLabel}>
        <Text variant="display" color="bright" style={{ flex: 1 }}>
          {view.title}
        </Text>
        <Text variant="metadata" color="secondary">
          {view.countsLabel}
        </Text>
      </BackRow>
      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          marginBottom: theme.spacing.xs,
        }}
      >
        {view.filters.map((filter) => (
          <Pressable
            key={filter.value}
            compact
            onPress={filter.onPress}
            accessibilityLabel={filter.a11yLabel}
            accessibilityState={{ selected: filter.selected }}
            style={{
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs,
              borderRadius: theme.radius.pill,
              borderWidth: filter.selected ? theme.strokes.hairline : 0,
              borderColor: theme.colors.hairline,
            }}
          >
            <Text
              variant="metadata"
              color={filter.selected ? 'bright' : 'secondary'}
            >
              {filter.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {view.body.kind !== 'rows' ? (
        <StateFor view={view.body} />
      ) : (
        <ScrollView
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
        >
          {view.body.rows.map((row) => (
            <ReviewRow key={row.row.reviewId} view={row} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function ReviewRow({ view }: { readonly view: CorrectionsRowView }) {
  const theme = useTheme();
  const { row, pending } = view;
  return (
    <View
      style={{
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.sm,
        borderBottomWidth: theme.strokes.hairline,
        borderBottomColor: theme.colors.fg08,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Text
          variant="body"
          color="bright"
          numberOfLines={1}
          style={{ flex: 1 }}
        >
          {row.title}
        </Text>
        <Text variant="metadata" color={view.statusColor}>
          {row.statusLabel}
        </Text>
      </View>
      {row.artist === null ? null : (
        <Text
          variant="metadata"
          color="secondary"
          numberOfLines={1}
          style={{ marginTop: 3 }}
        >
          {row.artist}
        </Text>
      )}
      {view.candidates.map((candidate) => (
        <Pressable
          key={candidate.index}
          compact
          onPress={candidate.onPress}
          disabled={!candidate.enabled}
          accessibilityLabel={candidate.a11yLabel}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
              marginTop: theme.spacing.xs,
              paddingVertical: theme.spacing.xs,
              paddingHorizontal: theme.spacing.sm,
              borderRadius: theme.radius.control,
              opacity: pending ? 1 : 0.6,
            },
            pressed && pending && { backgroundColor: theme.colors.fg08 },
          ]}
        >
          {pending && (
            <Icon
              name="chevron-right"
              size={12}
              color={theme.colors.textSecondary}
            />
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              variant="metadata"
              color={pending ? 'primary' : 'secondary'}
              numberOfLines={1}
            >
              {candidate.title}
            </Text>
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {candidate.subtitle}
            </Text>
          </View>
        </Pressable>
      ))}
      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.md,
          marginTop: theme.spacing.xs,
        }}
      >
        <PillButton
          label={view.action.label}
          tone={view.action.kind === 'reject' ? 'warn' : 'outline'}
          minHeight={26}
          onPress={view.action.onPress}
          accessibilityLabel={view.action.a11yLabel}
        />
      </View>
    </View>
  );
}
