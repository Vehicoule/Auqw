import { assert, assertEqual } from '@auqw/application/testing';
import type { SyncDiscoveredPeer } from '@auqw/application';
import { createExpoSyncDiscovery } from './expo-sync-discovery.ts';
import type {
  AuqwExpoSubscription,
  AuqwSyncNative,
} from './auqw-expo-surface.ts';

type DiscoveryEvent = {
  type: string;
  name: string;
  host?: string | null;
  hosts?: string[];
  port?: number | null;
  fp?: string | null;
};

function fakeNative(): {
  native: AuqwSyncNative;
  emit: (e: DiscoveryEvent) => void;
} {
  let listener: ((e: DiscoveryEvent) => void) | null = null;
  const sub: AuqwExpoSubscription = { remove: () => {} };
  const native = {
    syncBrowse: async () => {},
    syncBrowseStop: async () => {},
    syncAdvertise: async () => {},
    syncAdvertiseStop: async () => {},
    addSyncDiscoveryListener: (l: (e: DiscoveryEvent) => void) => {
      listener = l;
      return sub;
    },
  } as unknown as AuqwSyncNative;
  return {
    native,
    emit: (e) => listener?.(e),
  };
}

async function rerankToUnpairableRetracts(): Promise<void> {
  const { native, emit } = fakeNative();
  const discovery = createExpoSyncDiscovery(native);
  const found: SyncDiscoveredPeer[] = [];
  const lost: string[] = [];
  const session = await discovery.browse({
    onFound: (p) => found.push(p),
    onLost: (k) => lost.push(k),
  });
  assert(session.ok, 'browse session opens');

  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.4'],
    port: 41000,
    fp: null,
  });
  assertEqual(found.length, 1, 'first found emits');
  assertEqual(found[0]!.key, 'Phone|10.0.0.4|41000', 'v4 picked');

  // The same name re-announces with NO pairable address — the emitted
  // row must be retracted, not left dialable.
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['203.0.113.8'],
    port: 41000,
    fp: null,
  });
  assertEqual(lost.length, 1, 'unpairable re-announce retracts');
  assertEqual(
    lost[0],
    'Phone|10.0.0.4|41000',
    'retracted the stale key',
  );
  assertEqual(found.length, 1, 'no new row emitted');

  // Same for a malformed fp re-announce — the pin can't be honored.
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.4'],
    port: 41000,
    fp: 'zzz',
  });
  assertEqual(found.length, 1, 'malformed fp drops');
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.4'],
    port: 41000,
    fp: 'a'.repeat(64),
  });
  assertEqual(found.length, 2, 'clean re-announce re-emits');
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.4'],
    port: 41000,
    fp: 'nothex',
  });
  assertEqual(lost.length, 2, 'malformed fp retracts live row');
  assertEqual(lost[1], 'Phone|10.0.0.4|41000', 'retract key matches');
  session.ok && session.value.close();
}

async function rerankPicksDialableOverList(): Promise<void> {
  const { native, emit } = fakeNative();
  const discovery = createExpoSyncDiscovery(native);
  const found: SyncDiscoveredPeer[] = [];
  const session = await discovery.browse({
    onFound: (p) => found.push(p),
    onLost: () => {},
  });
  assert(session.ok, 'browse session opens');
  // Loopback + bare fe80 + private v4 → the v4 wins.
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['127.0.0.1', 'fe80::1', '192.168.1.8'],
    port: 41000,
    fp: null,
  });
  assertEqual(found[0]!.host, '192.168.1.8', 'dialable v4 ranked');
  session.ok && session.value.close();
}

async function sameNameServicesCoexist(): Promise<void> {
  const { native, emit } = fakeNative();
  const discovery = createExpoSyncDiscovery(native);
  const found: SyncDiscoveredPeer[] = [];
  const lost: string[] = [];
  const session = await discovery.browse({
    onFound: (p) => found.push(p),
    onLost: (k) => lost.push(k),
  });
  assert(session.ok, 'browse session opens');

  // Two devices advertising the same instance name on different
  // listener ports — both rows must live independently.
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.4'],
    port: 41000,
    fp: null,
  });
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.5'],
    port: 41001,
    fp: null,
  });
  assertEqual(found.length, 2, 'both services emitted');
  assertEqual(lost.length, 0, 'no retraction between devices');

  // A same-port re-announce of A with a new address is A's new
  // generation — retracts A's old key only.
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.9'],
    port: 41000,
    fp: null,
  });
  assertEqual(found.length, 3, 'A re-announce emits');
  assertEqual(lost.length, 1, 'A old row retracted');
  assertEqual(lost[0], 'Phone|10.0.0.4|41000', 'retracted A key');

  // A unpairable re-announce of B retracts only B's row.
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['203.0.113.8'],
    port: 41001,
    fp: null,
  });
  assertEqual(lost.length, 2, 'B retracted');
  assertEqual(lost[1], 'Phone|10.0.0.5|41001', 'retracted B key');
  session.ok && session.value.close();
}

async function lostScopedToGeneration(): Promise<void> {
  const { native, emit } = fakeNative();
  const discovery = createExpoSyncDiscovery(native);
  const found: SyncDiscoveredPeer[] = [];
  const lost: string[] = [];
  const session = await discovery.browse({
    onFound: (p) => found.push(p),
    onLost: (k) => lost.push(k),
  });
  assert(session.ok, 'browse session opens');

  // Two generations under one name: the fresh row survives a stale
  // goodbye for the dead generation's port.
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.4'],
    port: 41000,
    fp: null,
  });
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.9'],
    port: 42000,
    fp: null,
  });
  assertEqual(found.length, 2, 'both generations emitted');
  emit({ type: 'lost', name: 'Phone', port: 41001, fp: null });
  assertEqual(lost.length, 0, 'other-generation lost retracts nothing');
  emit({ type: 'lost', name: 'Phone', port: 41000, fp: null });
  assertEqual(lost.length, 1, 'own-generation lost retracts');
  assertEqual(lost[0], 'Phone|10.0.0.4|41000', 'retracted dead row');

  // A lost carrying the record's fp scopes to fp-pinned rows — a
  // fp-less name-only lost still retracts the rest.
  const pinned = 'a'.repeat(64);
  emit({
    type: 'found',
    name: 'Phone',
    hosts: ['10.0.0.7'],
    port: 43000,
    fp: pinned,
  });
  emit({
    type: 'lost',
    name: 'Phone',
    port: 43001,
    fp: 'b'.repeat(64),
  });
  assertEqual(lost.length, 1, 'foreign fp lost retracts nothing');
  emit({ type: 'lost', name: 'Phone', fp: pinned });
  assertEqual(lost.length, 2, 'fp-matched lost retracts');
  assertEqual(lost[1], 'Phone|10.0.0.7|43000', 'retracted pinned row');
  emit({ type: 'lost', name: 'Phone' });
  assertEqual(lost.length, 3, 'identity-less lost retracts remaining');
  assertEqual(lost[2], 'Phone|10.0.0.9|42000', 'retracted last row');
  session.ok && session.value.close();
}

export async function run(): Promise<void> {
  await rerankToUnpairableRetracts();
  await rerankPicksDialableOverList();
  await sameNameServicesCoexist();
  await lostScopedToGeneration();
}
