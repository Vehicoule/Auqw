import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import {
  fontFamilies,
  motion,
  radius,
  resolveTheme,
  schemes,
  sizes,
  spacing,
  strokes,
  typography,
} from '@auqw/design-tokens';
import { deriveScheme } from '@auqw/design-tokens/adaptive';
import type { SchemeName, ThemeName } from '@auqw/design-tokens';
import type { SchemeValues, ThemeSource } from '@auqw/design-tokens/adaptive';

export type Theme = {
  readonly scheme: SchemeName;
  readonly colors: SchemeValues;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly sizes: typeof sizes;
  readonly strokes: typeof strokes;
  readonly fontFamilies: typeof fontFamilies;
  readonly typography: typeof typography;
  readonly motion: typeof motion;
  readonly reducedMotion: boolean;
  readonly textScale: number;
};

const ThemeContext = createContext<Theme | null>(null);

export type ThemeProviderProps = {
  readonly theme?: ThemeName;
  readonly reducedMotion?: boolean;
  readonly textScale?: number;
  /**
   * The OS palette the 'adaptive' theme derives from (system tonal
   * stops on Android 12+, none elsewhere). `null` resolves like
   * 'system'.
   */
  readonly source?: ThemeSource | null;
  readonly children: ReactNode;
};

export function ThemeProvider({
  theme = 'system',
  reducedMotion,
  textScale = 1,
  source = null,
  children,
}: ThemeProviderProps) {
  const system = useColorScheme();
  const systemReduced = useReducedMotion();
  const value = useMemo<Theme>(() => {
    const live = system === 'dark' ? 'dark' : 'light';
    const derived =
      theme === 'adaptive' ? deriveScheme(source, live) : null;
    const scheme = derived?.scheme ?? resolveTheme(theme, live);
    return {
      scheme,
      colors: derived?.values ?? schemes[scheme],
      spacing,
      radius,
      sizes,
      strokes,
      fontFamilies,
      typography,
      motion,
      reducedMotion: reducedMotion ?? systemReduced,
      // textScale comes from the OS font scale — smaller-than-default
      // settings are legitimate (Android reaches ~0.85); the floor only
      // guards against a degenerate value zeroing text.
      textScale: Math.min(2, Math.max(0.5, textScale)),
    };
  }, [theme, source, system, reducedMotion, systemReduced, textScale]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) {
    throw new Error('useTheme requires a ThemeProvider');
  }
  return theme;
}
