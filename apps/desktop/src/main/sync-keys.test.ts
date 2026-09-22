import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEqual } from '@auqw/application/testing';
import { isShellError } from '../shared/errors.ts';
import { createSecureStore, type SafeStorageLike } from './secure-store.ts';
import { createSyncKeysHandler } from './sync-keys.ts';
import { generateIdentity } from '../utility/sync-crypto.ts';
import type { SyncDeviceRecord } from '../utility/sync-keys.ts';

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

function device(id: string, fp: string, name = 'phone'): SyncDeviceRecord {
  return { id, name, pub: `pub-${id}`, fp, pairedAt: 1, lastSeenAt: 1 };
}

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
  const root = mkdtempSync(join(tmpdir(), 'auqw-synckeys-'));
  try {
    const dir = join(root, 'secure');
    const handler = createSyncKeysHandler({
      secure: createSecureStore({ dir, safeStorage: WORKING }),
      dir,
    });

    // identity: absent → set → present; a second set is refused.
    const empty = (await handler({ op: 'identity-get' })) as {
      identity: unknown;
    };
    assertEqual(empty.identity, null, 'identity starts absent');
    const identity = generateIdentity();
    assertEqual(
      await handler({ op: 'identity-set', identity }),
      null,
      'identity installs',
    );
    const got = (await handler({ op: 'identity-get' })) as {
      identity: unknown;
    };
    assertEqual(
      JSON.stringify(got.identity),
      JSON.stringify(identity),
      'identity round-trips',
    );
    await assertThrowsKind(
      handler({ op: 'identity-set', identity }),
      'invalid-request',
    );

    // devices: put → list → delete; record content rides the op.
    const d1 = device('dev-aaaa0001', 'a'.repeat(64));
    await handler({ op: 'device-put', record: d1 });
    const listed = (await handler({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
      skipped: number;
    };
    assertEqual(listed.devices.length, 1, 'one device listed');
    assertEqual(listed.devices[0]?.id, 'dev-aaaa0001');
    assertEqual(listed.skipped, 0);
    // lastSeen updates land through put on the same id.
    await handler({
      op: 'device-put',
      record: { ...d1, lastSeenAt: 99 },
    });
    const relisted = (await handler({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
    };
    assertEqual(relisted.devices[0]?.lastSeenAt, 99);
    await handler({ op: 'device-delete', id: 'dev-aaaa0001' });
    const afterDelete = (await handler({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
    };
    assertEqual(afterDelete.devices.length, 0, 'delete removes the record');

    // A re-pair of the same key under a new id evicts the stale id.
    const fp = 'f'.repeat(64);
    await handler({ op: 'device-put', record: device('dev-old00001', fp) });
    await handler({ op: 'device-put', record: device('dev-new00001', fp) });
    const deduped = (await handler({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
    };
    assertEqual(deduped.devices.length, 1, 'same-fp re-pair dedupes');
    assertEqual(deduped.devices[0]?.id, 'dev-new00001');

    // Bad ops and over-cap registries reject typed.
    await assertThrowsKind(handler({ op: 'nope' }), 'invalid-request');
    await assertThrowsKind(
      handler({ op: 'device-put', record: { id: 'x' } }),
      'invalid-request',
    );

    // Concurrent puts serialize: fill to cap-1, race two new fps —
    // exactly one wins, the registry never overshoots the cap.
    await handler({ op: 'device-delete', id: 'dev-new00001' });
    for (let i = 0; i < 63; i += 1) {
      await handler({
        op: 'device-put',
        record: device(
          `dev-cap-${String(i).padStart(4, '0')}`,
          `${i.toString(16).padStart(4, '0')}${'0'.repeat(60)}`,
        ),
      });
    }
    const raced = await Promise.allSettled([
      handler({
        op: 'device-put',
        record: device('dev-race-a01', 'a'.repeat(64)),
      }),
      handler({
        op: 'device-put',
        record: device('dev-race-b01', 'b'.repeat(64)),
      }),
    ]);
    const winners = raced.filter((r) => r.status === 'fulfilled');
    const losers = raced.filter((r) => r.status === 'rejected');
    assertEqual(winners.length, 1, 'exactly one racing put wins');
    assertEqual(losers.length, 1);
    assert(
      isShellError((losers[0] as PromiseRejectedResult).reason) &&
        (losers[0] as PromiseRejectedResult).reason.kind ===
          'unavailable',
      'the loser is a typed cap reject',
    );
    const capped = (await handler({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
    };
    assertEqual(capped.devices.length, 64, 'registry stays inside cap');

    // safeStorage down → every op unavailable, nothing plaintext.
    const sealedDir = join(root, 'sealed');
    mkdirSync(join(sealedDir), { recursive: true });
    // A device file exists but cannot be decrypted — the dead backend
    // surfaces instead of silently listing nothing.
    writeFileSync(
      join(sealedDir, 'auqw.sync.device.dev-dead0001.b64'),
      'aGVsbG8=',
      'utf8',
    );
    const sealed = createSyncKeysHandler({
      secure: createSecureStore({
        dir: sealedDir,
        safeStorage: UNAVAILABLE,
      }),
      dir: sealedDir,
    });
    await assertThrowsKind(sealed({ op: 'identity-get' }), 'unavailable');
    await assertThrowsKind(sealed({ op: 'device-list' }), 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
