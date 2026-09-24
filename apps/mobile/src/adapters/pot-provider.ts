import { parseEndpoint } from '@auqw/application';
import { createSecureSyncKeys } from './secure-sync-keys.ts';

/**
 * The paired desktop's bundled POT provider URL, learned at pairing
 * and persisted on the SyncPeer record (`pot` is `host:port` — it
 * shares `endpoints`' freshness horizon: a desktop restart rebinds
 * both, and the next pair refreshes them together).
 *
 * Read once at session-controller construction — `createHost` takes
 * `potProviderUrl` a single time. Most recently seen peer wins; a
 * missing/stale/corrupt record degrades to undefined (the host then
 * runs the anonymous resolve ladder — the bare fallback stays).
 */
export async function discoveredPotProviderUrl(): Promise<
  string | undefined
> {
  let peers: Awaited<
    ReturnType<ReturnType<typeof createSecureSyncKeys>['peerList']>
  >;
  try {
    peers = await createSecureSyncKeys().peerList();
  } catch {
    return undefined;
  }
  if (!peers.ok) {
    return undefined;
  }
  let best: string | undefined;
  let bestSeenAt = -1;
  for (const peer of peers.value) {
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
