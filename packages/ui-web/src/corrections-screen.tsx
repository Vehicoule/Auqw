import { Icon, Pressable, Text } from './primitives.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import type { CorrectionsModel } from '@auqw/ui-shared';
import {
  useCorrectionsScreenController,
  type CorrectionsRowView,
  type CorrectionsScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type CorrectionsScreenProps = CorrectionsScreenHandlers & {
  readonly model: CorrectionsModel;
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
  scrollEnabled = true,
  onBack,
  onFilter,
  onConfirm,
  onReject,
  onUndo,
  onRetry,
}: CorrectionsScreenProps) {
  const view = useCorrectionsScreenController({
    model,
    onFilter,
    onConfirm,
    onReject,
    onUndo,
    onRetry,
  });
  return (
    <div
      className="uw-screen uw-corrections"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-collection__head">
        <Pressable
          onPress={onBack}
          ariaLabel={view.backA11yLabel}
          className="uw-back"
        >
          <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
        </Pressable>
        <Text variant="display" color="bright" className="uw-collection__title">
          {view.title}
        </Text>
        <Text variant="metadata" color="secondary">
          {view.countsLabel}
        </Text>
      </div>
      <div
        className="uw-corrections__filters"
        role="toolbar"
        aria-label={view.filtersA11yLabel}
      >
        {view.filters.map((filter) => (
          <Pressable
            key={filter.value}
            onPress={filter.onPress}
            ariaLabel={filter.a11yLabel}
            ariaSelected={filter.selected}
            className={`uw-chip${filter.selected ? ' uw-chip--active' : ''}`}
          >
            <Text
              variant="metadata"
              color={filter.selected ? 'bright' : 'secondary'}
            >
              {filter.label}
            </Text>
          </Pressable>
        ))}
      </div>
      {view.body.kind === 'loading' ? (
        <LoadingState title={view.body.title} />
      ) : view.body.kind === 'error' ? (
        <ErrorState
          title={view.body.title}
          hint={view.body.hint}
          onRetry={view.body.onRetry}
        />
      ) : view.body.kind === 'empty' ? (
        <EmptyState
          title={view.body.title}
          hint={view.body.hint}
          icon={view.body.icon}
        />
      ) : (
        <div role="list" aria-label={view.body.listA11yLabel}>
          {view.body.rows.map((row) => (
            <ReviewRow key={row.row.reviewId} view={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewRow({ view }: { readonly view: CorrectionsRowView }) {
  const { row, pending } = view;
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
        <Text variant="metadata" color={view.statusColor}>
          {row.statusLabel}
        </Text>
      </div>
      {row.artist === null ? null : (
        <Text variant="metadata" color="secondary" numberOfLines={1}>
          {row.artist}
        </Text>
      )}
      {view.candidates.map((candidate) => (
        <Pressable
          key={candidate.index}
          onPress={candidate.onPress}
          disabled={!candidate.enabled}
          ariaLabel={candidate.a11yLabel}
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
        <Pressable
          onPress={view.action.onPress}
          ariaLabel={view.action.a11yLabel}
          className="uw-review__action"
        >
          <Text
            variant="metadata"
            color={view.action.kind === 'reject' ? 'warn' : 'primary'}
          >
            {view.action.label}
          </Text>
        </Pressable>
      </div>
    </div>
  );
}
