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
      const listed = await keys.peerList();
      const existing = listed.ok
        ? listed.value.find((p) => p.fp === peer.fp)
        : undefined;
      const record: SyncPeer = {
        fp: peer.fp,
        name: peer.name,
        endpoints: peer.endpoints,
        pairedAt: existing?.pairedAt ?? peer.pairedAt,
        lastSeenAt: peer.lastSeenAt,
        peerCursor: existing?.peerCursor ?? {},
        ...(peer.id === '' ? {} : { deviceId: peer.id }),
        ...(peer.pub === '' ? {} : { pub: peer.pub }),
        ...(existing?.pot === undefined ? {} : { pot: existing.pot }),
      };
      return keys.peerPut(record);
    },
    async touch(peer) {
      const listed = await keys.peerList();
      if (!listed.ok) {
        return err(listed.error);
      }
      const existing = listed.value.find((p) => p.fp === peer.fp);
      if (existing === undefined) {
        return ok(false);
      }
      const record: SyncPeer = {
        ...existing,
        name: peer.name,
        lastSeenAt: peer.lastSeenAt,
        endpoints:
          peer.endpoints.length > 0 ? peer.endpoints : existing.endpoints,
        ...(peer.id === ''
          ? {}
          : { deviceId: peer.id }),
        ...(peer.pub === '' ? {} : { pub: peer.pub }),
      };
      const written = await keys.peerPut(record);
      if (!written.ok) {
        return err(written.error);
      }
      return ok(true);
    },
  };
}

export type { SyncHostPeer };
