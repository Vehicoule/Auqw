import type {
  Result,
  SyncClientKeys,
  SyncHostPeer,
  SyncHostRegistry,
  SyncPeer,
} from '@auqw/application';
import { err, ok } from '@auqw/application';
import { appError } from '@auqw/application';

/**
 * SyncHostRegistry over SyncClientKeys — the pair host's custody seam
 * on the phone. The phone's peer store IS the registry: a desktop we
 * paired with is a SyncPeer row regardless of who hosted the pairing.
 * `put` merges so a host-side accept never clobbers the cursors a
 * client-role round already learned.
 */
export function createSyncPeerRegistry(
  keys: SyncClientKeys,
): SyncHostRegistry {
  const toHostPeer = (peer: SyncPeer): SyncHostPeer => ({
    id: peer.deviceId ?? '',
    name: peer.name,
    pub: '',
    fp: peer.fp,
    pairedAt: peer.pairedAt,
    lastSeenAt: peer.lastSeenAt,
    endpoints: peer.endpoints,
  });
  return {
    async find(fp) {
      const listed = await keys.peerList();
      if (!listed.ok) {
        return err(listed.error);
      }
      const found = listed.value.find((p) => p.fp === fp);
      return ok(found === undefined ? null : toHostPeer(found));
    },
    async put(peer) {
      // Atomic read-merge-write on the keys port: custody keeps the
      // stored cursor/lastSyncAt/pairedAt/pot while the host's fresh
      // name/endpoints/id/pub land — a concurrent syncRound's cursor
      // write can't be lost between a read and a write here.
      return keys.peerMerge({
        fp: peer.fp,
        name: peer.name,
        endpoints: peer.endpoints,
        pairedAt: peer.pairedAt,
        lastSeenAt: peer.lastSeenAt,
        peerCursor: {},
        ...(peer.id === '' ? {} : { deviceId: peer.id }),
        ...(peer.pub === '' ? {} : { pub: peer.pub }),
      });
    },
    async touch(peer) {
      // One atomic existence-gated merge — the port itself preserves
      // the stored cursor/lastSyncAt/pairedAt/pot and skips empty
      // endpoint/id/pub overlays, so no caller-side read races a
      // concurrent syncRound's cursor write (or an unpair).
      const touched = await keys.peerTouch({
        fp: peer.fp,
        name: peer.name,
        endpoints: peer.endpoints,
        pairedAt: peer.pairedAt,
        lastSeenAt: peer.lastSeenAt,
        peerCursor: {},
        ...(peer.id === '' ? {} : { deviceId: peer.id }),
        ...(peer.pub === '' ? {} : { pub: peer.pub }),
      });
      if (!touched.ok) {
        return err(touched.error);
      }
      return ok(touched.value);
    },
  };
}

export type { SyncHostPeer };
