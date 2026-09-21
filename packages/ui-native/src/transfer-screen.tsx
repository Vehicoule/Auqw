import React from 'react';
import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Text } from './primitives.tsx';
import { ErrorState } from './states.tsx';
import type { ImportPreviewModel, TransferModel } from './view-models.ts';

export type TransferScreenProps = {
  readonly model: TransferModel;
  readonly topInset?: number | undefined;
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
  topInset = 0,
  scrollEnabled = true,
  onBack,
  onExport,
  onPickImportFile,
  onApplyImport,
  onResetImport,
}: TransferScreenProps) {
  const theme = useTheme();
  const exportBusy = model.exportPhase === 'working';
  const importBusy =
    model.importPhase === 'reading' || model.importPhase === 'applying';
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
          accessibilityLabel="back"
          style={{ padding: theme.spacing.xs }}
        >
          <Icon
            name="chevron-left"
            size={16}
            color={theme.colors.textSecondary}
          />
        </Pressable>
        <Text variant="display" color="bright" style={{ flex: 1 }}>
          library transfer
        </Text>
      </View>
      <ScrollView
        scrollEnabled={scrollEnabled}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.sm,
          paddingBottom: theme.spacing.xxl,
          gap: theme.spacing.lg,
        }}
      >
        <View>
          <Text
            variant="label"
            color="secondary"
            uppercase
            style={{ paddingHorizontal: theme.spacing.sm }}
          >
            export
          </Text>
          <TransferRow
            label={exportBusy ? 'exporting…' : 'export library'}
            detail={
              model.exportPhase === 'done' || model.exportPhase === 'error'
                ? model.exportDetail
                : null
            }
            detailTone={model.exportPhase === 'error' ? 'warn' : 'secondary'}
            disabled={exportBusy || onExport === undefined}
            onPress={onExport}
          />
        </View>
        <View>
          <Text
            variant="label"
            color="secondary"
            uppercase
            style={{ paddingHorizontal: theme.spacing.sm }}
          >
            import
          </Text>
          <TransferRow
            label={importBusy ? 'working…' : 'choose file…'}
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
        </View>
      </ScrollView>
    </View>
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
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          minHeight: theme.sizes.touch,
          paddingHorizontal: theme.spacing.sm,
          marginTop: theme.spacing.xs,
          borderRadius: theme.radius.control,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          opacity: disabled ? 0.5 : 1,
        },
        pressed && { backgroundColor: theme.colors.fg08 },
      ]}
    >
      <Icon name="download" size={14} color={theme.colors.textSecondary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" color="primary" numberOfLines={1}>
          {label}
        </Text>
        {detail === null ? null : (
          <Text variant="metadata" color={detailTone} numberOfLines={2}>
            {detail}
          </Text>
        )}
      </View>
      <Icon name="chevron-right" size={12} color={theme.colors.textSecondary} />
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
  const theme = useTheme();
  const preview: ImportPreviewModel | null = model.preview;
  if (preview === null) {
    return null;
  }
  return (
    <View
      style={{
        marginTop: theme.spacing.sm,
        padding: theme.spacing.sm,
        borderRadius: theme.radius.control,
        borderWidth: theme.strokes.hairline,
        borderColor: theme.colors.hairline,
      }}
    >
      <Text variant="body" color="bright">
        import preview
      </Text>
      <Text
        variant="metadata"
        color="secondary"
        style={{ marginTop: theme.spacing.xs }}
      >
        format v{preview.formatVersion}
        {preview.exportedLabel === null
          ? ''
          : ` · exported ${preview.exportedLabel}`}
        {` · ${preview.sourceLabel}`}
      </Text>
      <View style={{ marginTop: theme.spacing.sm, gap: 4 }}>
        {preview.rows.map((row) => (
          <View
            key={row.key}
            style={{ flexDirection: 'row', gap: theme.spacing.sm }}
          >
            <Text variant="metadata" color="secondary" style={{ flex: 1 }}>
              {row.label}
            </Text>
            <Text variant="metadata" color="primary">
              {row.count}
            </Text>
          </View>
        ))}
      </View>
      {model.importPhase === 'done' ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.md,
          }}
        >
          <Icon name="check" size={14} color={theme.colors.accent} />
          <Text variant="metadata" color="accent" style={{ flex: 1 }}>
            {model.importDetail ?? 'import applied'}
          </Text>
          <Pressable
            compact
            onPress={onResetImport}
            accessibilityLabel="reset import"
            style={{ paddingHorizontal: theme.spacing.xs }}
          >
            <Text variant="metadata" color="primary">
              done
            </Text>
          </Pressable>
        </View>
      ) : model.importPhase === 'error' ? (
        <View style={{ marginTop: theme.spacing.sm }}>
          <ErrorState title="import failed" hint={model.importDetail} />
          <Pressable
            compact
            onPress={onResetImport}
            accessibilityLabel="reset import"
            style={{ paddingHorizontal: theme.spacing.sm }}
          >
            <Text variant="metadata" color="primary">
              start over
            </Text>
          </Pressable>
        </View>
      ) : (
        <View
          style={{
            flexDirection: 'row',
            gap: theme.spacing.md,
            marginTop: theme.spacing.md,
          }}
        >
          <Pressable
            compact
            onPress={onApplyImport}
            disabled={model.importPhase === 'applying'}
            accessibilityLabel="apply import"
            style={{
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.accent,
              opacity: model.importPhase === 'applying' ? 0.5 : 1,
            }}
          >
            <Text variant="metadata" color="canvas">
              {model.importPhase === 'applying' ? 'applying…' : 'apply import'}
            </Text>
          </Pressable>
          <Pressable
            compact
            onPress={onResetImport}
            accessibilityLabel="cancel import"
            style={{
              paddingHorizontal: theme.spacing.md,
              minHeight: 26,
              justifyContent: 'center',
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.fg08,
            }}
          >
            <Text variant="metadata" color="secondary">
              cancel
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
