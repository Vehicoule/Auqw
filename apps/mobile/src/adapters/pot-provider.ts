import { parseEndpoint } from '@auqw/application';

/**
 * Pick the paired desktop's bundled POT provider URL from a set of
 * SyncPeer records (`pot` is `host:port`). The most recently seen
 * peer THAT CARRIES a pot wins — a newer peer without `pot` can't
 * mint and must not suppress an older peer that can; a
 * missing/stale/corrupt field degrades to undefined — the caller
 * decides the fallback (env override, then the anonymous resolve
 * ladder).
 *
 * Pure and native-free on purpose: the unit-test graph resolves
 * this module on bare node, where the SecureStore adapter's expo
 * surface can't load.
 */
export function potProviderUrlFromPeers(
  peers: readonly { pot?: string | undefined; lastSeenAt: number }[],
): string | undefined {
  let best: string | undefined;
  let bestSeenAt = -1;
  for (const peer of peers) {
    const pot = peer.pot;
    if (pot === undefined || parseEndpoint(pot) === null) {
      continue;
    }
    if (peer.lastSeenAt >= bestSeenAt) {
      bestSeenAt = peer.lastSeenAt;
      best = pot;
    }
  }
  return best === undefined ? undefined : `http://${best}`;
}
