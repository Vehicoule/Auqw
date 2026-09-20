// Checks: generated outputs byte-match the DTCG source (never writes),
// all required token keys/types exist, spacing is on the defined scale,
// no token mentions shadows, and every text/accent role meets WCAG AA
// contrast (>=4.5) on its scheme canvas. Prints a deterministic JSON
// object of rounded contrast ratios for independent inspection.
//
// `--check` limits the run to the generated-output byte-compare.
import { readFileSync } from 'node:fs';
import { renderTokens } from './generate.mjs';

const root = new URL('..', import.meta.url);
const source = JSON.parse(
  readFileSync(new URL('tokens.json', root), 'utf8'),
);
const { ts, css } = renderTokens(source);

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL ${message}`);
};

// ---------- generated-output byte-compare (never writes) ----------
const tsOnDisk = readFileSync(new URL('src/tokens.ts', root), 'utf8');
const cssOnDisk = readFileSync(new URL('dist/tokens.css', root), 'utf8');
if (ts !== tsOnDisk) {
  fail('src/tokens.ts is stale — run pnpm generate');
}
if (css !== cssOnDisk) {
  fail('dist/tokens.css is stale — run pnpm generate');
}

if (process.argv.includes('--check')) {
  if (failures > 0) {
    process.exit(1);
  }
  console.log('check: generated outputs match tokens.json');
  process.exit(0);
}

// ---------- required keys/types ----------
const isLeaf = (node) =>
  node !== null &&
  typeof node === 'object' &&
  typeof node['$type'] === 'string' &&
  '$value' in node;

const ROLES = [
  'canvas',
  'stage',
  'deep',
  'raised',
  'textPrimary',
  'textBright',
  'textSecondary',
  'divider',
  'accent',
  'accentSoft',
  'warn',
  'liked',
  'fg08',
  'fg18',
  'fg25',
  'fg40',
  'glass',
  'hairline',
];
const SCHEMES = ['dark', 'light', 'oled'];
const SPACING = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  display: 48,
};
const RADIUS = { frame: 0, control: 6, float: 12, thumb: 5, pill: 999 };
const SIZES = {
  trackRow: 50,
  touch: 44,
  navbarAndroid: 72,
  navbarIos: 58,
  miniPlayer: 52,
  artworkRing: 48,
};
const STROKES = { hairline: 1, progress: 2, progressAndroid: 2.5 };
const FAMILIES = {
  regular: 'JetBrainsMono_400Regular',
  medium: 'JetBrainsMono_500Medium',
  bold: 'JetBrainsMono_700Bold',
};
const STYLES = {
  display: { fontSize: 20, lineHeight: 24, fontFamily: 'bold' },
  title: { fontSize: 16, lineHeight: 20, fontFamily: 'bold' },
  heading: { fontSize: 13, lineHeight: 17, fontFamily: 'bold' },
  body: { fontSize: 12, lineHeight: 17, fontFamily: 'medium' },
  metadata: { fontSize: 10, lineHeight: 14, fontFamily: 'regular' },
  label: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: 'bold',
    letterSpacing: 1.2,
  },
};
const MOTION = { press: 120, state: 180, sheet: 300 };

const schemes = source['schemes'];
if (schemes === undefined || typeof schemes !== 'object') {
  fail('schemes group missing');
} else {
  for (const scheme of SCHEMES) {
    const roles = schemes[scheme];
    if (roles === undefined || typeof roles !== 'object') {
      fail(`scheme '${scheme}' missing`);
      continue;
    }
    for (const role of ROLES) {
      const node = roles[role];
      if (!isLeaf(node) || node['$type'] !== 'color') {
        fail(`schemes.${scheme}.${role} missing or not a color leaf`);
      }
    }
    const extra = Object.keys(roles).filter((k) => !ROLES.includes(k));
    if (extra.length > 0) {
      fail(`schemes.${scheme} has unexpected roles: ${extra.join(',')}`);
    }
  }
}

const checkGroup = (actual, expected, label, type) => {
  if (actual === undefined || typeof actual !== 'object') {
    fail(`${label} group missing`);
    return;
  }
  for (const [key, value] of Object.entries(expected)) {
    const node = actual[key];
    if (
      !isLeaf(node) ||
      node['$type'] !== type ||
      node['$value'] !== value
    ) {
      fail(`${label}.${key} must be a ${type} equal to ${value}`);
    }
  }
  const extra = Object.keys(actual).filter(
    (k) => !(k in expected),
  );
  if (extra.length > 0) {
    fail(`${label} has unexpected keys: ${extra.join(',')}`);
  }
};

checkGroup(source['spacing'], SPACING, 'spacing', 'dimension');
checkGroup(source['radius'], RADIUS, 'radius', 'dimension');
checkGroup(source['sizes'], SIZES, 'sizes', 'dimension');
checkGroup(source['strokes'], STROKES, 'strokes', 'dimension');
checkGroup(
  source['typography']?.['families'],
  FAMILIES,
  'typography.families',
  'fontFamily',
);

const styles = source['typography']?.['styles'];
if (styles === undefined || typeof styles !== 'object') {
  fail('typography.styles group missing');
} else {
  for (const [name, spec] of Object.entries(STYLES)) {
    const style = styles[name];
    if (style === undefined || typeof style !== 'object') {
      fail(`typography.styles.${name} missing`);
      continue;
    }
    for (const [prop, value] of Object.entries(spec)) {
      const node = style[prop];
      const expectedType = prop === 'fontFamily' ? 'fontFamily' : 'dimension';
      if (
        !isLeaf(node) ||
        node['$type'] !== expectedType ||
        node['$value'] !== value
      ) {
        fail(
          `typography.styles.${name}.${prop} must be a ${expectedType} equal to ${value}`,
        );
      }
    }
    const extra = Object.keys(style).filter((k) => !(k in spec));
    if (extra.length > 0) {
      fail(`typography.styles.${name} unexpected: ${extra.join(',')}`);
    }
  }
  const extra = Object.keys(styles).filter((k) => !(k in STYLES));
  if (extra.length > 0) {
    fail(`typography.styles unexpected: ${extra.join(',')}`);
  }
}

const motion = source['motion'];
if (motion === undefined || typeof motion !== 'object') {
  fail('motion group missing');
} else {
  for (const [name, value] of Object.entries(MOTION)) {
    if (
      motion[name]?.['$type'] !== 'duration' ||
      motion[name]?.['$value'] !== value
    ) {
      fail(`motion.${name} must be a duration equal to ${value}`);
    }
  }
  if (
    motion['spring']?.['duration']?.['$type'] !== 'duration' ||
    motion['spring']?.['duration']?.['$value'] !== 400 ||
    motion['spring']?.['dampingRatio']?.['$type'] !== 'number' ||
    motion['spring']?.['dampingRatio']?.['$value'] !== 1
  ) {
    fail('motion.spring must be duration 400 / dampingRatio 1');
  }
  if (
    motion['gesture']?.['duration']?.['$type'] !== 'duration' ||
    motion['gesture']?.['duration']?.['$value'] !== 300 ||
    motion['gesture']?.['dampingRatio']?.['$type'] !== 'number' ||
    motion['gesture']?.['dampingRatio']?.['$value'] !== 0.8
  ) {
    fail('motion.gesture must be duration 300 / dampingRatio 0.8');
  }
}

// ---------- no shadow tokens anywhere ----------
const scanShadows = (node, path) => {
  if (node === null || typeof node !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase().includes('shadow')) {
      fail(`shadow key at ${path}.${key}`);
    }
    if (
      typeof value === 'string' &&
      value.toLowerCase().includes('shadow')
    ) {
      fail(`shadow value at ${path}.${key}`);
    }
    scanShadows(value, `${path}.${key}`);
  }
};
scanShadows(source, 'tokens');

// ---------- contrast (hex roles only), verbatim recipe ----------
const linear = (x) =>
  x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const luminance = (hex) => {
  const r = linear(parseInt(hex.slice(1, 3), 16) / 255);
  const g = linear(parseInt(hex.slice(3, 5), 16) / 255);
  const b = linear(parseInt(hex.slice(5, 7), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const TEXT_ROLES = [
  'textPrimary',
  'textBright',
  'textSecondary',
  'accent',
  'warn',
  'liked',
];
const HEX = /^#[0-9a-fA-F]{6}$/;
const ratios = {};
for (const scheme of SCHEMES) {
  const roles = schemes?.[scheme] ?? {};
  const canvas = roles['canvas']?.['$value'];
  if (typeof canvas !== 'string' || !HEX.test(canvas)) {
    fail(`contrast ${scheme}.canvas must be a six-digit hex color`);
    continue;
  }
  ratios[scheme] = {};
  for (const role of TEXT_ROLES) {
    const value = roles[role]?.['$value'];
    if (typeof value !== 'string' || !HEX.test(value)) {
      fail(`contrast ${scheme}.${role} must be a six-digit hex color`);
      continue;
    }
    const r = ratio(value, canvas);
    ratios[scheme][role] = Math.round(r * 100) / 100;
    if (r < 4.5) {
      fail(
        `contrast ${scheme}.${role} on canvas = ${r.toFixed(2)} < 4.5`,
      );
    }
  }
}
console.log(JSON.stringify(ratios));

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all token checks passed');
