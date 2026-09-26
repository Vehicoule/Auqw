import { Icon, Pressable, Text } from './primitives.tsx';
import { ErrorState } from './states.tsx';
import { t } from '@auqw/ui-shared';
import type { ImportPreviewModel, TransferModel } from '@auqw/ui-shared';

export type TransferScreenProps = {
  readonly model: TransferModel;
  readonly scrollEnabled?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onExport?: (() => void) | undefined;
  readonly onPickImportFile?: (() => void) | undefined;
  readonly onApplyImport?: (() => void) | undefined;
  readonly onResetImport?: (() => void) | undefined;
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
  const exportBusy = model.exportPhase === 'working';
  const importBusy =
    model.importPhase === 'reading' || model.importPhase === 'applying';
  return (
    <div
      className="uw-screen uw-transfer"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-collection__head">
        <Pressable onPress={onBack} ariaLabel={t('common.back')} className="uw-back">
          <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
        </Pressable>
        <Text variant="display" color="bright" className="uw-collection__title">
          {t('transfer.title')}
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
            {t('transfer.exportSection')}
          </Text>
          <TransferRow
            label={exportBusy ? t('transfer.exporting') : t('transfer.export')}
            detail={
              model.exportPhase === 'done' || model.exportPhase === 'error'
                ? model.exportDetail
                : null
            }
            detailTone={model.exportPhase === 'error' ? 'warn' : 'secondary'}
            disabled={exportBusy || onExport === undefined}
            onPress={onExport}
          />
        </section>
        <section>
          <Text
            variant="label"
            color="secondary"
            uppercase
            className="uw-section-label"
          >
            {t('transfer.importSection')}
          </Text>
          <TransferRow
            label={importBusy ? t('transfer.working') : t('transfer.import')}
            detail={model.importPhase === 'error' ? model.importDetail : null}
            detailTone="warn"
            disabled={importBusy || onPickImportFile === undefined}
            onPress={onPickImportFile}
          />
          <ImportBody
            model={model}
            onApplyImport={onApplyImport}
            onResetImport={onResetImport}
          />
        </section>
      </div>
    </div>
  );
}

function TransferRow({
  label,
  detail,
  detailTone,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly detail: string | null;
  readonly detailTone: 'secondary' | 'warn';
  readonly disabled: boolean;
  readonly onPress?: (() => void) | undefined;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      ariaLabel={label}
      className={`uw-transfer-row${disabled ? ' uw-off' : ''}`}
    >
      <Icon name="download" size={14} color="var(--text-secondary)" />
      <span className="uw-transfer-row__text">
        <Text variant="body" color="primary" numberOfLines={1}>
          {label}
        </Text>
        {detail === null ? null : (
          <Text variant="metadata" color={detailTone} numberOfLines={2}>
            {detail}
          </Text>
        )}
      </span>
      <Icon name="chevron-right" size={12} color="var(--text-secondary)" />
    </Pressable>
  );
}

function ImportBody({
  model,
  onApplyImport,
  onResetImport,
}: {
  readonly model: TransferModel;
  readonly onApplyImport?: (() => void) | undefined;
  readonly onResetImport?: (() => void) | undefined;
}) {
  const preview: ImportPreviewModel | null = model.preview;
  if (preview === null) {
    return null;
  }
  return (
    <div className="uw-import-preview" data-phase={model.importPhase}>
      <Text variant="body" color="bright">
        {t('transfer.previewTitle')}
      </Text>
      <Text variant="metadata" color="secondary" className="uw-import-preview__meta">
        {t('transfer.format', { version: preview.formatVersion })}
        {preview.exportedLabel === null
          ? ''
          : t('transfer.exportedSuffix', { date: preview.exportedLabel })}
        {t('transfer.sourceSuffix', { source: preview.sourceLabel })}
      </Text>
      <div className="uw-import-preview__rows">
        {preview.rows.map((row) => (
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
      {model.importPhase === 'done' ? (
        <div className="uw-import-preview__done">
          <Icon name="check" size={14} color="var(--accent)" />
          <Text variant="metadata" color="accent" className="uw-diag-row__k">
            {model.importDetail ?? t('transfer.applied')}
          </Text>
          <Pressable
            onPress={onResetImport}
            ariaLabel={t('transfer.resetA11y')}
            className="uw-review__action"
          >
            <Text variant="metadata" color="primary">
              {t('common.done')}
            </Text>
          </Pressable>
        </div>
      ) : model.importPhase === 'error' ? (
        <div className="uw-import-preview__error">
          <ErrorState title={t('transfer.failed')} hint={model.importDetail} />
          <Pressable
            onPress={onResetImport}
            ariaLabel={t('transfer.resetA11y')}
            className="uw-review__action"
          >
            <Text variant="metadata" color="primary">
              {t('transfer.startOver')}
            </Text>
          </Pressable>
        </div>
      ) : (
        <div className="uw-import-preview__actions">
          <Pressable
            onPress={onApplyImport}
            disabled={model.importPhase === 'applying'}
            ariaLabel={t('transfer.apply')}
            className="uw-cta"
          >
            <Text variant="metadata" color="canvas">
              {model.importPhase === 'applying' ? t('transfer.applying') : t('transfer.apply')}
            </Text>
          </Pressable>
          <Pressable
            onPress={onResetImport}
            ariaLabel={t('transfer.cancelA11y')}
            className="uw-headbtn"
          >
            <Text variant="metadata" color="secondary">
              {t('common.cancel')}
            </Text>
          </Pressable>
        </div>
      )}
    </div>
  );
}
