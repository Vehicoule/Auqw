import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { resolveTheme, schemes } from '@auqw/design-tokens';
import { deriveScheme, schemeCssVars } from '@auqw/design-tokens/adaptive';
import type { SchemeName, ThemeName } from '@auqw/design-tokens';
import type { ThemeSource } from '@auqw/design-tokens/adaptive';

// The web theme is class-based: the provider emits `ui-web t-<scheme>`
// and every color/space/radius/type value inside resolves through the
// design-tokens stylesheet custom properties — no palette in JS. An
// 'adaptive' theme instead emits the derived values as inline custom
// properties on the same root, over the resolved scheme's class.
export type Theme = {
  readonly scheme: SchemeName;
  readonly reducedMotion: boolean;
  readonly textScale: number;
  /** Resolved canvas/symbol — the desktop shell reports them to main
      so the titlebar overlay re-tints with the canvas. */
  readonly canvas: string;
  readonly textBright: string;
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
  /**
   * The OS palette the 'adaptive' theme derives from — pushed by the
   * desktop main process / mobile system read. `null` (or absent)
   * resolves like 'system'.
   */
  readonly source?: ThemeSource | null | undefined;
  readonly children: ReactNode;
};

export function ThemeProvider({
  theme = 'system',
  reducedMotion = false,
  textScale = 1,
  systemScheme = 'dark',
  source = null,
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
  const derived = useMemo(
    () =>
      theme === 'adaptive' ? deriveScheme(source, liveScheme) : null,
    [theme, source, liveScheme],
  );
  const scheme = derived?.scheme ?? resolveTheme(theme, liveScheme);
  const value = useMemo<Theme>(
    () => ({
      scheme,
      reducedMotion,
      // Same clamp as the native theme — the floor guards a
      // degenerate value zeroing text, the cap holds 200% zoom.
      textScale: Math.min(2, Math.max(0.5, textScale)),
      canvas: derived?.values.canvas ?? schemes[scheme].canvas,
      textBright: derived?.values.textBright ?? schemes[scheme].textBright,
    }),
    [scheme, derived, reducedMotion, textScale],
  );
  // When deriveScheme couldn't apply the source it returns the built-in
  // object itself — the `t-<scheme>` class already carries those vars,
  // so inline overrides only exist for a genuinely derived palette.
  const style = useMemo<CSSProperties>(() => {
    const base: CSSProperties = { '--ui-web-text-scale': value.textScale } as CSSProperties;
    if (derived !== null && derived.values !== schemes[derived.scheme]) {
      return Object.assign(base, schemeCssVars(derived.values));
    }
    return base;
  }, [derived, value.textScale]);
  return (
    <ThemeContext.Provider value={value}>
      <div
        className={`ui-web t-${scheme}`}
        data-reduced-motion={reducedMotion ? 'true' : undefined}
        style={style}
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
