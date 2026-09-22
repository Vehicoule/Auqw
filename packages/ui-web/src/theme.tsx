import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { resolveTheme } from '@auqw/design-tokens';
import type { SchemeName, ThemeName } from '@auqw/design-tokens';

// The web theme is class-based: the provider emits `ui-web t-<scheme>`
// and every color/space/radius/type value inside resolves through the
// design-tokens stylesheet custom properties — no palette in JS.
export type Theme = {
  readonly scheme: SchemeName;
  readonly reducedMotion: boolean;
  readonly textScale: number;
};

const ThemeContext = createContext<Theme | null>(null);

export type ThemeProviderProps = {
  readonly theme?: ThemeName | undefined;
  readonly reducedMotion?: boolean | undefined;
  readonly textScale?: number | undefined;
  /**
   * Scheme used for 'system' when `prefers-color-scheme` is unread —
   * SSR and tests are deterministic here; the effect upgrades to the
   * live media query once mounted.
   */
  readonly systemScheme?: 'dark' | 'light' | undefined;
  readonly children: ReactNode;
};

export function ThemeProvider({
  theme = 'system',
  reducedMotion = false,
  textScale = 1,
  systemScheme = 'dark',
  children,
}: ThemeProviderProps) {
  const [liveScheme, setLiveScheme] = useState<'dark' | 'light'>(systemScheme);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setLiveScheme(query.matches ? 'dark' : 'light');
    const onChange = (e: MediaQueryListEvent) => {
      setLiveScheme(e.matches ? 'dark' : 'light');
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const scheme = resolveTheme(theme, liveScheme);
  const value = useMemo<Theme>(
    () => ({
      scheme,
      reducedMotion,
      // Same clamp as the native theme — the floor guards a
      // degenerate value zeroing text, the cap holds 200% zoom.
      textScale: Math.min(2, Math.max(0.5, textScale)),
    }),
    [scheme, reducedMotion, textScale],
  );
  return (
    <ThemeContext.Provider value={value}>
      <div
        className={`ui-web t-${scheme}`}
        data-reduced-motion={reducedMotion ? 'true' : undefined}
        style={{ '--ui-web-text-scale': value.textScale } as CSSProperties}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) {
    throw new Error('useTheme requires a ThemeProvider');
  }
  return theme;
}
