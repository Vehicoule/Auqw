import { schemes } from './tokens.ts';
import type { SchemeName } from './tokens.ts';

/**
 * OS-palette → scheme derivation (docs/specs/design.md "Scheme
 * sources"). A `ThemeSourcePort` emits a `ThemeSource`; `deriveScheme`
 * turns it into either a built-in scheme or a generated value set that
 * holds every text role at WCAG ≥4.5 against the derived surfaces —
 * and falls back to the built-in scheme honestly when it cannot.
 */

/** Every role a scheme must carry — keyed off the generated constants
    so a new role can never be forgotten here. */
export type SchemeValues = {
  readonly [K in keyof (typeof schemes)[SchemeName]]: string;
};

/** Whatever palette a platform source can report. bg+fg together mean
    "full palette" (Omarchy, KDE, Material You); absent they degrade the
    palette to an accent/warn overlay over the built-in scheme. */
export type AdaptivePalette = {
  readonly bg?: string;
  readonly fg?: string;
  readonly accent?: string;
  readonly warn?: string;
  readonly sel?: string;
};

/** The ThemeSourcePort payload: a polarity flag plus the palette the
    platform exposes (accent-only on most desktops, none on iOS). */
export type ThemeSource = {
  readonly scheme: 'dark' | 'light';
  readonly palette?: AdaptivePalette;
};

export type DerivedTheme = {
  /** The polarity actually used — a full palette's own bg decides it,
      which can disagree with the flag the source carried. */
  readonly scheme: 'dark' | 'light';
  /** A complete scheme. `values === schemes[scheme]` (same reference)
      whenever the source could not be applied — flag-only sources and
      unfixable palettes both render the built-in scheme as-is. */
  readonly values: SchemeValues;
};

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const MIN_CONTRAST = 4.5;

// Surface luminance ratios measured off the built-in ramps: dark
// stage/deep/raised sit at 0.74×/0.55×/1.68× canvas, light at
// 0.88×/0.72×/1.05×. fg-alpha and secondary mixes likewise come from
// the built-ins (hairline 14%, divider ≈fg@16% over bg,
// text.secondary ≈fg 30% toward bg, text.bright ≈±19%/±31% luminance).
const STEPS = {
  dark: { stage: 0.74, deep: 0.55, raised: 1.68, bright: 1.19 },
  light: { stage: 0.88, deep: 0.72, raised: 1.05, bright: 0.31 },
} as const;
const FG_ALPHAS = {
  dark: { hairline: 0.14, fg08: 0.08, fg18: 0.16, fg25: 0.26, fg40: 0.42 },
  light: { hairline: 0.14, fg08: 0.06, fg18: 0.13, fg25: 0.26, fg40: 0.42 },
} as const;
const SECONDARY_MIX = 0.3;
const DIVIDER_MIX = 0.16;
const ACCENT_SOFT_ALPHA = 0.14;

const HEX = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `#rgb`, `#rrggbb`, `#rgba`/`#rrggbbaa` → rgb (alpha ignored — roles
    derive opaque). Returns null on anything else. */
function parseHex(value: string): Rgb | null {
  const m = HEX.exec(value.trim());
  if (m === null) {
    return null;
  }
  const digits = m[1] ?? '';
  const raw = digits.length <= 4 ? digits.slice(0, 3) : digits.slice(0, 6);
  const n = Number.parseInt(
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw,
    16,
  );
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function linearize(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function unlinearize(lin: number): number {
  const s =
    lin <= 0.0031308
      ? lin * 12.92
      : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, s * 255));
}

function relLuminance(rgb: Rgb): number {
  return (
    0.2126 * linearize(rgb[0]) +
    0.7152 * linearize(rgb[1]) +
    0.0722 * linearize(rgb[2])
  );
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Scales relative luminance by `ratio`; linear-space scaling keeps hue. */
function lumStep(rgb: Rgb, ratio: number): Rgb {
  return [
    unlinearize(linearize(rgb[0]) * ratio),
    unlinearize(linearize(rgb[1]) * ratio),
    unlinearize(linearize(rgb[2]) * ratio),
  ];
}

/** Rounds to the emitted 8-bit channel values — guards run on what
    actually ships, not on float intermediates. */
function round(rgb: Rgb): Rgb {
  return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])];
}

