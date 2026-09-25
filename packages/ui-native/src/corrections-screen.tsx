import React from 'react';
import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Text } from './primitives.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import type {
  CorrectionsFilter,
  CorrectionsModel,
  MessageId,
  ReviewRowModel,
} from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

const FILTERS: readonly { value: CorrectionsFilter; label: MessageId }[] = [
  { value: 'pending', label: 'corrections.filter.pending' },
  { value: 'resolved', label: 'corrections.filter.resolved' },
  { value: 'all', label: 'corrections.filter.all' },
];

export type CorrectionsScreenProps = {
  readonly model: CorrectionsModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onFilter?: ((filter: CorrectionsFilter) => void) | undefined;
  readonly onConfirm?:
  | ((reviewId: string, candidateIndex: number) => void)
  | undefined;
  readonly onReject?: ((reviewId: string) => void) | undefined;
  readonly onUndo?: ((reviewId: string) => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
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
          gap: theme.spacing.sm,
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
        <Text variant="display" color="bright" style={{ flex: 1 }}>
          {t('corrections.title')}
        </Text>
        <Text variant="metadata" color="secondary">
          {t('corrections.counts', {
            pending: model.pendingCount,
            resolved: model.resolvedCount,
          })}
        </Text>
      </View>
      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          marginBottom: theme.spacing.xs,
        }}
      >
        {FILTERS.map((filter) => (
          <Pressable
            key={filter.value}
            compact
            onPress={
              onFilter === undefined ? undefined : () => onFilter(filter.value)
            }
            accessibilityLabel={t('corrections.filterA11y', {
              label: t(filter.label),
            })}
            accessibilityState={{ selected: model.filter === filter.value }}
            style={{
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs,
              borderRadius: theme.radius.pill,
              borderWidth:
                model.filter === filter.value ? theme.strokes.hairline : 0,
              borderColor: theme.colors.hairline,
            }}
          >
            <Text
              variant="metadata"
              color={model.filter === filter.value ? 'bright' : 'secondary'}
            >
              {t(filter.label)}
            </Text>
          </Pressable>
        ))}
      </View>
      {model.state === 'loading' ? (
        <LoadingState title={t('corrections.loading')} />
      ) : model.state === 'error' ? (
        <ErrorState
          title={t('corrections.errorTitle')}
          hint={model.message}
          onRetry={onRetry}
        />
      ) : model.rows.length === 0 ? (
        <EmptyState
          title={t('corrections.empty')}
          hint={
            model.filter === 'pending'
              ? t('corrections.emptyHint.pending')
              : t('corrections.emptyHint.other')
          }
          icon="check"
        />
      ) : (
        <ScrollView
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
        >
          {model.rows.map((row) => (
            <ReviewRow
              key={row.reviewId}
              row={row}
              onConfirm={onConfirm}
              onReject={onReject}
              onUndo={onUndo}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function ReviewRow({
  row,
  onConfirm,
  onReject,
  onUndo,
}: {
  readonly row: ReviewRowModel;
  readonly onConfirm?:
  | ((reviewId: string, candidateIndex: number) => void)
  | undefined;
  readonly onReject?: ((reviewId: string) => void) | undefined;
  readonly onUndo?: ((reviewId: string) => void) | undefined;
}) {
  const theme = useTheme();
  const pending = row.status === 'pending';
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
        <Text variant="metadata" color={pending ? 'warn' : 'secondary'}>
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
      {row.candidates.map((candidate) => (
        <Pressable
          key={candidate.index}
          compact
          onPress={
            pending && onConfirm !== undefined
              ? () => onConfirm(row.reviewId, candidate.index)
              : undefined
          }
          disabled={!pending || onConfirm === undefined}
          accessibilityLabel={t('corrections.a11y.confirm', {
            title: candidate.title,
          })}
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
        {pending ? (
          <Pressable
            compact
            onPress={
              onReject === undefined ? undefined : () => onReject(row.reviewId)
            }
            accessibilityLabel={t('corrections.a11y.reject', {
              title: row.title,
            })}
            style={{
              paddingHorizontal: theme.spacing.md,
              minHeight: 26,
              justifyContent: 'center',
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.fg08,
            }}
          >
            <Text variant="metadata" color="warn">
              {t('corrections.rejectAll')}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            compact
            onPress={
              onUndo === undefined ? undefined : () => onUndo(row.reviewId)
            }
            accessibilityLabel={t('corrections.a11y.undo', { title: row.title })}
            style={{
              paddingHorizontal: theme.spacing.md,
              minHeight: 26,
              justifyContent: 'center',
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.fg08,
            }}
          >
            <Text variant="metadata" color="primary">
              {t('corrections.undo')}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
