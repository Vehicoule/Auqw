import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionCodeOf } from './version-code.mjs';

// PackageManager refuses an install unless versionCode strictly rises,
// so every ordering a real release line can produce has to hold. Two
// collisions made it in once already: two channels sharing one counter,
// and a patch number bleeding into the next minor.
const code = (version) => {
  const value = versionCodeOf(version);
  assert.notEqual(value, null, `${version} must be orderable`);
  return value;
};

const assertRises = (versions) => {
  for (let i = 1; i < versions.length; i += 1) {
    const older = code(versions[i - 1]);
    const newer = code(versions[i]);
    assert.ok(
      newer > older,
      `${versions[i]} (${newer}) must outrank ${versions[i - 1]} (${older})`,
    );
  }
};

test('channels are disjoint and ordered', () => {
  assertRises(['0.0.1-alpha.1', '0.0.1-beta.1', '0.0.1-rc.1', '0.0.1']);
  // A channel change outranks the same counter on the lower channel.
  assert.notEqual(code('0.0.1-alpha.1'), code('0.0.1-beta.1'));
});

test('the counter rises within one channel', () => {
  assertRises(['0.0.1-alpha.1', '0.0.1-alpha.2', '0.0.1-alpha.332']);
});

test('a patch bump outranks every prerelease before it', () => {
  assertRises(['0.0.1-rc.332', '0.0.1', '0.0.2-alpha.0']);
});

test('a minor bump outranks patch 99 — no bleed into the next minor', () => {
  assertRises(['0.0.99-rc.332', '0.1.0-alpha.0']);
  assertRises(['0.99.0-rc.332', '1.0.0-alpha.0']);
});

test('a major bump outranks minor 99', () => {
  assertRises(['0.99.99-rc.332', '1.0.0-alpha.0']);
});

test('every code stays under the Android ceiling', () => {
  assert.ok(code('200.99.99') < 2_100_000_000);
});

test('unorderable versions are refused, not guessed', () => {
  for (const version of [
    '0.0.1-nightly.1',
    '0.0.1-alpha',
    '0.0.1-alpha.01',
    '0.0.1-Alpha.1',
    '0.0.1-alpha.333',
    '0.0.100-alpha.1',
    '0.100.0-alpha.1',
    '201.0.0',
    'v0.0.1-alpha.1',
  ]) {
    assert.equal(versionCodeOf(version), null, `${version} must be refused`);
  }
});

test('the stamped alpha.1 code is stable', () => {
  // apps/mobile/app.config.ts carries this literal, and stamp-version's
  // --check rejects drift between the two.
  assert.equal(code('0.0.1-alpha.1'), 1001);
});
