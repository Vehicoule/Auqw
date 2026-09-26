import { pickDialableHost } from './lan.ts';
import { assert, assertEqual } from '../testing/assert.ts';

function ordering(): void {
  assertEqual(
    pickDialableHost(['172.16.4.2', 'fe80::c1c:98df:82c:1b64']),
    '172.16.4.2',
    'v4 ahead of bare link-local v6',
  );
  // Resolver order is arbitrary — the same set reversed must pick the
  // same address (this was the live failure: fe80 won).
  assertEqual(
    pickDialableHost(['fe80::c1c:98df:82c:1b64', '172.16.4.2']),
    '172.16.4.2',
    'bare fe80:: never shadows a private v4',
  );
  assertEqual(
    pickDialableHost(['fe80::1', 'fd00::8']),
    'fd00::8',
    'ULA outranks bare link-local',
  );
  assertEqual(
    pickDialableHost(['fe80::1', 'fe80::2%eth0']),
    'fe80::2%eth0',
    'scoped link-local outranks bare link-local',
  );
}

function lanGate(): void {
  // A public v4 ahead of a pairable v6 must not win — the gate drops
  // it before ranking.
  assertEqual(
    pickDialableHost(['203.0.113.8', 'fd00::8']),
    'fd00::8',
    'public v4 dropped, pairable v6 picked',
  );
  assertEqual(
    pickDialableHost(['8.8.8.8', '203.0.113.8']),
    null,
    'all-public advert yields no dialable host',
  );
  assertEqual(
    pickDialableHost(['my-host.local', '10.0.0.9']),
    '10.0.0.9',
    'DNS name dropped, literal kept',
  );
  assertEqual(pickDialableHost([]), null, 'empty list');
  assertEqual(
    pickDialableHost(['fe80::1']),
    'fe80::1',
    'bare fe80:: still picked when it is the only candidate',
  );
  assertEqual(
    pickDialableHost(['::1', '192.168.1.20']),
    '192.168.1.20',
    'v6 loopback loses to private v4',
  );
}

export function run(): void {
  ordering();
  lanGate();
}
