// Unit coverage for the adaptive scheme generator — derivation,
// contrast guard, and honest fallbacks. Runs under type-stripping
// (plain .mjs like the rest of this package's tooling).
import { deriveScheme, schemeCssVars } from '../src/adaptive.ts';
import { schemes } from '../src/tokens.ts';

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL ${message}`);
};
const check = (name, cond) => {
  if (!cond) fail(name);
};

const parse = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const lin = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = parse(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const TEXT_ROLES = [
  'textPrimary',
  'textBright',
  'textSecondary',
  'accent',
  'warn',
  'liked',
];

// ---------- flag / absent source → honest built-in ----------
{
  const none = deriveScheme(null, 'dark');
  check('null source resolves to the dark built-in', none.values === schemes.dark);
  const flagOnly = deriveScheme({ scheme: 'light' }, 'dark');
  check('flag-only source resolves to the light built-in', flagOnly.values === schemes.light);
}

// ---------- accent-only palette → overlay on the flag's base ----------
{
  const d = deriveScheme(
    { scheme: 'dark', palette: { accent: '#00ff88' } },
    'dark',
  );
  check('accent-only keeps the dark scheme', d.scheme === 'dark');
  check('accent-only swaps accent', d.values.accent === '#00ff88');
  check(
    'accent-only derives accentSoft at 14%',
    d.values.accentSoft === 'rgba(0,255,136,0.14)',
  );
  check('accent-only keeps base canvas', d.values.canvas === schemes.dark.canvas);
  check('accent-only keeps base hairline', d.values.hairline === schemes.dark.hairline);
}

// ---------- full palette, dark ----------
{
  const src = {
    scheme: 'dark',
    palette: {
      bg: '#241f1a',
      fg: '#e8e2d5',
      accent: '#38b8ff',
      warn: '#ff5555',
      sel: '#1c4a63',
    },
  };
  const d = deriveScheme(src, 'dark');
  check('full palette keeps dark polarity', d.scheme === 'dark');
  check('canvas is the source bg', d.values.canvas === '#241f1a');
  check(
    'surface order deep < stage < canvas < raised',
    luminance(d.values.deep) < luminance(d.values.stage) &&
      luminance(d.values.stage) < luminance(d.values.canvas) &&
      luminance(d.values.canvas) < luminance(d.values.raised),
  );
  for (const role of TEXT_ROLES) {
    check(
      `${role} holds 4.5 on canvas`,
      contrast(d.values[role], d.values.canvas) >= 4.5,
    );
    check(
      `${role} holds 4.5 on raised`,
      contrast(d.values[role], d.values.raised) >= 4.5,
    );
  }
  check('sel wins accentSoft', d.values.accentSoft === '#1c4a63');
  check(
    'warn nudges when it fails on the raised surface',
    d.values.warn !== '#ff5555' &&
      contrast(d.values.warn, d.values.raised) >= 4.5,
  );
  check('hairline is an fg alpha', d.values.hairline === 'rgba(232,226,213,0.14)');
}

// ---------- full palette, light ----------
{
  const d = deriveScheme(
    {
      scheme: 'light',
      palette: { bg: '#f4f1ec', fg: '#242019', accent: '#0d4fa8' },
    },
    'light',
  );
  check('full palette keeps light polarity', d.scheme === 'light');
  check(
    'light surface order deep < stage < canvas < raised',
    luminance(d.values.deep) < luminance(d.values.stage) &&
      luminance(d.values.stage) < luminance(d.values.canvas) &&
      luminance(d.values.canvas) < luminance(d.values.raised),
  );
  for (const role of TEXT_ROLES) {
    check(
      `light ${role} holds 4.5 on canvas`,
      contrast(d.values[role], d.values.canvas) >= 4.5,
    );
  }
  check(
    'no sel → accentSoft is accent alpha',
    d.values.accentSoft === 'rgba(13,79,168,0.14)',
  );
}

// ---------- polarity follows the palette's bg, not the flag ----------
{
  const d = deriveScheme(
    {
      scheme: 'dark',
      palette: { bg: '#f8f8f8', fg: '#202020', accent: '#0057c2' },
    },
    'dark',
  );
  check('a light palette under a dark flag derives light', d.scheme === 'light');
}

// ---------- contrast guard ----------
{
  // Low-contrast fg on a dark bg: the guard must pull it to 4.5.
  const d = deriveScheme(
    {
      scheme: 'dark',
      palette: { bg: '#101010', fg: '#5c5c5c', accent: '#101010' },
    },
    'dark',
  );
  check(
    'dim fg nudges up to ≥4.5 on the worst surface',
    contrast(d.values.textPrimary, d.values.raised) >= 4.5,
  );
  check(
    'invisible accent nudges up to ≥4.5',
    contrast(d.values.accent, d.values.raised) >= 4.5,
  );
}

// ---------- degenerate palette → honest built-in fallback ----------
{
  // bg luminance ~0.09: dark enough to pick the white pole, bright
  // enough that raised pushes past the pole's reach → honest fallback.
  const d = deriveScheme(
    {
      scheme: 'dark',
      palette: { bg: '#555555', fg: '#555555', accent: '#555555' },
    },
    'dark',
  );
  check(
    'palette with no readable pole falls back to the built-in',
    d.values === schemes.dark && d.scheme === 'dark',
  );
}

// ---------- schemeCssVars ----------
{
  const vars = schemeCssVars(schemes.dark);
  check('css vars are kebab-cased', vars['--text-primary'] === '#e6e1d8');
  check('css vars cover canvas', vars['--canvas'] === '#161512');
  check(
    'css vars cover every role',
    Object.keys(vars).length === Object.keys(schemes.dark).length,
  );
}

if (failures > 0) {
  process.exit(1);
}
console.log('adaptive: all checks passed');
