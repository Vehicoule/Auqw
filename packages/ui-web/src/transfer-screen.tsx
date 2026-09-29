import { Icon, Pressable, ScreenHead, Text } from './primitives.tsx';
import { ErrorState } from './states.tsx';
import type { TransferModel } from '@auqw/ui-shared';
import {
  useTransferScreenController,
  type TransferImportFooterView,
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
  ...handlers
}: TransferScreenProps) {
  const view = useTransferScreenController({ model, ...handlers });
  const sections = [
    { label: view.exportSectionLabel, row: view.exportRow, body: null },
    { label: view.importSectionLabel, row: view.importRow, body: view.importBody },
  ];
  return (
    <div
      className="uw-screen uw-transfer"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <ScreenHead
        a11yLabel={view.backA11yLabel}
        title={view.title}
        onBack={onBack}
      />
      <div className="uw-transfer__sections">
        {sections.map((section) => (
          <section key={section.label}>
            <Text
              variant="label"
              color="secondary"
              uppercase
              className="uw-section-label"
            >
              {section.label}
            </Text>
            <TransferRow view={section.row} />
            <ImportBody body={section.body} />
          </section>
        ))}
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
        {view.detail !== null && (
          <Text variant="metadata" color={view.detailTone} numberOfLines={2}>
            {view.detail}
          </Text>
        )}
      </span>
      <Icon name="chevron-right" size={12} color="var(--text-secondary)" />
    </Pressable>
  );
}

function ResetButton({
  footer,
}: {
  readonly footer: Extract<
    TransferImportFooterView,
    { readonly kind: 'done' | 'error' }
  >;
}) {
  return (
    <Pressable
      onPress={footer.onReset}
      ariaLabel={footer.resetA11yLabel}
      className="uw-review__action"
    >
      <Text variant="metadata" color="primary">
        {footer.resetLabel}
      </Text>
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
          <ResetButton footer={footer} />
        </div>
      ) : footer.kind === 'error' ? (
        <div className="uw-import-preview__error">
          <ErrorState title={footer.title} hint={footer.hint} />
          <ResetButton footer={footer} />
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
