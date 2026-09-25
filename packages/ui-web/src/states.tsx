import type { ReactNode } from 'react';
import { Icon, Spinner, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { Pressable } from './primitives.tsx';
import { t } from '@auqw/ui-shared';

export type StateViewProps = {
  readonly title: string;
  readonly hint?: string | null | undefined;
  readonly icon?: IconName | undefined;
};

function StateShell({
  icon,
  title,
  hint = null,
  tone = 'secondary',
  role = 'status',
  children,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly hint?: string | null | undefined;
  readonly tone?: 'secondary' | 'warn' | 'accent' | undefined;
  readonly role?: 'status' | 'alert' | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div className="uw-state" role={role} data-state={tone}>
      <span className="uw-state__icon">
        <Icon name={icon} size={22} color={`var(--${tone === 'secondary' ? 'text-secondary' : tone})`} />
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
  return (
    <div className="uw-state" role="status" aria-live="polite">
      <span className="uw-state__icon">
        <Spinner size={22} />
      </span>
      <Text variant="title" color="primary">
        {title}
      </Text>
      {hint !== null && (
        <Text variant="metadata" color="secondary">
          {hint}
        </Text>
      )}
    </div>
  );
}

export function EmptyState({ title, hint = null, icon = 'note' }: StateViewProps) {
  return (
    <StateShell icon={icon} title={title} hint={hint} />
  );
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
