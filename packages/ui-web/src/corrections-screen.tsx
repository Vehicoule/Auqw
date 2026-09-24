import { Icon, Pressable, Text } from './primitives.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import type {
  CorrectionsFilter,
  CorrectionsModel,
  ReviewRowModel,
} from '@auqw/ui-shared';

const FILTERS: readonly { value: CorrectionsFilter; label: string }[] = [
  { value: 'pending', label: 'pending' },
  { value: 'resolved', label: 'resolved' },
  { value: 'all', label: 'all' },
];

export type CorrectionsScreenProps = {
  readonly model: CorrectionsModel;
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
  scrollEnabled = true,
  onBack,
  onFilter,
  onConfirm,
  onReject,
  onUndo,
  onRetry,
}: CorrectionsScreenProps) {
  return (
    <div
      className="uw-screen uw-corrections"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-collection__head">
        <Pressable onPress={onBack} ariaLabel="back" className="uw-back">
          <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
        </Pressable>
        <Text variant="display" color="bright" className="uw-collection__title">
          corrections
        </Text>
        <Text variant="metadata" color="secondary">
          {model.pendingCount} pending · {model.resolvedCount} resolved
        </Text>
      </div>
      <div className="uw-corrections__filters" role="toolbar" aria-label="status filter">
        {FILTERS.map((filter) => (
          <Pressable
            key={filter.value}
            onPress={
              onFilter === undefined ? undefined : () => onFilter(filter.value)
            }
            ariaLabel={`show ${filter.label}`}
            ariaSelected={model.filter === filter.value}
            className={`uw-chip${model.filter === filter.value ? ' uw-chip--active' : ''}`}
          >
            <Text
              variant="metadata"
              color={model.filter === filter.value ? 'bright' : 'secondary'}
            >
              {filter.label}
            </Text>
          </Pressable>
        ))}
      </div>
      {model.state === 'loading' ? (
        <LoadingState title="loading reviews" />
      ) : model.state === 'error' ? (
        <ErrorState
          title="couldn't load reviews"
          hint={model.message}
          onRetry={onRetry}
        />
      ) : model.rows.length === 0 ? (
        <EmptyState
          title="nothing to review"
          hint={
            model.filter === 'pending'
              ? 'no match candidates are waiting on you'
              : 'no reviews in this filter'
          }
          icon="check"
        />
      ) : (
        <div role="list" aria-label="match reviews">
          {model.rows.map((row) => (
            <ReviewRow
              key={row.reviewId}
              row={row}
              onConfirm={onConfirm}
              onReject={onReject}
              onUndo={onUndo}
            />
          ))}
        </div>
      )}
    </div>
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
  const pending = row.status === 'pending';
  return (
    <div className="uw-review" role="listitem" data-status={row.status}>
      <div className="uw-review__head">
        <Text
          variant="body"
          color="bright"
          numberOfLines={1}
          className="uw-review__title"
        >
          {row.title}
        </Text>
        <Text variant="metadata" color={pending ? 'warn' : 'secondary'}>
          {row.statusLabel}
        </Text>
      </div>
      {row.artist === null ? null : (
        <Text variant="metadata" color="secondary" numberOfLines={1}>
          {row.artist}
        </Text>
      )}
      {row.candidates.map((candidate) => (
        <Pressable
          key={candidate.index}
          onPress={
            pending && onConfirm !== undefined
              ? () => onConfirm(row.reviewId, candidate.index)
              : undefined
          }
          disabled={!pending || onConfirm === undefined}
          ariaLabel={`confirm ${candidate.title}`}
          className={`uw-review__candidate${pending ? '' : ' uw-off'}`}
        >
          {pending && (
            <Icon
              name="chevron-right"
              size={12}
              color="var(--text-secondary)"
            />
          )}
          <span className="uw-review__candidate-text">
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
          </span>
        </Pressable>
      ))}
      <div className="uw-review__actions">
        {pending ? (
          <Pressable
            onPress={
              onReject === undefined ? undefined : () => onReject(row.reviewId)
            }
            ariaLabel={`reject ${row.title}`}
            className="uw-review__action"
          >
            <Text variant="metadata" color="warn">
              reject all
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={
              onUndo === undefined ? undefined : () => onUndo(row.reviewId)
            }
            ariaLabel={`undo ${row.title}`}
            className="uw-review__action"
          >
            <Text variant="metadata" color="primary">
              undo
            </Text>
          </Pressable>
        )}
      </div>
    </div>
  );
}
