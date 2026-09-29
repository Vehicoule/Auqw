import type { ReactNode } from 'react';
import { Icon, Pressable, Spinner, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { t } from '@auqw/ui-shared';

export type StateViewProps = {
  readonly title: string;
  readonly hint?: string | null | undefined;
  readonly icon?: IconName | undefined;
};

const TONE_PAINT = {
  secondary: 'var(--text-secondary)',
  warn: 'var(--warn)',
  accent: 'var(--accent)',
} as const;

function StateShell({
  icon,
  title,
  hint = null,
  tone,
  role = 'status',
  live = false,
  children,
}: {
  readonly icon?: IconName | undefined;
  readonly title: string;
  readonly hint?: string | null | undefined;
  readonly tone?: 'secondary' | 'warn' | 'accent' | undefined;
  readonly role?: 'status' | 'alert' | undefined;
  readonly live?: boolean | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className="uw-state"
      role={role}
      data-state={tone}
      aria-live={live ? 'polite' : undefined}
    >
      <span className="uw-state__icon">
        {icon === undefined ? (
          <Spinner size={22} />
        ) : (
          <Icon name={icon} size={22} color={TONE_PAINT[tone ?? 'secondary']} />
        )}
      </span>
      <Text variant="title" color="primary">
        {title}
      </Text>
      {hint !== null && (
        <Text variant="metadata" color="secondary">
          {hint}
        </Text>
      )}
      {children}
    </div>
  );
}

export function LoadingState({ title = t('state.loading'), hint = null }: StateViewProps) {
  return <StateShell title={title} hint={hint} live />;
}

export function EmptyState({ title, hint = null, icon = 'note' }: StateViewProps) {
  return <StateShell icon={icon} title={title} hint={hint} tone="secondary" />;
}

export function ErrorState({
  title,
  hint = null,
  onRetry,
}: StateViewProps & { readonly onRetry?: (() => void) | undefined }) {
  return (
    <StateShell icon="warn" title={title} hint={hint} tone="warn" role="alert">
      {onRetry !== undefined && (
        <Pressable
          onPress={onRetry}
          ariaLabel={t('state.retry')}
          className="uw-state__retry"
        >
          <Text variant="metadata" color="accent">
            {t('state.retry')}
          </Text>
        </Pressable>
      )}
    </StateShell>
  );
}

export function UnavailableState({
  title,
  hint = null,
  icon = 'warn',
}: StateViewProps) {
  return <StateShell icon={icon} title={title} hint={hint} tone="warn" />;
}
