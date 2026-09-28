import { Icon, Pressable, Text } from './primitives.tsx';
import { ErrorState } from './states.tsx';
import type { TransferModel } from '@auqw/ui-shared';
import {
  useTransferScreenController,
  type TransferImportView,
  type TransferRowView,
  type TransferScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type TransferScreenProps = TransferScreenHandlers & {
  readonly model: TransferModel;
  readonly scrollEnabled?: boolean | undefined;
};

/**
 * The ownership-transfer surface. Export writes the versioned JSON
 * document and reports where it went; import is preview → confirm →
 * apply — the typed preview's section counts render before the apply
 * affordance exists, and typed failures stay typed. `exportDetail` /
 * `importDetail` carry the written path and the applied summary on
 * success, the error message on failure.
 */
export function TransferScreen({
  model,
  scrollEnabled = true,
  onBack,
  onExport,
  onPickImportFile,
  onApplyImport,
  onResetImport,
}: TransferScreenProps) {
  const view = useTransferScreenController({
    model,
    onExport,
    onPickImportFile,
    onApplyImport,
    onResetImport,
  });
  return (
    <div
      className="uw-screen uw-transfer"
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
      </div>
      <div className="uw-transfer__sections">
        <section>
          <Text
            variant="label"
            color="secondary"
            uppercase
            className="uw-section-label"
          >
            {view.exportSectionLabel}
          </Text>
          <TransferRow view={view.exportRow} />
        </section>
        <section>
          <Text
            variant="label"
            color="secondary"
            uppercase
            className="uw-section-label"
          >
            {view.importSectionLabel}
          </Text>
          <TransferRow view={view.importRow} />
          <ImportBody body={view.importBody} />
        </section>
      </div>
    </div>
  );
}

function TransferRow({ view }: { readonly view: TransferRowView }) {
  return (
    <Pressable
      onPress={view.onPress}
      disabled={view.disabled}
      ariaLabel={view.label}
      className={`uw-transfer-row${view.disabled ? ' uw-off' : ''}`}
    >
      <Icon name="download" size={14} color="var(--text-secondary)" />
      <span className="uw-transfer-row__text">
        <Text variant="body" color="primary" numberOfLines={1}>
          {view.label}
        </Text>
        {view.detail === null ? null : (
          <Text variant="metadata" color={view.detailTone} numberOfLines={2}>
            {view.detail}
          </Text>
        )}
      </span>
      <Icon name="chevron-right" size={12} color="var(--text-secondary)" />
    </Pressable>
  );
}

function ImportBody({
  body,
}: {
  readonly body: TransferImportView | null;
}) {
  if (body === null) {
    return null;
  }
  const { footer } = body;
  return (
    <div className="uw-import-preview" data-phase={body.phase}>
      <Text variant="body" color="bright">
        {body.title}
      </Text>
      <Text
        variant="metadata"
        color="secondary"
        className="uw-import-preview__meta"
      >
        {body.metaLabel}
      </Text>
      <div className="uw-import-preview__rows">
        {body.rows.map((row) => (
          <div key={row.key} className="uw-import-preview__row">
            <Text variant="metadata" color="secondary" className="uw-diag-row__k">
              {row.label}
            </Text>
            <Text variant="metadata" color="primary">
              {row.count}
            </Text>
          </div>
        ))}
      </div>
      {footer.kind === 'done' ? (
        <div className="uw-import-preview__done">
          <Icon name="check" size={14} color="var(--accent)" />
          <Text variant="metadata" color="accent" className="uw-diag-row__k">
            {footer.detail}
          </Text>
          <Pressable
            onPress={footer.onReset}
            ariaLabel={footer.resetA11yLabel}
            className="uw-review__action"
          >
            <Text variant="metadata" color="primary">
              {footer.resetLabel}
            </Text>
          </Pressable>
        </div>
      ) : footer.kind === 'error' ? (
        <div className="uw-import-preview__error">
          <ErrorState title={footer.title} hint={footer.hint} />
          <Pressable
            onPress={footer.onReset}
            ariaLabel={footer.resetA11yLabel}
            className="uw-review__action"
          >
            <Text variant="metadata" color="primary">
              {footer.resetLabel}
            </Text>
          </Pressable>
        </div>
      ) : (
        <div className="uw-import-preview__actions">
          <Pressable
            onPress={footer.onApply}
            disabled={footer.applying}
            ariaLabel={footer.applyA11yLabel}
            className="uw-cta"
          >
            <Text variant="metadata" color="canvas">
              {footer.applyLabel}
            </Text>
          </Pressable>
          <Pressable
            onPress={footer.onCancel}
            ariaLabel={footer.cancelA11yLabel}
            className="uw-headbtn"
          >
            <Text variant="metadata" color="secondary">
              {footer.cancelLabel}
            </Text>
          </Pressable>
        </div>
      )}
    </div>
  );
}
