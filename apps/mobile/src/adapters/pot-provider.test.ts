import { assertEqual } from '@auqw/application/testing';
import { potProviderUrlFromPeers } from './pot-provider.ts';

/** Live provider selection across a changing peer set. */
export function run(): void {
  // No peers / no pot field → undefined (caller's fallback decides).
  assertEqual(potProviderUrlFromPeers([]), undefined);
  assertEqual(
    potProviderUrlFromPeers([{ lastSeenAt: 10 }]),
    undefined,
  );

  // Corrupt/oversized endpoints are skipped, not trusted.
  assertEqual(
    potProviderUrlFromPeers([
      { pot: 'not-an-endpoint', lastSeenAt: 10 },
    ]),
    undefined,
  );

  // The most recently seen peer wins; a stale second peer's pot
  // must not override it.
  assertEqual(
    potProviderUrlFromPeers([
      { pot: '10.0.2.2:4416', lastSeenAt: 100 },
      { pot: '192.168.1.5:52123', lastSeenAt: 200 },
      { lastSeenAt: 300 },
    ]),
    'http://192.168.1.5:52123',
  );

  // Unpair / peer eviction: the pot-peer disappearing leaves no URL.
  assertEqual(
    potProviderUrlFromPeers([{ lastSeenAt: 300 }]),
    undefined,
  );
}
