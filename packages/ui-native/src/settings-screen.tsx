import { ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Hairline, Icon, Pressable, Text } from './primitives.tsx';
import type { SettingsModel, SettingsRowModel } from '@auqw/ui-shared';

export type SettingsScreenProps = {
  readonly model: SettingsModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onSelectRow?: ((key: string) => void) | undefined;
  readonly onToggleRow?: ((key: string) => void) | undefined;
  readonly onOpenCorrections?: (() => void) | undefined;
};

// Visual-only track+thumb — the row itself is the `switch` element;
// a nested switch inside it duplicates (and on iOS hides) the control.
function Toggle({ enabled }: { readonly enabled: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessible={false}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        backgroundColor: enabled ? theme.colors.accent : theme.colors.fg18,
        justifyContent: 'center',
        paddingHorizontal: 2,
      }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: theme.colors.textBright,
          alignSelf: enabled ? 'flex-end' : 'flex-start',
        }}
      />
    </View>
  );
}

function SettingsRow({
  row,
  onSelectRow,
  onToggleRow,
}: {
  readonly row: SettingsRowModel;
  readonly onSelectRow?: ((key: string) => void) | undefined;
  readonly onToggleRow?: ((key: string) => void) | undefined;
}) {
  const theme = useTheme();
  const interactive =
    row.kind === 'toggle' ? onToggleRow !== undefined : onSelectRow !== undefined;
  // `enabled` is the toggle's checked state (kind 'toggle') and the
  // disabled flag on every other kind — an off navigation/value row
  // renders visibly inert, never a live control that dead-presses.
  const off =
    !interactive || (row.kind !== 'toggle' && !row.enabled);
  return (
    <Pressable
      onPress={
        row.kind === 'toggle'
          ? onToggleRow === undefined
            ? undefined
            : () => onToggleRow(row.key)
          : onSelectRow === undefined
            ? undefined
            : () => onSelectRow(row.key)
      }
      disabled={off}
      accessibilityLabel={`${row.label}${row.value === null ? '' : `, ${row.value}`}`}
      accessibilityRole={row.kind === 'toggle' ? 'switch' : 'button'}
      accessibilityState={row.kind === 'toggle' ? { checked: row.enabled } : undefined}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: theme.sizes.touch,
        paddingHorizontal: theme.spacing.screen,
        gap: theme.spacing.md,
      }}
    >
      <Text variant="body" color="primary" style={{ flex: 1 }}>
        {row.label}
      </Text>
      {row.kind === 'toggle' ? (
        <Toggle enabled={row.enabled} />
      ) : (
        <>
          {row.value !== null && (
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {row.value}
            </Text>
          )}
          {row.kind === 'navigation' && (
            <Icon
              name="chevron-right"
              size={12}
              color={theme.colors.textSecondary}
            />
          )}
        </>
      )}
    </Pressable>
  );
}

export function SettingsScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onSelectRow,
  onToggleRow,
  onOpenCorrections,
}: SettingsScreenProps) {
  const theme = useTheme();
  const diagnostics = model.diagnostics;
  const persistenceColor =
    diagnostics.persistence === 'ok' ? 'secondary' : 'warn';
  return (
    <ScrollView
      scrollEnabled={scrollEnabled}
      style={{ flex: 1, backgroundColor: theme.colors.canvas }}
      contentContainerStyle={{ paddingTop: topInset, paddingBottom: theme.spacing.xxl }}
    >
      <Text
        variant="label"
        color="secondary"
        uppercase
        style={{ paddingHorizontal: theme.spacing.screen, marginTop: theme.spacing.sm, marginBottom: theme.spacing.sm }}
      >
        settings
      </Text>
      <View
        style={{
          marginHorizontal: theme.spacing.screen,
          borderRadius: theme.radius.control,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          overflow: 'hidden',
        }}
      >
        {model.rows.map((row, i) => (
          <View key={row.key}>
            {i > 0 && <Hairline style={{ marginLeft: 14 }} />}
            <SettingsRow
              row={row}
              onSelectRow={onSelectRow}
              onToggleRow={onToggleRow}
            />
          </View>
        ))}
      </View>
      <Text
        variant="label"
        color="secondary"
        uppercase
        style={{
          paddingHorizontal: theme.spacing.screen,
          marginTop: theme.spacing.xl,
          marginBottom: theme.spacing.sm,
        }}
      >
        diagnostics
      </Text>
      <View
        style={{
          marginHorizontal: theme.spacing.screen,
          borderRadius: theme.radius.control,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          padding: 14,
          gap: theme.spacing.sm,
        }}
      >
        <View style={{ flexDirection: 'row' }}>
          <Text variant="metadata" color="secondary" style={{ flex: 1 }}>
            providers
          </Text>
          <Text variant="metadata" color="primary" style={{ flexShrink: 1 }}>
            {diagnostics.providerIds.length === 0
              ? 'none'
              : diagnostics.providerIds.join(', ')}
          </Text>
        </View>
        <Hairline />
        <View style={{ flexDirection: 'row' }}>
          <Text variant="metadata" color="secondary" style={{ flex: 1 }}>
            attempt trace
          </Text>
          <Text variant="metadata" color="primary" numeric>
            {diagnostics.attemptCount} attempts
            {diagnostics.lastAttemptLabel === null
              ? ''
              : ` · last: ${diagnostics.lastAttemptLabel}`}
          </Text>
        </View>
        <Hairline />
        <View style={{ flexDirection: 'row' }}>
          <Text variant="metadata" color="secondary" style={{ flex: 1 }}>
            persistence
          </Text>
          <Text variant="metadata" color={persistenceColor}>
            {diagnostics.persistence}
            {diagnostics.persistenceDetail === null
              ? ''
              : ` · ${diagnostics.persistenceDetail}`}
          </Text>
        </View>
        <Hairline />
        {/*
         * The corrections queue entry — management-oriented: a count
         * when the caller has loaded reviews, the chevron always. Row
         * is inert without the callback (gallery).
         */}
        <Pressable
          onPress={onOpenCorrections}
          disabled={onOpenCorrections === undefined}
          accessibilityLabel="match reviews"
          accessibilityRole="button"
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
            },
            pressed && { opacity: 0.6 },
          ]}
        >
          <Text variant="metadata" color="secondary" style={{ flex: 1 }}>
            match reviews
          </Text>
          {diagnostics.pendingReviews !== null && (
            <Text variant="metadata" color="primary" numeric>
              {diagnostics.pendingReviews} pending
            </Text>
          )}
          <Icon
            name="chevron-right"
            size={12}
            color={theme.colors.textSecondary}
          />
        </Pressable>
      </View>
    </ScrollView>
  );
}
