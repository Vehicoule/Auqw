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
import type { SchemeName, ThemeName } from '@auqw/design-tokens';

export type Theme = {
  readonly scheme: SchemeName;
  readonly colors: (typeof schemes)[SchemeName];
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly sizes: typeof sizes;
  readonly strokes: typeof strokes;
  readonly fontFamilies: typeof fontFamilies;
  readonly typography: typeof typography;
  readonly motion: typeof motion;
  readonly reducedMotion: boolean;
};

const ThemeContext = createContext<Theme | null>(null);

export type ThemeProviderProps = {
  readonly theme?: ThemeName;
  readonly reducedMotion?: boolean;
  readonly children: ReactNode;
};

export function ThemeProvider({
  theme = 'system',
  reducedMotion,
  children,
}: ThemeProviderProps) {
  const system = useColorScheme();
  const systemReduced = useReducedMotion();
  const value = useMemo<Theme>(() => {
    const scheme = resolveTheme(theme, system === 'dark' ? 'dark' : 'light');
    return {
      scheme,
      colors: schemes[scheme],
      spacing,
      radius,
      sizes,
      strokes,
      fontFamilies,
      typography,
      motion,
      reducedMotion: reducedMotion ?? systemReduced,
    };
  }, [theme, system, reducedMotion, systemReduced]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) {
    throw new Error('useTheme requires a ThemeProvider');
  }
  return theme;
}
