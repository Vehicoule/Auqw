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
  t.up(service({ name: 'Phone', port: 41000, addresses: ['fe80::1'] }));
  assertEqual(r.found.length, 1, 'first up emits');
  assertEqual(r.found[0]!.key, 'Phone|fe80::1', 'bare fe80 picked');

  // A second up whose resolved list now includes a private v4 — the
  // re-rank changes the key; the old row must be retracted first.
  t.up(
    service({
      name: 'Phone',
      port: 41000,
      addresses: ['fe80::1', '192.168.1.8'],
    }),
  );
  assertEqual(r.found.length, 2, 'second up emits');
  assertEqual(r.found[1]!.key, 'Phone|192.168.1.8', 'v4 wins');
  assertEqual(r.lost.length, 1, 'old key retracted');
  assertEqual(r.lost[0], 'Phone|fe80::1', 'retracted the stale key');
  assert(
    r.lost[0] !== r.found[1]!.key,
    'retract precedes the new found row',
  );
}

function sameKeyReannounceKeepsRow(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(service({ name: 'Phone', port: 41000, addresses: ['10.0.0.4'] }));
  t.up(service({ name: 'Phone', port: 41000, addresses: ['10.0.0.4'] }));
  assertEqual(r.found.length, 2, 're-announce emits again');
  assertEqual(r.lost.length, 0, 'unchanged key is not retracted');
}

function downAfterRerankClearsNewRow(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(service({ name: 'Phone', port: 41000, addresses: ['fe80::1'] }));
  t.up(
    service({
      name: 'Phone',
      port: 41000,
      addresses: ['fe80::1', '192.168.1.8'],
    }),
  );
  // The down carries the re-ranked host — retracts the CURRENT row.
  t.down(service({ name: 'Phone', host: '192.168.1.8', port: 41000 }));
  assertEqual(r.lost.length, 2, 'retract + down');
  assertEqual(r.lost[1], 'Phone|192.168.1.8', 'down clears new row');
}

function downWithForeignHostKeepsRow(): void {
  const r = recorder();
  const t = createPeerTracker(r.onFound, r.onLost);
  t.up(
    service({ name: 'Phone', port: 41000, addresses: ['192.168.1.8'] }),
  );
  // A stale down from an OLD generation (different host) must not
  // kill the fresh row.
  t.down(service({ name: 'Phone', host: 'fe80::1', port: 41000 }));
  assertEqual(r.lost.length, 0, 'foreign-host down ignored');
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

export function run(): void {
  rerankRetractsOldKey();
  sameKeyReannounceKeepsRow();
  downAfterRerankClearsNewRow();
  downWithForeignHostKeepsRow();
  unpairableUpEmitsNothing();
}
