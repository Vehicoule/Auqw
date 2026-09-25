import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEqual } from '@auqw/application/testing';
import { isShellError } from '../shared/errors.ts';
import { createSecureStore } from './secure-store.ts';
import type { SafeStorageLike } from './secure-store.ts';

const WORKING: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (encrypted) => {
    const text = Buffer.from(encrypted).toString('utf8');
    if (!text.startsWith('enc:')) {
      throw new Error('decrypt failed');
    }
    return text.slice(4);
  },
};

const UNAVAILABLE: SafeStorageLike = {
  ...WORKING,
  isEncryptionAvailable: () => false,
};

async function assertThrowsKind(
  promise: Promise<unknown>,
  kind: string,
): Promise<void> {
  try {
    await promise;
  } catch (thrown) {
    assert(
      isShellError(thrown) && thrown.kind === kind,
      `expected ${kind}, got ${JSON.stringify(thrown)}`,
    );
    return;
  }
  throw new Error(`expected throw with ${kind}`);
}

export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-secure-'));
  try {
    const store = createSecureStore({ dir: join(dir, 'secure'), safeStorage: WORKING });

    // Round-trip: set → get → delete → get returns null.
    await store.set('session.token', 's3cret');
    assertEqual(await store.get('session.token'), 's3cret');
    await store.set('session.token', 'rotated');
    assertEqual(await store.get('session.token'), 'rotated');
    // The write publishes atomically — no staging residue survives.
    assertEqual(
      readdirSync(join(dir, 'secure')).filter((f) => f.endsWith('.tmp'))
        .length,
      0,
      'no staging files left behind',
    );
    await store.delete('session.token');
    assertEqual(await store.get('session.token'), null);
    // Deleting a missing key is not an error.
    await store.delete('session.token');

    // Concurrent sets on one key never share a staging path — every
    // published file is complete, whichever rename lands last.
    await Promise.all([
      store.set('race.key', 'a'),
      store.set('race.key', 'bb'),
      store.set('race.key', 'ccc'),
    ]);
    const raced = await store.get('race.key');
    assert(
      raced === 'a' || raced === 'bb' || raced === 'ccc',
      `concurrent set published a complete value, got ${raced}`,
    );
    assertEqual(
      readdirSync(join(dir, 'secure')).filter((f) => f.endsWith('.tmp'))
        .length,
      0,
      'no staging residue after concurrent sets',
    );

    // Corrupt content surfaces typed errors.
    writeFileSync(join(dir, 'secure', 'bad.b64'), '\u0000\u0001!!!', 'utf8');
    await assertThrowsKind(store.get('bad'), 'corrupt-state');

    // No encryption backend → every operation fails 'unavailable' and
    // nothing is written in plaintext.
    const sealed = createSecureStore({
      dir: join(dir, 'sealed'),
      safeStorage: UNAVAILABLE,
    });
    await assertThrowsKind(sealed.get('k'), 'unavailable');
    await assertThrowsKind(sealed.set('k', 'v'), 'unavailable');
    await assertThrowsKind(sealed.delete('k'), 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
