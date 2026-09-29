import { Bonjour, type Service } from 'bonjour-service';
import {
  appError,
  dialableHostsRanked,
  err,
  ok,
  type SyncDiscoveredPeer,
  type SyncDiscoveryPort,
  type SyncDiscoverySession,
} from '@auqw/application';
import type { SyncAdvertise } from './sync-server.ts';

const SERVICE_TYPE = 'auqw';
const SERVICE_PROTOCOL = 'tcp' as const;
/** TXT key carrying the identity fingerprint — browsers pin pre-dial. */
const TXT_FP = 'dev';

/**
 * mDNS announce for the LAN listener — `_auqw._tcp.local` with the
 * bound port + device name so the phone can find the desktop without a
 * typed endpoint. Discovery is best-effort: pairing never depends on
 * it (the QR/typed code path carries the endpoint itself), so a
 * failure to announce throws here and the service reports
 * `unavailable` rather than a fake "discoverable".
 */
export const createBonjourAdvertise = (): SyncAdvertise => {
  let onError: (() => void) | undefined;
  // The second ctor arg is the async-error callback — WITHOUT it the
  // mdns server throws inside the shared utility process on a socket
  // error and kills storage + streaming with it. Degrade, never exit.
  const bonjour = new Bonjour({}, () => {
    onError?.();
  });
  return ({ port, name, fp, onError: hook }) => {
    onError = hook;
    const service: Service = bonjour.publish({
      name,
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
      port,
      txt: { [TXT_FP]: fp },
    });
    return {
      close() {
        try {
          service.stop?.();
        } catch {
          // best effort
        }
        try {
          bonjour.unpublishAll(() => {
            try {
              bonjour.destroy();
            } catch {
              // best effort
            }
          });
        } catch {
          try {
            bonjour.destroy();
          } catch {
            // best effort
          }
        }
      },
    };
  };
};

/** One discovered service → the port's peer shape, or null when unusable. */
function peerOf(service: Service): SyncDiscoveredPeer | null {
  // The resolved address list arrives in resolver order — a bare
  // link-local v6 (fe80:: without a zone) sorts ahead of a routable
  // private v4 and is undialable, so rank by dialability. The full
  // ranked list goes out on `addresses` so the dial falls through to
  // a reachable sibling when the pick sits behind a dead route.
  // The `sync:nearby` contract caps the peer: 16 addresses (the
  // ranker's literals already fit their 64-char bound), name 128 —
  // `name|host|port` then always fits the key's 320. A `found`
  // that violates it dies silently at the preload boundary, so
  // bound and drop at the producer instead.
  const addresses = dialableHostsRanked(service.addresses ?? []).slice(
    0,
    16,
  );
  const host = addresses[0] ?? null;
  if (
    typeof service.name !== 'string' ||
    service.name.length > 128 ||
    host === null ||
    typeof service.port !== 'number'
  ) {
    // A non-LAN advert is undialable — never a nearby row.
    return null;
  }
  const txt = service.txt;
  const rawFp =
    txt !== null && typeof txt === 'object' && TXT_FP in txt
      ? txt[TXT_FP]
      : undefined;
  // A PRESENT-but-malformed `dev` TXT can't be downgraded to an
  // unpinned tap target — drop the whole advert. Absent stays a
  // valid unpinned candidate.
  if (
    rawFp !== undefined &&
    (typeof rawFp !== 'string' || !/^[0-9a-f]{64}$/.test(rawFp))
  ) {
    return null;
  }
  return {
    // The port is part of the row identity: two same-named adverts
    // co-hosted on one address (a stale generation beside the fresh
    // one, or prod+dev instances) are distinct rows, and a retraction
    // scoped to one generation can't remove the survivor's row.
    key: `${service.name}|${host}|${service.port}`,
    name: service.name,
    host,
    port: service.port,
    addresses,
    fp: rawFp ?? null,
  };
}

/** TXT `dev` (device fingerprint) from a service, or null/undefined. */
const fpOf = (service: Service): string | null => {
  const txt = service.txt;
  const raw =
    txt !== null && typeof txt === 'object' && TXT_FP in txt
      ? txt[TXT_FP]
      : undefined;
  return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw)
    ? raw
    : null;
};

/**
 * Tracking of emitted peers for one browse — shared by the `up`/`down`
 * handlers so a re-announcement or a late `down` can retract exactly
 * the row that was emitted. The service IDENTITY is its `dev` TXT
 * fingerprint — stable across hostname/port/address changes, which
 * are exactly what a re-announce mutates. Adverts without a valid fp
 * fall back to the SRV target host as the device id (an instance name
 * is NOT unique on a LAN — two devices can both call themselves
 * "Phone"). Exported for the tracker unit test.
 */
