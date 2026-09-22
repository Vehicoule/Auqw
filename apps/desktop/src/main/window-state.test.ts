import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import {
  defaultWindowState,
  loadWindowState,
  parseWindowState,
  saveWindowState,
} from './window-state.ts';

export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-winstate-'));
  try {
    const path = join(dir, 'window-state.json');

    // Missing file → defaults, no error.
    const missing = await loadWindowState(path);
    assertDeepEqual(missing.state, defaultWindowState());
    assertEqual(missing.error, null);

    // Corrupt JSON → defaults + typed corrupt-state.
    writeFileSync(path, '{not json', 'utf8');
    const corrupt = await loadWindowState(path);
    assertDeepEqual(corrupt.state, defaultWindowState());
    assert(corrupt.error !== null && corrupt.error.kind === 'corrupt-state');

    // Well-formed JSON but invalid shape → same fallback.
    writeFileSync(
      path,
      JSON.stringify({ width: 'wide', height: 600, maximized: false }),
      'utf8',
    );
    const wrongType = await loadWindowState(path);
    assertDeepEqual(wrongType.state, defaultWindowState());
    assert(wrongType.error !== null && wrongType.error.kind === 'corrupt-state');

    // Missing required field → invalid shape.
    writeFileSync(path, JSON.stringify({ width: 800, height: 600 }), 'utf8');
    const partial = await loadWindowState(path);
    assertDeepEqual(partial.state, defaultWindowState());
    assert(partial.error !== null && partial.error.kind === 'corrupt-state');

    // x without y is corrupt — half a position restores nothing.
    writeFileSync(
      path,
      JSON.stringify({ width: 800, height: 600, x: 10, maximized: false }),
      'utf8',
    );
    const halfPos = await loadWindowState(path);
    assertDeepEqual(halfPos.state, defaultWindowState());
    assert(halfPos.error !== null && halfPos.error.kind === 'corrupt-state');

    // Out-of-range dimensions are rejected.
    writeFileSync(
      path,
      JSON.stringify({ width: 40, height: 600, maximized: false }),
      'utf8',
    );
    const tiny = await loadWindowState(path);
    assertDeepEqual(tiny.state, defaultWindowState());
    assert(tiny.error !== null);

    // Valid state restores exactly, including position + maximized.
    const good = {
      width: 1024,
      height: 700,
      x: 12,
      y: 40,
      maximized: true,
    };
    writeFileSync(path, JSON.stringify(good), 'utf8');
    const restored = await loadWindowState(path);
    assertDeepEqual(restored.state, good);
    assertEqual(restored.error, null);

    // Save → load round-trips; save also creates missing directories.
    const nested = join(dir, 'deeper', 'state.json');
    const state = { width: 900, height: 640, maximized: false };
    const saveError = await saveWindowState(nested, state);
    assertEqual(saveError, null);
    const roundTripped = await loadWindowState(nested);
    assertDeepEqual(roundTripped.state, state);
    assertEqual(roundTripped.error, null);

    // parseWindowState accepts exactly the documented shapes.
    assertDeepEqual(
      parseWindowState({ width: 800, height: 600, maximized: false }),
      { width: 800, height: 600, maximized: false },
    );
    assertEqual(parseWindowState(null), null);
    assertEqual(parseWindowState('text'), null);
    assertEqual(
      parseWindowState({ width: 800, height: 600, maximized: 'yes' }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
