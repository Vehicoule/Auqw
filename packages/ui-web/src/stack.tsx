import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { sheetKeyAction } from './keyboard.ts';

/**
 * The stack hosts for DOM: pushes are full-bleed overlays, sheets the
 * scrim + panel shell — same contract the native hosts implement.
 * SheetScreen is the mount-point host; the panel building blocks are
 * in sheets.tsx (SheetScaffold/RowActionsSheet/…).
 *
 * Escape ownership lives in AppStack alone: overlays register their
 * dismiss callback on mount (LIFO), and the stack's single document
 * listener calls only the topmost one — sibling document listeners
 * would all fire on the same event and collapse every open level.
 */

type OverlayDismissApi = {
  readonly register: (dismiss: () => void) => () => void;
};

const OverlayDismissContext = createContext<OverlayDismissApi | null>(null);

export function useOverlayDismiss(
  onDismissed: (() => void) | undefined,
): void {
  const api = useContext(OverlayDismissContext);
  useEffect(() => {
    if (onDismissed === undefined) {
      return;
    }
    if (api !== null) {
      return api.register(onDismissed);
    }
    // Outside a stack (a lone sheet in a demo or test) the overlay owns
    // the Escape key itself.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (sheetKeyAction(event.key) === 'close') {
        onDismissed();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [api, onDismissed]);
}

/**
 * Focus entry + restore for modal dialogs: the sheet takes focus on
 * mount so keyboard input lands inside it, and closing returns focus
 * to whatever held it before. Tab containment and background
 * inertness belong to the app shell that mounts these hosts.
 */
export function useOverlayFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (node === null) {
      return;
    }
    const previous = document.activeElement;
    node.focus();
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);
  return ref;
}

export type AppStackProps = {
  readonly children: ReactNode;
};

export function AppStack({ children }: AppStackProps) {
  const dismissers = useRef<readonly (() => void)[]>([]);
  const api = useMemo<OverlayDismissApi>(
    () => ({
      register: (dismiss) => {
        dismissers.current = [...dismissers.current, dismiss];
        return () => {
          dismissers.current = dismissers.current.filter((d) => d !== dismiss);
        };
      },
    }),
    [],
  );
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (sheetKeyAction(event.key) !== 'close') {
        return;
      }
      const top = dismissers.current[dismissers.current.length - 1];
      if (top === undefined) {
        return;
      }
      event.preventDefault();
      top();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <OverlayDismissContext.Provider value={api}>
      <div className="uw-stack">{children}</div>
    </OverlayDismissContext.Provider>
  );
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
  useOverlayDismiss(onDismissed);
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
  useOverlayDismiss(onDismissed);
  const dialogRef = useOverlayFocus<HTMLDivElement>();
  return (
    <div className="uw-sheet-host" data-stack={stackKey}>
      <button
        type="button"
        className="uw-scrim"
        aria-label="close sheet"
        tabIndex={-1}
        onClick={onDismissed}
      />
      <div
        ref={dialogRef}
        className="uw-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={stackKey}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
