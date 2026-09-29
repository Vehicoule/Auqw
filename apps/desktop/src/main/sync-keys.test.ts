import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  syncHasPairedDevices,
} from './sync-keys.ts';
import { nodeNoise } from '../utility/noise-node.ts';
import type { SyncDeviceRecord } from '../utility/sync-keys.ts';

const { fingerprintOf } = nodeNoise;
const generateIdentity = (): { pub: string; priv: string } =>
  nodeNoise.createIdentity();

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

/** WORKING, plus a decrypt counter — the Keychain-prompt proxy. */
function counting(): { storage: SafeStorageLike; decrypts: () => number } {
  let decrypts = 0;
  return {
    decrypts: () => decrypts,
    storage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`),
      decryptString: (encrypted) => {
        decrypts += 1;
        const text = Buffer.from(encrypted).toString('utf8');
        if (!text.startsWith('enc:')) {
          throw new Error('decrypt failed');
        }
        return text.slice(4);
      },
    },
  };
}

function device(
  id: string,
  opts: { pub?: string; fp?: string; name?: string } = {},
): SyncDeviceRecord {
  // fp is bound to pub by the validator — fixtures need real keys.
  const pub = opts.pub ?? generateIdentity().pub;
  return {
    role: 'caller',
    id,
    name: opts.name ?? 'phone',
    pub,
    fp: opts.fp ?? fingerprintOf(pub),
    pairedAt: 1,
    lastSeenAt: 1,
  };
}

/** The pre-unification stored shape — no `role` tag. Rows written by
 * shipped builds deserialize through custody's legacy reader. */
function legacyShape(
  record: SyncDeviceRecord,
): Record<string, unknown> {
  const { role: _tag, ...row } = record;
  return row;
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
    await oldStore.set(
      `auqw.sync.device.${phone.id}`,
      JSON.stringify(legacyShape(phone)),
    );
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
    // The first custody touch consolidates: legacy per-record files are
    // consumed into the single sealed blob + plaintext mirror.
    assert(
      existsSync(join(newDir, 'auqw.sync.store.b64')),
      'consolidated blob written on first custody op',
    );
    assert(
      existsSync(join(newDir, 'auqw.sync.devices.json')),
      'plaintext device mirror written',
    );
    assert(
      !existsSync(join(newDir, 'auqw.sync.identity.b64')) &&
        readdirSync(newDir).every(
          (f) => !f.startsWith('auqw.sync.device.'),
        ),
      'legacy custody files consumed',
    );
    assert(
      syncHasPairedDevices(newDir),
      'consolidated install stays armed',
    );
    // Re-running is idempotent — an upgrade that raced a first boot
    // doesn't clobber the destination.
    await migrateSyncCustody(oldDir, newDir);

    // First boot after upgrade: the custody dir doesn't exist until
    // the store's first set — the move creates it.
    const late = device('dev-late0001');
    await oldStore.set(
      `auqw.sync.device.${late.id}`,
      JSON.stringify(legacyShape(late)),
    );
    const freshDir = join(root, 'custody-fresh');
    await migrateSyncCustody(oldDir, freshDir);
    assert(
      existsSync(join(freshDir, `auqw.sync.device.${late.id}.b64`)),
      'migration creates the custody dir it moves into',
    );

    // The armed-boot gate: mirror first, pre-consolidation fallback.
    const gDir = join(root, 'gate');
    assertEqual(
      syncHasPairedDevices(gDir),
      false,
      'missing dir is dormant',
    );
    mkdirSync(gDir, { recursive: true });
    assertEqual(
      syncHasPairedDevices(gDir),
      false,
      'empty dir is dormant',
    );
    const gStore = createSecureStore({ dir: gDir, safeStorage: WORKING });
    await gStore.set(
      'auqw.sync.identity',
      JSON.stringify(generateIdentity()),
    );
    assertEqual(
      syncHasPairedDevices(gDir),
      false,
      'a minted identity alone never paired',
    );
    await gStore.set(
      'auqw.sync.device.dev-gate0001',
      JSON.stringify(legacyShape(device('dev-gate0001'))),
    );
    assert(
      syncHasPairedDevices(gDir),
      'a pre-consolidation device record arms',
    );
    // An empty consolidated mirror does not mask an orphaned legacy
    // record — a mid-merge crash or refused prompt still means paired.
    writeFileSync(
      join(gDir, 'auqw.sync.devices.json'),
      JSON.stringify({ v: 1, devices: [] }),
    );
    assert(
      syncHasPairedDevices(gDir),
      'orphaned legacy record still arms under an empty mirror',
    );
    const g2 = join(root, 'gate2');
    mkdirSync(g2, { recursive: true });
    writeFileSync(
      join(g2, 'auqw.sync.devices.json'),
      JSON.stringify({ v: 1, devices: [device('dev-gate0002')] }),
    );
    assert(syncHasPairedDevices(g2), 'a non-empty mirror arms');
    writeFileSync(join(g2, 'auqw.sync.devices.json'), '{not json');
    assert(
      syncHasPairedDevices(g2),
      'an unparseable mirror arms conservatively',
    );
    writeFileSync(
      join(g2, 'auqw.sync.devices.json'),
      JSON.stringify({ v: 1, devices: [] }),
    );
    assertEqual(
      syncHasPairedDevices(g2),
      false,
      'a verified-empty mirror stays dormant',
    );

    // Consolidated custody: one sealed record, one decrypt per boot.
    const c = counting();
    const cDir = join(root, 'consolidated');
    const h1 = createSyncKeysHandler({
      secure: createSecureStore({ dir: cDir, safeStorage: c.storage }),
      dir: cDir,
    });
    const cId = generateIdentity();
    await h1({ op: 'identity-set', identity: cId });
    await h1({ op: 'device-put', record: device('dev-cons0001') });
    await h1({ op: 'device-put', record: device('dev-cons0002') });
    await h1({ op: 'device-list' });
    assertEqual(
      c.decrypts(),
      0,
      'fresh writes never touch the decrypt path',
    );
    // The next process: a single blob decrypt serves every op.
    const h2 = createSyncKeysHandler({
      secure: createSecureStore({ dir: cDir, safeStorage: c.storage }),
      dir: cDir,
    });
    await h2({ op: 'identity-get' });
    await h2({ op: 'device-list' });
    await h2({ op: 'device-put', record: device('dev-cons0003') });
    await h2({ op: 'device-delete', id: 'dev-cons0001' });
    const cList = (await h2({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
    };
    assertEqual(
      c.decrypts(),
      1,
      'one decryptString per boot regardless of ops',
    );
    assertEqual(cList.devices.length, 2, 'registry survived restart');
    // A deleted mirror heals on the next custody touch.
    rmSync(join(cDir, 'auqw.sync.devices.json'));
    const h3 = createSyncKeysHandler({
      secure: createSecureStore({ dir: cDir, safeStorage: c.storage }),
      dir: cDir,
    });
    await h3({ op: 'device-list' });
    assert(
      syncHasPairedDevices(cDir),
      'healed mirror re-arms the gate',
    );

    // The legacy → consolidated merge: each old record decrypts once,
    // joined under the blob; unusable records are consumed, an
    // undecryptable one is kept and reported skipped.
    const m = counting();
    const mDir = join(root, 'merge');
    const mStore = createSecureStore({ dir: mDir, safeStorage: m.storage });
    const mIdentity = generateIdentity();
    await mStore.set('auqw.sync.identity', JSON.stringify(mIdentity));
    const md1 = device('dev-merge001');
    const md2 = device('dev-merge002');
    await mStore.set(
      `auqw.sync.device.${md1.id}`,
      JSON.stringify(legacyShape(md1)),
    );
    await mStore.set(
      `auqw.sync.device.${md2.id}`,
      JSON.stringify(legacyShape(md2)),
    );
    writeFileSync(
      join(mDir, 'auqw.sync.device.dev-badjson.b64'),
      Buffer.from('enc:not json').toString('base64'),
      'utf8',
    );
    writeFileSync(
      join(mDir, 'auqw.sync.device.dev-garbage0.b64'),
      Buffer.from('garbage').toString('base64'),
      'utf8',
    );
    const mHandler = createSyncKeysHandler({
      secure: createSecureStore({ dir: mDir, safeStorage: m.storage }),
      dir: mDir,
    });
    const mList = (await mHandler({ op: 'device-list' })) as {
      devices: SyncDeviceRecord[];
      skipped: number;
    };
    assertDeepEqual(
      mList.devices.map((d) => d.id).sort(),
      [md1.id, md2.id].sort(),
      'legacy devices merged into the blob',
    );
    assertEqual(
      mList.skipped,
      1,
      'the undecryptable record reports as skipped',
    );
    const mGot = (await mHandler({ op: 'identity-get' })) as {
      identity: { pub: string } | null;
    };
    assertEqual(mGot.identity?.pub, mIdentity.pub, 'legacy identity merged');
    assert(existsSync(join(mDir, 'auqw.sync.store.b64')));
    assert(existsSync(join(mDir, 'auqw.sync.devices.json')));
    assert(!existsSync(join(mDir, 'auqw.sync.identity.b64')));
    assert(!existsSync(join(mDir, `auqw.sync.device.${md1.id}.b64`)));
    assert(
      !existsSync(join(mDir, 'auqw.sync.device.dev-badjson.b64')),
      'invalid records are consumed',
    );
    assert(
      existsSync(join(mDir, 'auqw.sync.device.dev-garbage0.b64')),
      'an undecryptable record is kept for retry',
    );
    assert(syncHasPairedDevices(mDir), 'post-merge install stays armed');
    const mirror = JSON.parse(
      readFileSync(join(mDir, 'auqw.sync.devices.json'), 'utf8'),
    ) as { devices: Array<{ id: string }> };
    assertDeepEqual(
      mirror.devices.map((d) => d.id).sort(),
      [md1.id, md2.id].sort(),
      'the mirror carries the public device records',
    );
    // First-boot cost: identity + 2 devices + invalid + orphan = 5
    // decrypts, once ever; the consolidated boot reads one blob plus
    // the orphan's retry.
    assertEqual(m.decrypts(), 5, 'each legacy record decrypts once');
    const m2 = createSyncKeysHandler({
      secure: createSecureStore({ dir: mDir, safeStorage: m.storage }),
      dir: mDir,
    });
    await m2({ op: 'device-list' });
    await m2({ op: 'identity-get' });
    assertEqual(
      m.decrypts(),
      7,
      'post-merge boot: one blob decrypt + one orphan retry',
    );

    // A torn/foreign blob fails typed; identity-replace unwedges it.
    const wDir = join(root, 'wedged');
    mkdirSync(wDir, { recursive: true });
    writeFileSync(
      join(wDir, 'auqw.sync.store.b64'),
      Buffer.from('garbage').toString('base64'),
      'utf8',
    );
    const wHandler = createSyncKeysHandler({
      secure: createSecureStore({ dir: wDir, safeStorage: WORKING }),
      dir: wDir,
    });
    await assertThrowsKind(wHandler({ op: 'identity-get' }), 'corrupt-state');
    await assertThrowsKind(wHandler({ op: 'device-list' }), 'corrupt-state');
    const freshIdentity = generateIdentity();
    assertEqual(
      await wHandler({ op: 'identity-replace', identity: freshIdentity }),
      null,
      'replace unwedges a corrupt blob',
    );
    const wGot = (await wHandler({ op: 'identity-get' })) as {
      identity: { pub: string } | null;
    };
    assertEqual(wGot.identity?.pub, freshIdentity.pub, 'replaced identity serves');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
