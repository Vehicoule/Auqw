import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  BackRow,
  Icon,
  PillButton,
  Pressable,
  StatusMark,
  Text,
} from './primitives.tsx';
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
  readonly topInset?: number | undefined;
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
  topInset = 0,
  scrollEnabled = true,
  onBack,
  onExport,
  onPickImportFile,
  onApplyImport,
  onResetImport,
}: TransferScreenProps) {
  const theme = useTheme();
  const view = useTransferScreenController({
    model,
    onExport,
    onPickImportFile,
    onApplyImport,
    onResetImport,
  });
  const sectionLabel = (label: string) => (
    <Text
      variant="label"
      color="secondary"
      uppercase
      style={{ paddingHorizontal: theme.spacing.sm }}
    >
      {label}
    </Text>
  );
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
      </BackRow>
      <ScrollView
        scrollEnabled={scrollEnabled}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.sm,
          paddingBottom: theme.spacing.xxl,
          gap: theme.spacing.lg,
        }}
      >
        <View>
          {sectionLabel(view.exportSectionLabel)}
          <TransferRow view={view.exportRow} />
        </View>
        <View>
          {sectionLabel(view.importSectionLabel)}
          <TransferRow view={view.importRow} />
          <ImportBody body={view.importBody} />
        </View>
      </ScrollView>
    </View>
  );
}

function TransferRow({ view }: { readonly view: TransferRowView }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={view.onPress}
      disabled={view.disabled}
      accessibilityLabel={view.label}
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
          opacity: view.disabled ? 0.5 : 1,
        },
        pressed && { backgroundColor: theme.colors.fg08 },
      ]}
    >
      <Icon name="download" size={14} color={theme.colors.textSecondary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" color="primary" numberOfLines={1}>
          {view.label}
        </Text>
        {view.detail === null ? null : (
          <Text variant="metadata" color={view.detailTone} numberOfLines={2}>
            {view.detail}
          </Text>
        )}
      </View>
      <Icon name="chevron-right" size={12} color={theme.colors.textSecondary} />
    </Pressable>
  );
}

function ImportBody({
  body,
}: {
  readonly body: TransferImportView | null;
}) {
  const theme = useTheme();
  if (body === null) {
    return null;
  }
  const { footer } = body;
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
        {body.title}
      </Text>
      <Text
        variant="metadata"
        color="secondary"
        style={{ marginTop: theme.spacing.xs }}
      >
        {body.metaLabel}
      </Text>
      <View style={{ marginTop: theme.spacing.sm, gap: 4 }}>
        {body.rows.map((row) => (
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
      {footer.kind === 'done' ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.md,
          }}
        >
          <StatusMark kind="check" size={14} color={theme.colors.accent} />
          <Text variant="metadata" color="accent" style={{ flex: 1 }}>
            {footer.detail}
          </Text>
          <Pressable
            compact
            onPress={footer.onReset}
            accessibilityLabel={footer.resetA11yLabel}
            style={{ paddingHorizontal: theme.spacing.xs }}
          >
            <Text variant="metadata" color="primary">
              {footer.resetLabel}
            </Text>
          </Pressable>
        </View>
      ) : footer.kind === 'error' ? (
        <View style={{ marginTop: theme.spacing.sm }}>
          <ErrorState title={footer.title} hint={footer.hint} />
          <Pressable
            compact
            onPress={footer.onReset}
            accessibilityLabel={footer.resetA11yLabel}
            style={{ paddingHorizontal: theme.spacing.sm }}
          >
            <Text variant="metadata" color="primary">
              {footer.resetLabel}
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
          <PillButton
            label={footer.applyLabel}
            tone="accent"
            onPress={footer.onApply}
            disabled={footer.applying}
            accessibilityLabel={footer.applyA11yLabel}
            style={{ paddingHorizontal: theme.spacing.sm }}
          />
          <PillButton
            label={footer.cancelLabel}
            minHeight={26}
            onPress={footer.onCancel}
            accessibilityLabel={footer.cancelA11yLabel}
          />
        </View>
      )}
    </View>
  );
}
