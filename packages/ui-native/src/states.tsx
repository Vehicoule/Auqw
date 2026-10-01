import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Icon, PillButton, Spinner, Text } from './primitives.tsx';
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

function StateIcon({
  name,
  color,
}: {
  readonly name?: IconName | undefined;
  readonly color: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: theme.sizes.artworkRing,
        height: theme.sizes.artworkRing,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.fg08,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {name === undefined ? (
        <Spinner size={22} />
      ) : (
        <Icon name={name} size={22} color={color} />
      )}
    </View>
  );
}

function StateCopy({
  title,
  hint,
  centered = true,
}: {
  readonly title: string;
  readonly hint?: string | null | undefined;
  readonly centered?: boolean | undefined;
}) {
  return (
    <>
      <Text variant="title" color="primary">
        {title}
      </Text>
      {hint !== null && hint !== undefined && (
        <Text
          variant="metadata"
          color="secondary"
          style={centered ? { textAlign: 'center' } : undefined}
        >
          {hint}
        </Text>
      )}
    </>
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
      <StateIcon color={theme.colors.textSecondary} />
      <StateCopy title={title} hint={hint} centered={false} />
      {onCancel !== undefined && (
        <PillButton label={t('common.cancel')} onPress={onCancel} />
      )}
    </StateShell>
  );
}

export function EmptyState({ title, hint = null, icon = 'note' }: StateViewProps) {
  const theme = useTheme();
  return (
    <StateShell>
      <StateIcon name={icon} color={theme.colors.textSecondary} />
      <StateCopy title={title} hint={hint} />
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
      <StateIcon name="warn" color={theme.colors.warn} />
      <StateCopy title={title} hint={hint} />
      {onRetry !== undefined && (
        <PillButton label={retryLabel} onPress={onRetry} />
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
      <StateIcon name="warn" color={theme.colors.warn} />
      <StateCopy title={title} hint={hint} />
    </StateShell>
  );
}

/** The kind-tagged status views the ui-shared controllers emit. */
export type StatePhase =
  | {
      readonly kind: 'loading';
      readonly title: string;
      readonly hint?: string | null | undefined;
    }
  | {
      readonly kind: 'empty';
      readonly title: string;
      readonly hint?: string | null | undefined;
      readonly icon?: IconName | undefined;
    }
  | {
      readonly kind: 'unavailable';
      readonly title: string;
      readonly hint?: string | null | undefined;
    }
  | {
      readonly kind: 'error';
      readonly title: string;
      readonly hint?: string | null | undefined;
      readonly onRetry?: (() => void) | undefined;
    };

export function StateFor({ view }: { readonly view: StatePhase }) {
  switch (view.kind) {
    case 'loading':
      return <LoadingState title={view.title} hint={view.hint} />;
    case 'unavailable':
      return <UnavailableState title={view.title} hint={view.hint} />;
    case 'error':
      return (
        <ErrorState
          title={view.title}
          hint={view.hint}
          onRetry={view.onRetry}
        />
      );
    case 'empty':
      return (
        <EmptyState title={view.title} hint={view.hint} icon={view.icon} />
      );
  }
}