export const createPeerTracker = (
  onFound: (peer: SyncDiscoveredPeer) => void,
  onLost: (key: string) => void,
): { up(service: Service): void; down(service: Service): void } => {
  const seen = new Map<
    string,
    {
      name: string;
      fp: string | null;
      host: string | undefined;
      port: number | undefined;
      peer: SyncDiscoveredPeer;
    }
  >();
  const hostOf = (s: Service): string | undefined =>
    typeof s.host === 'string' && s.host !== '' ? s.host : undefined;
  // Retract the rows belonging to this record's generation. The
  // `dev` fp pins the device (stable across host/port/address churn);
  // `staleOnly` additionally requires the SRV host+port fields the
  // record carries to match the stored generation — a `down` reports
  // the DEAD generation, which can lag a re-announce, so the same fp
  // on an old host/port must not kill the fresh row.
  const retract = (service: Service, staleOnly: boolean) => {
    const fp = fpOf(service);
    const host = hostOf(service);
    const port =
      typeof service.port === 'number' ? service.port : undefined;
    for (const [id, entry] of seen) {
      if (entry.name !== service.name) {
        continue;
      }
      if (fp !== null && entry.fp !== fp) {
        continue;
      }
      if (staleOnly || fp === null) {
        if (
          host !== undefined &&
          entry.host !== undefined &&
          entry.host !== host
        ) {
          continue;
        }
        if (
          port !== undefined &&
          entry.port !== undefined &&
          entry.port !== port
        ) {
          continue;
        }
      }
      seen.delete(id);
      onLost(entry.peer.key);
    }
  };
  return {
    up(service) {
      const peer = peerOf(service);
      if (peer === null) {
        // A re-announcement with no pairable address (or a malformed
        // fp) must retract the previously emitted row for that
        // generation — otherwise the last pick stays dialable
        // forever. Generation matching applies to pinned adverts too:
        // the fp is cleartext in the TXT, so a stale or spoofed record
        // matching name+fp must not wipe the live row — only a record
        // whose SRV fields match the stored generation may retract it.
        retract(service, true);
        return;
      }
      // Identity: the advert's own fp when pinned, else the SRV host.
      const id = `${service.name}|${peer.fp ?? hostOf(service) ?? ''}`;
      const prior = seen.get(id);
      // A re-announcement whose resolved addresses changed can
      // re-rank the chosen host — retract the row keyed by the
      // old pick so the stale endpoint never stays dialable.
      if (prior !== undefined && prior.peer.key !== peer.key) {
        onLost(prior.peer.key);
      }
      seen.set(id, {
        name: service.name,
        fp: peer.fp,
        host: hostOf(service),
        port: service.port,
        peer,
      });
      onFound(peer);
    },
    down(service) {
      retract(service, true);
    },
  };
};

/**
 * mDNS browse — the desktop's LocalSend-style "nearby" list. Same
 * best-effort posture as advertise: a browse failure resolves to an
 * empty list, never a pairing blocker.
 */
export const createBonjourBrowse = (): SyncDiscoveryPort => {
  let bonjour: Bonjour | null = null;
  let sessions = 0;
  const release = () => {
    sessions -= 1;
    if (sessions === 0) {
      const instance = bonjour;
      bonjour = null;
      try {
        instance?.destroy();
      } catch {
        // best effort
      }
    }
  };
  return {
    async browse({ onFound, onLost }) {
      let browser: ReturnType<Bonjour['find']> | null = null;
      try {
        bonjour ??= new Bonjour({}, () => {
          // Async socket failure — the browser below emits no more
          // events; the session stays open but quiet rather than
          // crashing the utility host.
        });
        const br = bonjour.find({
          type: SERVICE_TYPE,
          protocol: SERVICE_PROTOCOL,
        });
        browser = br;
        const tracker = createPeerTracker(onFound, onLost);
        const up = tracker.up;
        const down = tracker.down;
        br.on('up', up);
        br.on('down', down);
        // bonjour-service emits 'up' only for a NEW fqdn — in-place
        // record churn arrives as 'srv-update' (SRV host/port retarget)
        // and 'txt-update' (dev fp change); routing both through `up`
        // engages the same re-announce/retract path. A pure A/AAAA
        // address change emits nothing and is covered by the next
        // re-announce.
        br.on('srv-update', up);
        br.on('txt-update', up);
        br.start();
        sessions += 1;
        let closed = false;
        const session: SyncDiscoverySession = {
          close() {
            // Idempotent — a double close must not decrement the
            // shared session count twice and destroy the bonjour
            // instance out from under live sessions.
            if (closed) {
              return;
            }
            closed = true;
            br.off('up', up);
            br.off('down', down);
            br.off('srv-update', up);
            br.off('txt-update', up);
            try {
              br.stop();
            } catch {
              // best effort
            }
            release();
          },
        };
        return ok(session);
      } catch (thrown) {
        // A mid-setup failure leaves no session to unwind it —
        // stop the half-built browser and, when no session holds it,
        // destroy the bonjour instance so a browse outage doesn't
        // pin its socket for the process's life.
        try {
          browser?.stop();
        } catch {
          // best effort
        }
        if (sessions === 0 && bonjour !== null) {
          try {
            bonjour.destroy();
          } catch {
            // best effort
          }
          bonjour = null;
        }
        // bonjour failure text can embed the service query — keep the
        // typed reason only.
        return err(appError('unavailable', 'sync: mdns browse failed'));
      }
    },
  };
};
