import type { ReactNode } from 'react';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';
import { Pressable } from './primitives.tsx';
import { useTheme } from './theme.tsx';

/**
 * Web/desktop fallback for `stack.native.tsx`: no native stack exists
 * outside iOS/Android, so pushes render as full-bleed overlays and
 * sheets as the scrim + bottom-panel shell the app used before the
 * native host existed.
 */

export type AppStackProps = {
  readonly children: ReactNode;
};

export function AppStack({ children }: AppStackProps) {
  return <View style={{ flex: 1 }}>{children}</View>;
}

export type StackItemProps = {
  readonly stackKey: string;
  readonly children: ReactNode;
};

export function StackItem({ children }: StackItemProps) {
  return <View style={{ flex: 1 }}>{children}</View>;
}

export type PushScreenProps = {
  readonly stackKey: string;
  readonly onDismissed?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function PushScreen({ children }: PushScreenProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.colors.canvas },
      ]}
    >
      {children}
    </View>
  );
}

export type SheetScreenProps = {
  readonly stackKey: string;
  readonly onDismissed?: (() => void) | undefined;
  readonly children: ReactNode;
};

export function SheetScreen({ onDismissed, children }: SheetScreenProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' },
      ]}
    >
      {/* Tap-outside dismiss lives on the scrim, not the panel. */}
      <Pressable
        compact
        onPress={onDismissed}
        accessibilityLabel="dismiss"
        style={StyleSheet.absoluteFill}
      />
      {/* Native formSheets resize with the keyboard on their own; the
          web/desktop panel needs KAV so NameField isn't covered. */}
      <KeyboardAvoidingView behavior="padding">
        <View
          style={{
            backgroundColor: theme.colors.raised,
            borderTopLeftRadius: theme.radius.float,
            borderTopRightRadius: theme.radius.float,
            borderWidth: theme.strokes.hairline,
            borderColor: theme.colors.hairline,
          }}
        >
          {children}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
