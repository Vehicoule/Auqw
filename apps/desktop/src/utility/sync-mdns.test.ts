import { assert, assertEqual } from '@auqw/application/testing';
import type { Service } from 'bonjour-service';
import type { SyncDiscoveredPeer } from '@auqw/application';
import { createPeerTracker } from './sync-mdns.ts';

function service(fields: {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, string>;
}): Service {
  return fields as Service;
}

function recorder(): {
  found: SyncDiscoveredPeer[];
  lost: string[];
  onFound: (peer: SyncDiscoveredPeer) => void;
  onLost: (key: string) => void;
} {
  const found: SyncDiscoveredPeer[] = [];
  const lost: string[] = [];
  return {
    found,
    lost,
    onFound: (peer) => found.push(peer),
    onLost: (key) => lost.push(key),
  };
}

function rerankRetractsOldKey(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['fe80::1'],
    }),
  );
  assertEqual(r.found.length, 1, 'first up emits');
  assertEqual(r.found[0]!.key, 'Phone|fe80::1|41000', 'bare fe80 picked');

  // A second up whose resolved list now includes a private v4 — the
  // re-rank changes the key; the old row must be retracted first.
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['fe80::1', '192.168.1.8'],
    }),
  );
  assertEqual(r.found.length, 2, 'second up emits');
  assertEqual(r.found[1]!.key, 'Phone|192.168.1.8|41000', 'v4 wins');
  assertEqual(r.lost.length, 1, 'old key retracted');
  assertEqual(r.lost[0], 'Phone|fe80::1|41000', 'retracted the stale key');
  assert(
    r.lost[0] !== r.found[1]!.key,
    'retract precedes the new found row',
  );
}

function sameKeyReannounceKeepsRow(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['10.0.0.4'],
    }),
  );
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['10.0.0.4'],
    }),
  );
  assertEqual(r.found.length, 2, 're-announce emits again');
  assertEqual(r.lost.length, 0, 'unchanged key is not retracted');
}

function downAfterRerankClearsNewRow(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['fe80::1'],
    }),
  );
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['fe80::1', '192.168.1.8'],
    }),
  );
  // The down carries the service's SRV hostname — NOT the address the
  // re-rank picked. Generation match is by the up-service's own
  // host/port, so this must still retract the current row.
  t.down(
    service({ name: 'Phone', host: 'phone.local', port: 41000 }),
  );
  assertEqual(r.lost.length, 2, 'retract + down');
  assertEqual(r.lost[1], 'Phone|192.168.1.8|41000', 'down clears new row');
}

function staleGenerationDownKeepsRow(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  // Death on port 41000, re-announce on 42000 — the OLD generation's
  // down arriving after the new up must not kill the fresh row.
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 42000,
      addresses: ['192.168.1.8'],
    }),
  );
  t.down(
    service({ name: 'Phone', host: 'phone.local', port: 41000 }),
  );
  assertEqual(r.lost.length, 0, 'old-port down ignored');
  t.down(service({ name: 'Phone', host: 'other.local', port: 42000 }));
  assertEqual(r.lost.length, 0, 'other-host down ignored');
  t.down(
    service({ name: 'Phone', host: 'phone.local', port: 42000 }),
  );
  assertEqual(r.lost.length, 1, 'matching generation retracts');
}

function downWithoutSrvStillRetracts(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(service({ name: 'Phone', port: 41000, addresses: ['10.0.0.4'] }));
  t.down(service({ name: 'Phone' }));
  assertEqual(r.lost.length, 1, 'identity-less down retracts');
}

function unpairableUpEmitsNothing(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(
    service({ name: 'Phone', port: 41000, addresses: ['203.0.113.8'] }),
  );
  assertEqual(r.found.length, 0, 'non-LAN advert dropped');
  assertEqual(r.lost.length, 0, 'nothing to retract');
}

function unpairableReannounceRetracts(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['10.0.0.4'],
    }),
  );
  assertEqual(r.found.length, 1, 'pairable up emits');
  // Re-announce resolves to a public-only address list — the emitted
  // row must go away, not linger as a dialable ghost.
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['203.0.113.8'],
    }),
  );
  assertEqual(r.found.length, 1, 'no new row');
  assertEqual(r.lost.length, 1, 'prior row retracted');
  assertEqual(r.lost[0], 'Phone|10.0.0.4|41000', 'retracted key');
}

