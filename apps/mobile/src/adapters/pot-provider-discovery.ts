import { createSecureSyncKeys } from './secure-sync-keys.ts';
import { potProviderUrlFromPeers } from './pot-provider.ts';

/**
 * The persisted-selection form of {@link potProviderUrlFromPeers} —
 * reads the custody store directly. Used at session-controller
 * construction, before the sync client exists to project live peer
 * state; after that the client's status subscription carries the same
 * selection through `setPotProvider` (a mid-session pair or a
 * welcome-carried `pot` refresh updates the running host, an unpair
 * clears it).
 */
export async function discoveredPotProviderUrl(): Promise<
  string | undefined
> {
  try {
    const peers = await createSecureSyncKeys().peerList();
    return peers.ok ? potProviderUrlFromPeers(peers.value) : undefined;
  } catch {
    return undefined;
  }
}
