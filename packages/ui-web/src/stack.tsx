import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { sheetKeyAction } from './keyboard.ts';

/**
 * The stack hosts for DOM: pushes are full-bleed overlays, sheets the
 * scrim + panel shell — same contract the native hosts implement.
 * SheetScreen is the mount-point host; the panel building blocks are
 * in sheets.tsx (SheetScaffold/RowActionsSheet/…).
 */

export type AppStackProps = {
  readonly children: ReactNode;
};

export function AppStack({ children }: AppStackProps) {
  return <div className="uw-stack">{children}</div>;
}

export type StackItemProps = {
  readonly stackKey: string;
  readonly children: ReactNode;
};

export function StackItem({ stackKey, children }: StackItemProps) {
  return (
    <div className="uw-stack-item" data-stack={stackKey}>
      {children}
    </div>
  );
}

export type PushScreenProps = {
  readonly stackKey: string;
  readonly onDismissed?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function PushScreen({ stackKey, onDismissed, children }: PushScreenProps) {
  useEffect(() => {
    if (onDismissed === undefined) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (sheetKeyAction(event.key) === 'close') {
        onDismissed();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismissed]);
  return (
    <div className="uw-push" data-stack={stackKey} role="presentation">
      {children}
    </div>
  );
}

export type SheetScreenProps = {
  readonly stackKey: string;
  readonly onDismissed?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function SheetScreen({ stackKey, onDismissed, children }: SheetScreenProps) {
  useEffect(() => {
    if (onDismissed === undefined) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (sheetKeyAction(event.key) === 'close') {
        onDismissed();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismissed]);
  return (
    <div className="uw-sheet-host" data-stack={stackKey} data-sheet="screen">
      {/* Click-outside dismiss lives on the scrim, not the panel. */}
      <button
        type="button"
        className="uw-scrim"
        aria-label="dismiss"
        tabIndex={-1}
        onClick={onDismissed}
      />
      <div className="uw-sheet" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}
