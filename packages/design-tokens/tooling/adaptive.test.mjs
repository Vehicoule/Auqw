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
      warn: '#a03838',
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
    for (const surface of ['canvas', 'stage', 'deep', 'raised']) {
      check(
        `${role} holds 4.5 on ${surface}`,
        contrast(d.values[role], d.values[surface]) >= 4.5,
      );
    }
  }
  check(
    'sel tints accentSoft at the bounded alpha',
    d.values.accentSoft === 'rgba(28,74,99,0.14)',
  );
  check(
    'warn nudges when it fails on the raised surface',
    d.values.warn !== '#a03838' &&
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
    for (const surface of ['canvas', 'stage', 'deep', 'raised']) {
      check(
        `light ${role} holds 4.5 on ${surface}`,
        contrast(d.values[role], d.values[surface]) >= 4.5,
      );
    }
  }
  check(
    'no sel → accentSoft is accent alpha',
    d.values.accentSoft === 'rgba(13,79,168,0.14)',
  );
}

// ---------- built-in reproduction: STEPS must round-trip the built-ins ----------
{
  // Derived surfaces come out neutral — compare by luminance step, not
  // per-channel hex (the built-ins carry a slight cool tint a neutral
  // derivative can't reproduce).
  const near = (a, b, tol = 0.01) => Math.abs(luminance(a) - luminance(b)) <= tol;
  const dark = deriveScheme(
    { scheme: 'dark', palette: { bg: '#242424', fg: '#ececf0' } },
    'dark',
  );
  check('dark palette is derived, not the fallback', dark.values !== schemes.dark);
  check('dark palette reproduces dark stage', near(dark.values.stage, '#1e1e1e'));
  check('dark palette reproduces dark deep', near(dark.values.deep, '#191919'));
  check('dark palette reproduces dark raised', near(dark.values.raised, '#303030'));
  const light = deriveScheme(
    { scheme: 'light', palette: { bg: '#fafafa', fg: '#232326' } },
    'light',
  );
  check('light palette is derived, not the fallback', light.values !== schemes.light);
  check('light palette reproduces light stage', near(light.values.stage, '#ececee'));
  check('light palette reproduces light deep', near(light.values.deep, '#d8d8dd'));
  check('light palette reproduces light raised', near(light.values.raised, '#ffffff'));
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

{
  // Mid-gray canvas: black fg clears the lighter raised surface but
  // vanishes on the canvas — the guard must hold on every surface.
  const d = deriveScheme(
    {
      scheme: 'dark',
      palette: { bg: '#4f4f4f', fg: '#000000' },
    },
    'dark',
  );
  check('mid-gray palette stays derived', d.values !== schemes.dark);
  for (const role of TEXT_ROLES) {
    for (const surface of ['canvas', 'stage', 'deep', 'raised']) {
      check(
        `mid-gray ${role} holds 4.5 on ${surface}`,
        contrast(d.values[role], d.values[surface]) >= 4.5,
      );
    }
  }
}

// ---------- degenerate palette → honest built-in fallback ----------
{
  // bg luminance ~0.12: dark enough to pick the white pole, bright
  // enough that raised pushes past the pole's reach → honest fallback.
  const d = deriveScheme(
    {
      scheme: 'dark',
      palette: { bg: '#626262', fg: '#626262', accent: '#626262' },
    },
    'dark',
  );
  check(
    'palette with no readable pole falls back to the built-in',
    d.values === schemes.dark && d.scheme === 'dark',
  );
}

// ---------- property: the 4.5 invariant over random palettes ----------
{
  // Deterministic LCG so failures reproduce.
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const hex = () =>
    '#' +
    [0, 1, 2]
      .map(() => Math.floor(rand() * 256).toString(16).padStart(2, '0'))
      .join('');
  let derived = 0;
  let fellBack = 0;
  for (let i = 0; i < 400; i++) {
    const flag = rand() < 0.5 ? 'dark' : 'light';
    const d = deriveScheme(
      {
        scheme: flag,
        palette: {
          bg: hex(),
          fg: hex(),
          accent: hex(),
          warn: hex(),
          sel: hex(),
        },
      },
      flag,
    );
    if (d.values === schemes[d.scheme]) {
      fellBack += 1; // honest fallback — no invariant to check
      continue;
    }
    derived += 1;
    for (const role of TEXT_ROLES) {
      for (const surface of ['canvas', 'stage', 'deep', 'raised']) {
        check(
          `p${i} ${role} ≥4.5 on ${surface}`,
          contrast(d.values[role], d.values[surface]) >= 4.5,
        );
      }
    }
  }
  check(
    'property run exercises both outcomes',
    derived > 50 && fellBack > 20,
  );
}

// ---------- schemeCssVars ----------
{
  const vars = schemeCssVars(schemes.dark);
  check('css vars are kebab-cased', vars['--text-primary'] === '#ececf0');
  check('css vars cover canvas', vars['--canvas'] === '#242424');
  check(
    'css vars cover every role',
    Object.keys(vars).length === Object.keys(schemes.dark).length,
  );
}

if (failures > 0) {
  process.exit(1);
}
console.log('adaptive: all checks passed');
