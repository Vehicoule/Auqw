import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { isShellError } from '../shared/errors.ts';
import { createSecureStore, type SafeStorageLike } from './secure-store.ts';
import {
  createSyncKeysHandler,
  migrateSyncCustody,
} from './sync-keys.ts';
import {
  fingerprintOf,
  generateIdentity,
} from '../utility/sync-crypto.ts';
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

function device(
  id: string,
  opts: { pub?: string; fp?: string; name?: string } = {},
): SyncDeviceRecord {
  // fp is bound to pub by the validator — fixtures need real keys.
  const pub = opts.pub ?? generateIdentity().pub;
  return {
    id,
    name: opts.name ?? 'phone',
    pub,
    fp: opts.fp ?? fingerprintOf(pub),
    pairedAt: 1,
    lastSeenAt: 1,
  };
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
    const d1 = device('dev-aaaa0001');
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
    const sharedPub = generateIdentity().pub;
    await handler({
      op: 'device-put',
      record: device('dev-old00001', { pub: sharedPub }),
    });
    await handler({
      op: 'device-put',
      record: device('dev-new00001', { pub: sharedPub }),
    });
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
        record: device(`dev-cap-${String(i).padStart(4, '0')}`),
      });
    }
    const raced = await Promise.allSettled([
      handler({
        op: 'device-put',
        record: device('dev-race-a01'),
      }),
      handler({
        op: 'device-put',
        record: device('dev-race-b01'),
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

    // custody migration: pre-split installs kept sync entries in the
    // renderer-facing dir — they move, non-sync entries stay put, and
    // an existing destination entry wins.
    const oldDir = join(root, 'legacy-secure');
    const newDir = join(root, 'sync-secure');
    const oldStore = createSecureStore({ dir: oldDir, safeStorage: WORKING });
    const legacyIdentity = generateIdentity();
    await oldStore.set('auqw.sync.identity', JSON.stringify(legacyIdentity));
    const phone = device('dev-legacy01');
    await oldStore.set(`auqw.sync.device.${phone.id}`, JSON.stringify(phone));
    await oldStore.set('session.token', 'renderer-owned');
    mkdirSync(newDir, { recursive: true });
    const keptNew = device('dev-newer001');
    await createSecureStore({ dir: newDir, safeStorage: WORKING }).set(
      `auqw.sync.device.${keptNew.id}`,
      JSON.stringify(keptNew),
    );

    await migrateSyncCustody(oldDir, newDir);

    assert(!existsSync(join(oldDir, 'auqw.sync.identity.b64')));
    assert(!existsSync(join(oldDir, `auqw.sync.device.${phone.id}.b64`)));
    assert(
      existsSync(join(oldDir, 'session.token.b64')),
      'non-sync entries stay in the renderer-facing dir',
    );
    const migrated = createSyncKeysHandler({
      secure: createSecureStore({ dir: newDir, safeStorage: WORKING }),
      dir: newDir,
    });
    const gotBack = (await migrated({ op: 'identity-get' })) as {
      identity: { pub: string } | null;
    };
    assertEqual(
      gotBack.identity?.pub,
      legacyIdentity.pub,
      'identity migrated',
    );
    const devicesListed = (await migrated({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
    };
    assertDeepEqual(
      devicesListed.devices.map((d) => d.id).sort(),
      ['dev-legacy01', 'dev-newer001'].sort(),
      'migrated + pre-existing devices both readable',
    );
    // Re-running is idempotent — an upgrade that raced a first boot
    // doesn't clobber the destination.
    await migrateSyncCustody(oldDir, newDir);

    // First boot after upgrade: the custody dir doesn't exist until
    // the store's first set — the move creates it.
    const late = device('dev-late0001');
    await oldStore.set(
      `auqw.sync.device.${late.id}`,
      JSON.stringify(late),
    );
    const freshDir = join(root, 'custody-fresh');
    await migrateSyncCustody(oldDir, freshDir);
    assert(
      existsSync(join(freshDir, `auqw.sync.device.${late.id}.b64`)),
      'migration creates the custody dir it moves into',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
