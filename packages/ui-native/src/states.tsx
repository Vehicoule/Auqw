import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Icon, Pressable, Spinner, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { t } from '@auqw/ui-shared';

export type StateViewProps = {
  readonly title: string;
  readonly hint?: string | null | undefined;
  readonly icon?: IconName | undefined;
};

function StateShell({
  children,
}: {
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.spacing.xxl,
        gap: theme.spacing.md,
      }}
    >
      {children}
    </View>
  );
}

export function LoadingState({
  title = t('state.loading'),
  hint = null,
  onCancel,
}: {
  readonly title?: string | undefined;
  readonly hint?: string | null | undefined;
  readonly onCancel?: (() => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <StateShell>
      <Spinner size={18} />
      <Text variant="body" color="secondary">
        {title}
      </Text>
      {hint !== null && (
        <Text variant="metadata" color="secondary">
          {hint}
        </Text>
      )}
      {onCancel !== undefined && (
        <Pressable
          onPress={onCancel}
          accessibilityLabel={t('common.cancel')}
          style={{
            paddingHorizontal: theme.spacing.lg,
            borderRadius: theme.radius.control,
            borderWidth: theme.strokes.hairline,
            borderColor: theme.colors.hairline,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="metadata" color="primary">
            {t('common.cancel')}
          </Text>
        </Pressable>
      )}
    </StateShell>
  );
}

export function EmptyState({ title, hint = null, icon = 'note' }: StateViewProps) {
  const theme = useTheme();
  return (
    <StateShell>
      <Icon name={icon} size={20} color={theme.colors.textSecondary} />
      <Text variant="body" color="secondary">
        {title}
      </Text>
      {hint !== null && (
        <Text variant="metadata" color="secondary" style={{ textAlign: 'center' }}>
          {hint}
        </Text>
      )}
    </StateShell>
  );
}

export function ErrorState({
  title = t('state.errorTitle'),
  hint = null,
  onRetry,
  retryLabel = t('state.retry'),
}: {
  readonly title?: string | undefined;
  readonly hint?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly retryLabel?: string | undefined;
}) {
  const theme = useTheme();
  return (
    <StateShell>
      <Icon name="warn" size={20} color={theme.colors.warn} />
      <Text variant="body" color="secondary">
        {title}
      </Text>
      {hint !== null && (
        <Text variant="metadata" color="secondary" style={{ textAlign: 'center' }}>
          {hint}
        </Text>
      )}
      {onRetry !== undefined && (
        <Pressable
          onPress={onRetry}
          accessibilityLabel={retryLabel}
          style={{
            paddingHorizontal: theme.spacing.lg,
            borderRadius: theme.radius.control,
            borderWidth: theme.strokes.hairline,
            borderColor: theme.colors.hairline,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="metadata" color="primary">
            {retryLabel}
          </Text>
        </Pressable>
      )}
    </StateShell>
  );
}

export function UnavailableState({
  title = t('common.unavailable'),
  hint = null,
}: {
  readonly title?: string | undefined;
  readonly hint?: string | null | undefined;
}) {
  const theme = useTheme();
  return (
    <StateShell>
      <Icon name="warn" size={20} color={theme.colors.warn} />
      <Text variant="body" color="secondary">
        {title}
      </Text>
      {hint !== null && (
        <Text variant="metadata" color="secondary" style={{ textAlign: 'center' }}>
          {hint}
        </Text>
      )}
    </StateShell>
  );
}
