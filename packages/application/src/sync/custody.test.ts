import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '../testing/assert.ts';
import {
  isSyncCallerPeer,
  isSyncPeer,
  readSyncCallerPeer,
  readSyncPeer,
  readSyncPeerRecord,
  type SyncCallerPeer,
  type SyncPeer,
} from './custody.ts';

const FP =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const FP2 =
  'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';

/** The pre-unification desktop device row — no `role`, id-keyed. */
const LEGACY_DESKTOP_ROW = {
  id: 'phone-abcdef12',
  name: 'Pixel 8',
  pub: 'MCowBQYDK2VuAyEAx+y9qJqf+ovWHDc91d3v2Nq3G/4TzKtD8YzE4w9HDEU=',
  fp: FP,
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_500_000,
};

/** The pre-unification mobile peer row — no `role`, fp-keyed. */
const LEGACY_MOBILE_ROW = {
  fp: FP2,
  name: 'workstation',
  endpoints: ['192.168.1.20:48715'],
  pairedAt: 1_699_000_000_000,
  lastSeenAt: 1_699_500_000_000,
  peerCursor: { 'desk-0000001': 41 },
  lastSyncAt: 1_699_500_000_000,
  deviceId: 'desk-0000001',
  pub: 'MCowBQYDK2VuAyEAy0tFbRi1c7vQqKJb9X2mNvQpPd5s8GjLkE3rTzUwEhA=',
  pot: '192.168.1.20:41231',
};

export function run(): void {
  // —— Tagged (current) shapes ————————————————————————————
  const caller: SyncCallerPeer = {
    role: 'caller',
    id: 'phone-abcdef12',
    name: 'Pixel 8',
    pub: 'MCowBQYDK2VuAyEAx+y9qJqf+ovWHDc91d3v2Nq3G/4TzKtD8YzE4w9HDEU=',
    fp: FP,
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_500_000,
  };
  assert(isSyncCallerPeer(caller), 'tagged caller row validates');
  assert(
    isSyncCallerPeer({ ...caller, endpoints: ['10.0.0.9:4123'] }),
    'caller row with endpoints validates',
  );
  assert(!isSyncPeer(caller), 'caller row is not a responder row');

  const responder: SyncPeer = {
    role: 'responder',
    fp: FP2,
    name: 'workstation',
    endpoints: ['192.168.1.20:48715'],
    pairedAt: 1_699_000_000_000,
    lastSeenAt: 1_699_500_000_000,
    peerCursor: { 'desk-0000001': 41 },
  };
  assert(isSyncPeer(responder), 'tagged responder row validates');
  assert(!isSyncCallerPeer(responder), 'responder row is not a caller row');
  assert(
    isSyncPeer({
      ...responder,
      lastSyncAt: 1,
      deviceId: 'desk-0000001',
      pub: 'pub',
      pot: 'h:1',
    }),
    'responder row with optionals validates',
  );

  // Strict guards reject mistagged and foreign-key rows.
  assert(!isSyncPeer({ ...responder, role: 'caller' }));
  assert(!isSyncPeer({ ...responder, extra: true }));
  assert(!isSyncCallerPeer({ ...caller, extra: true }));
  assert(!isSyncPeer({ ...responder, peerCursor: 'not-a-record' }));

  // —— Legacy reads: shipped shapes still load ———————————
  const loadedDesktop = readSyncPeerRecord(LEGACY_DESKTOP_ROW);
  assertDeepEqual(loadedDesktop, {
    ...LEGACY_DESKTOP_ROW,
    role: 'caller',
  });
  assertEqual(loadedDesktop?.role, 'caller');

  const loadedMobile = readSyncPeerRecord(LEGACY_MOBILE_ROW);
  assertDeepEqual(loadedMobile, {
    ...LEGACY_MOBILE_ROW,
    role: 'responder',
  });
  assertEqual(loadedMobile?.role, 'responder');

  // Narrowed readers refuse the other role.
  assertEqual(readSyncPeer(LEGACY_DESKTOP_ROW), null);
  assertEqual(readSyncCallerPeer(LEGACY_MOBILE_ROW), null);
  assert(readSyncPeer(LEGACY_MOBILE_ROW) !== null);
  assert(readSyncCallerPeer(LEGACY_DESKTOP_ROW) !== null);

  // Legacy rows missing required fields still fail — a corrupt row
  // never becomes a record.
  const { peerCursor: _drop, ...noCursor } = LEGACY_MOBILE_ROW;
  assertEqual(readSyncPeerRecord(noCursor), null);
  const { pub: _dropPub, ...noPub } = LEGACY_DESKTOP_ROW;
  assertEqual(readSyncPeerRecord(noPub), null);

  // Unknown role tags are not ours to interpret.
  assertEqual(readSyncPeerRecord({ ...responder, role: 'strange' }), null);
  assertEqual(readSyncPeerRecord('not a record'), null);
  assertEqual(readSyncPeerRecord(null), null);

  // A normalized row re-reads through the strict path — round-trip
  // into the tagged write shape.
  const normalized = readSyncPeerRecord(LEGACY_MOBILE_ROW);
  assert(normalized !== null && isSyncPeer(normalized));
  const normalizedCaller = readSyncPeerRecord(LEGACY_DESKTOP_ROW);
  assert(normalizedCaller !== null && isSyncCallerPeer(normalizedCaller));

  // A TAGGED row carrying loose-reader bounds (an over-max name from
  // a pre-strict store, or endpoints longer than the write guard
  // allows) must not drop on reload — reads accept what the shipped
  // validators could store, strict bounds only govern writes.
  const looseTaggedResponder = {
    ...LEGACY_MOBILE_ROW,
    role: 'responder',
    name: 'n'.repeat(300),
    endpoints: ['e'.repeat(400)],
    deviceId: 'UPPER not-pattern',
  };
  assert(!isSyncPeer(looseTaggedResponder), 'strict guard rejects');
  const looseLoaded = readSyncPeerRecord(looseTaggedResponder);
  assertEqual(looseLoaded?.name, 'n'.repeat(300), 'tagged loose row loads');
  const looseTaggedCaller = {
    ...LEGACY_DESKTOP_ROW,
    role: 'caller',
    endpoints: ['e'.repeat(400)],
  };
  assert(!isSyncCallerPeer(looseTaggedCaller));
  assertEqual(
    readSyncPeerRecord(looseTaggedCaller)?.role,
    'caller',
    'tagged loose caller loads',
  );
}
