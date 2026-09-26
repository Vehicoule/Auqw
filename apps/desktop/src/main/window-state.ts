import { mkdirSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  errorCode,
  isBoolean,
  isFiniteNumber,
  isRecord,
  isSafeNonNegativeInt,
} from '../shared/check.ts';
import type { ShellError } from '../shared/errors.ts';
import { shellError } from '../shared/errors.ts';

export type WindowState = {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
};

export const MIN_WINDOW_WIDTH = 640;
export const MIN_WINDOW_HEIGHT = 480;

export function defaultWindowState(): WindowState {
  return { width: 1280, height: 800, maximized: false };
}

// Legacy floor: states saved before the window minimums existed are
// still valid input; undersized dimensions are clamped on load rather
// than discarding the placement and maximized flag with them.
const SAVED_MIN_DIMENSION = 200;

function isDimension(value: unknown): value is number {
  return (
    isSafeNonNegativeInt(value) &&
    value >= SAVED_MIN_DIMENSION &&
    value <= 16_384
  );
}

function clampDimension(value: number, minimum: number): number {
  return value < minimum ? minimum : value;
}

function isCoordinate(value: unknown): value is number {
  return (
    isFiniteNumber(value) &&
    Number.isInteger(value) &&
    Math.abs(value) <= 32_768
  );
}

/**
 * Strict shape check — a file that is partially valid restores nothing;
 * guessing bounds from corrupt data is worse than defaults.
 */
export function parseWindowState(value: unknown): WindowState | null {
  if (!isRecord(value)) {
    return null;
  }
  const { width, height, x, y, maximized } = value;
  if (
    !isDimension(width) ||
    !isDimension(height) ||
    !isBoolean(maximized)
  ) {
    return null;
  }
  const clamped = {
    width: clampDimension(width, MIN_WINDOW_WIDTH),
    height: clampDimension(height, MIN_WINDOW_HEIGHT),
    maximized,
  };
  if (x === undefined && y === undefined) {
    return clamped;
  }
  if (isCoordinate(x) && isCoordinate(y)) {
    return { ...clamped, x, y };
  }
  return null;
}

export type LoadedWindowState = {
  readonly state: WindowState;
  readonly error: ShellError | null;
};

export async function loadWindowState(
  path: string,
): Promise<LoadedWindowState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (thrown) {
    if (errorCode(thrown) === 'ENOENT') {
      return { state: defaultWindowState(), error: null };
    }
    return {
      state: defaultWindowState(),
      error: shellError('io-error', 'window state file unreadable'),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      state: defaultWindowState(),
      error: shellError('corrupt-state', 'window state file is not json'),
    };
  }
  const state = parseWindowState(parsed);
  if (state === null) {
    return {
      state: defaultWindowState(),
      error: shellError('corrupt-state', 'window state shape is invalid'),
    };
  }
  return { state, error: null };
}

export async function saveWindowState(
  path: string,
  state: WindowState,
): Promise<ShellError | null> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFileAsync(path, JSON.stringify(state), 'utf8');
    return null;
  } catch {
    return shellError('io-error', 'window state could not be written');
  }
}

/** Synchronous variant for `close`/`will-quit`, where async may not finish. */
export function saveWindowStateSync(
  path: string,
  state: WindowState,
): ShellError | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), 'utf8');
    return null;
  } catch {
    return shellError('io-error', 'window state could not be written');
  }
}