function sameNameServicesCoexist(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  // Two DIFFERENT devices advertising the same instance name — the
  // SRV target host distinguishes them.
  t.up(
    service({
      name: 'Phone',
      host: 'phone-a.local',
      port: 41000,
      addresses: ['10.0.0.4'],
    }),
  );
  t.up(
    service({
      name: 'Phone',
      host: 'phone-b.local',
      port: 41001,
      addresses: ['10.0.0.5'],
    }),
  );
  assertEqual(r.found.length, 2, 'both services emitted');
  assertEqual(r.lost.length, 0, 'no retraction between devices');

  // A down for A retracts only A's row; B stays.
  t.down(
    service({ name: 'Phone', host: 'phone-a.local', port: 41000 }),
  );
  assertEqual(r.lost.length, 1, 'only A retracted');
  assertEqual(r.lost[0], 'Phone|10.0.0.4|41000', 'A key retracted');

  // An unpairable re-announce of B retracts only B.
  t.up(
    service({
      name: 'Phone',
      host: 'phone-b.local',
      port: 41001,
      addresses: ['203.0.113.8'],
    }),
  );
  assertEqual(r.lost.length, 2, 'B retracted');
  assertEqual(r.lost[1], 'Phone|10.0.0.5|41001', 'B key retracted');
}

function fpSurvivesSrvMove(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  const fp = 'a'.repeat(64);
  // Same device re-announces from a NEW SRV target with a NEW address
  // — the fp identifies it as the same generation, so the old row
  // must be retracted rather than stranded.
  t.up(
    service({
      name: 'Phone',
      host: 'old.local',
      port: 41000,
      addresses: ['10.0.0.4'],
      txt: { dev: fp },
    }),
  );
  t.up(
    service({
      name: 'Phone',
      host: 'new.local',
      port: 42000,
      addresses: ['10.0.0.9'],
      txt: { dev: fp },
    }),
  );
  assertEqual(r.found.length, 2, 'moved service re-emitted');
  assertEqual(r.lost.length, 1, 'old target retracted');
  assertEqual(r.lost[0], 'Phone|10.0.0.4|41000', 'stale key gone');
  // A DELAYED goodbye of the OLD generation (same fp, old host+port)
  // must not kill the fresh row — the down's SRV fields identify the
  // dead generation, so they must match the stored ones.
  t.down(
    service({
      name: 'Phone',
      host: 'old.local',
      port: 41000,
      txt: { dev: fp },
    }),
  );
  assertEqual(r.lost.length, 1, 'stale-generation goodbye ignored');
  // The goodbye matching the live generation's SRV fields retracts it.
  t.down(
    service({
      name: 'Phone',
      host: 'new.local',
      port: 42000,
      txt: { dev: fp },
    }),
  );
  assertEqual(r.lost.length, 2, 'down by fp+generation retracts');
  assertEqual(r.lost[1], 'Phone|10.0.0.9|42000', 'current row gone');
}

function sameHostDifferentPortsCoexist(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  // Same name AND same resolved host, distinct listener ports — a
  // stale generation parked beside the fresh one on the same box.
  // The port in the key keeps them as separate rows.
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 41000,
      addresses: ['10.0.0.4'],
    }),
  );
  t.up(
    service({
      name: 'Phone',
      host: 'phone.local',
      port: 42000,
      addresses: ['10.0.0.4'],
    }),
  );
  assertEqual(r.found.length, 2, 'co-hosted ports emit two rows');
  assert(r.found[0]!.key !== r.found[1]!.key, 'keys differ by port');
  t.down(
    service({ name: 'Phone', host: 'phone.local', port: 41000 }),
  );
  assertEqual(r.lost.length, 1, 'one generation retracted');
  assertEqual(r.lost[0], 'Phone|10.0.0.4|41000', 'dead port retracted');
}

export function run(): void {
  rerankRetractsOldKey();
  sameKeyReannounceKeepsRow();
  downAfterRerankClearsNewRow();
  staleGenerationDownKeepsRow();
  downWithoutSrvStillRetracts();
  unpairableUpEmitsNothing();
  unpairableReannounceRetracts();
  sameNameServicesCoexist();
  sameHostDifferentPortsCoexist();
  fpSurvivesSrvMove();
}
