import type { ReactNode } from 'react';
import { View } from 'react-native';
import { ScreenStack, ScreenStackItem } from 'react-native-screens';
import { useTheme } from './theme.tsx';

/**
 * Native stack host: the app renders inside a `ScreenStack` whose base
 * item holds the tab shell, pushed overlays ride real `push`
 * transitions (iOS swipe-back, Android predictive back), and sheets
 * present as native `formSheet`s with a grabber and swipe-dismiss.
 * `stack.tsx` carries the web/desktop fallback.
 */

export type AppStackProps = {
  readonly children: ReactNode;
};

export function AppStack({ children }: AppStackProps) {
  return <ScreenStack style={{ flex: 1 }}>{children}</ScreenStack>;
}

export type StackItemProps = {
  readonly stackKey: string;
  readonly children: ReactNode;
};

/** The stack's root screen — the tab shell and the player sheet live here. */
export function StackItem({ stackKey, children }: StackItemProps) {
  return (
    <ScreenStackItem
      screenId={stackKey}
      activityState={2}
      stackPresentation="push"
      headerConfig={{ hidden: true }}
    >
      <View style={{ flex: 1 }}>{children}</View>
    </ScreenStackItem>
  );
}

export type PushScreenProps = {
  readonly stackKey: string;
  readonly onDismissed?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function PushScreen({ stackKey, onDismissed, children }: PushScreenProps) {
  const theme = useTheme();
  return (
    <ScreenStackItem
      screenId={stackKey}
      activityState={2}
      stackPresentation="push"
      headerConfig={{ hidden: true }}
      gestureEnabled
      nativeBackButtonDismissalEnabled
      onDismissed={onDismissed}
      contentStyle={{ backgroundColor: theme.colors.canvas }}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
        {children}
      </View>
    </ScreenStackItem>
  );
}

export type SheetScreenProps = {
  readonly stackKey: string;
  readonly onDismissed?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function SheetScreen({
  stackKey,
  onDismissed,
  children,
}: SheetScreenProps) {
  const theme = useTheme();
  return (
    <ScreenStackItem
      screenId={stackKey}
      activityState={2}
      stackPresentation="formSheet"
      headerConfig={{ hidden: true }}
      gestureEnabled
      nativeBackButtonDismissalEnabled
      sheetAllowedDetents="fitToContents"
      sheetGrabberVisible
      sheetCornerRadius={theme.radius.float}
      onDismissed={onDismissed}
      contentStyle={{ backgroundColor: theme.colors.raised }}
    >
      <View style={{ backgroundColor: theme.colors.raised }}>{children}</View>
    </ScreenStackItem>
  );
}