function toHex(rgb: Rgb): string {
  const part = (v: number): string =>
    Math.round(v)
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

function alphaOf(rgb: Rgb, a: number): string {
  return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${a})`;
}

/**
 * The contrast guard: nudge a text role toward the readable pole until
 * it clears 4.5:1 against every surface it can render on — a single
 * passing surface says nothing about the rest (a mid-gray canvas can
 * swallow text that a lighter raised row shows). Callers check the
 * pole itself clears the whole set first, so the final jump lands.
 */
function nudgeToContrast(
  value: Rgb,
  surfaces: readonly Rgb[],
  pole: Rgb,
): Rgb {
  let out = value;
  for (let i = 0; i < 16; i++) {
    const rounded = round(out);
    if (
      surfaces.every((s) => contrastRatio(rounded, s) >= MIN_CONTRAST)
    ) {
      return rounded;
    }
    out = mix(out, pole, 0.18);
  }
  return pole;
}

/** Accent-mode: overlay whichever of accent/warn/sel the source sent on
    the built-in scheme of the flag's polarity. */
function overlay(
  flag: 'dark' | 'light',
  palette: AdaptivePalette,
): DerivedTheme {
  const base = schemes[flag];
  const pole = flag === 'dark' ? WHITE : BLACK;
  const surfaces = [base.canvas, base.stage, base.deep, base.raised].map(
    (hex) => parseHex(hex) ?? BLACK,
  );
  // No readable pole over the built-in surfaces → keep the base roles
  // untouched rather than emit text that vanishes on one of them.
  const poleOk = surfaces.every(
    (s) => contrastRatio(pole, s) >= MIN_CONTRAST,
  );
  const sel = palette.sel !== undefined ? parseHex(palette.sel) : null;
  const accent = palette.accent !== undefined ? parseHex(palette.accent) : null;
  const warn = palette.warn !== undefined ? parseHex(palette.warn) : null;
  const values: { -readonly [K in keyof SchemeValues]: string } = {
    ...base,
  };
  // accentSoft is the active-row selection tint — an OS `sel` colors it
  // at the same bounded alpha (opaque sel over light text would erase
  // the label); absent sel it derives as accent @14%.
  const softSrc =
    sel ??
    (accent !== null && poleOk
      ? nudgeToContrast(accent, surfaces, pole)
      : null);
  if (softSrc !== null) {
    values.accentSoft = alphaOf(softSrc, ACCENT_SOFT_ALPHA);
  }
  if (accent !== null && poleOk) {
    values.accent = toHex(nudgeToContrast(accent, surfaces, pole));
  }
  if (warn !== null && poleOk) {
    values.warn = toHex(nudgeToContrast(warn, surfaces, pole));
  }
  return { scheme: flag, values };
}

/** Full-palette mode (bg+fg present): steps, alphas and text roles all
    derive off the source's own colors; polarity follows the bg. */
function fullPalette(palette: AdaptivePalette, bg: Rgb, fg: Rgb): DerivedTheme {
  const dark = contrastRatio(WHITE, bg) >= contrastRatio(BLACK, bg);
  const scheme = dark ? 'dark' : 'light';
  const base = schemes[scheme];
  const steps = dark ? STEPS.dark : STEPS.light;
  const alphas = dark ? FG_ALPHAS.dark : FG_ALPHAS.light;
  const pole = dark ? WHITE : BLACK;

  const raised = lumStep(bg, steps.raised);
  const deep = lumStep(bg, steps.deep);
  // Text roles render on every surface; the rounded emitted values are
  // the guard set — the pole must clear all of them or the palette is
  // unfixable and the built-in scheme stands in honestly.
  const surfaces = [bg, lumStep(bg, steps.stage), deep, raised].map(
    round,
  );
  if (
    !surfaces.every((s) => contrastRatio(pole, s) >= MIN_CONTRAST)
  ) {
    return { scheme, values: base };
  }
  const text = (v: Rgb): Rgb => nudgeToContrast(v, surfaces, pole);

  const textPrimary = text(fg);
  const accentRaw =
    palette.accent !== undefined
      ? (parseHex(palette.accent) ?? parseHex(base.accent) ?? pole)
      : (parseHex(base.accent) ?? pole);
  const accent = text(accentRaw);
  const warnRaw =
    palette.warn !== undefined ? parseHex(palette.warn) : null;
  const sel = palette.sel !== undefined ? parseHex(palette.sel) : null;

  const values: SchemeValues = {
    canvas: toHex(bg),
    stage: toHex(lumStep(bg, steps.stage)),
    deep: toHex(deep),
    raised: toHex(raised),
    textPrimary: toHex(textPrimary),
    textBright: toHex(text(lumStep(fg, steps.bright))),
    textSecondary: toHex(text(mix(fg, bg, SECONDARY_MIX))),
    divider: toHex(mix(bg, textPrimary, DIVIDER_MIX)),
    accent: toHex(accent),
    // `sel` tints the selection surface at the same bounded alpha — an
    // opaque sel behind the standard text roles could erase labels.
    accentSoft: alphaOf(sel ?? accent, ACCENT_SOFT_ALPHA),
    warn: toHex(text(warnRaw ?? parseHex(base.warn) ?? pole)),
    liked: toHex(text(parseHex(base.liked) ?? pole)),
    fg08: alphaOf(textPrimary, alphas.fg08),
    fg18: alphaOf(textPrimary, alphas.fg18),
    fg25: alphaOf(textPrimary, alphas.fg25),
    fg40: alphaOf(textPrimary, alphas.fg40),
    glass: base.glass,
    glassControl: base.glassControl,
    scrim: base.scrim,
    hairline: alphaOf(textPrimary, alphas.hairline),
    thumb: base.thumb,
  };
  return { scheme, values };
}

/**
 * Resolve a source into a scheme. `fallback` is the platform polarity
 * used when the source is absent entirely; otherwise the source's flag
 * (accent-mode) or its palette's own bg (full mode) decides.
 */
export function deriveScheme(
  source: ThemeSource | null | undefined,
  fallback: 'dark' | 'light',
): DerivedTheme {
  const flag = source?.scheme ?? fallback;
  const palette = source?.palette;
  if (palette === undefined) {
    return { scheme: flag, values: schemes[flag] };
  }
  const bg = palette.bg !== undefined ? parseHex(palette.bg) : null;
  const fg = palette.fg !== undefined ? parseHex(palette.fg) : null;
  if (bg === null || fg === null) {
    return overlay(flag, palette);
  }
  return fullPalette(palette, bg, fg);
}

/** CSS custom properties (`--canvas`, `--text-primary`, …) for a
    derived scheme — ui-web emits them inline on the theme root. */
export function schemeCssVars(values: SchemeValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, v] of Object.entries(values)) {
    out[`--${role.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`)}`] = v;
  }
  return out;
}
