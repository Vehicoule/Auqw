import { Bonjour, type Service } from 'bonjour-service';
import {
  appError,
  err,
  ok,
  pickDialableHost,
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
  // private v4 and is undialable, so rank by dialability.
  const host = pickDialableHost(service.addresses ?? []);
  if (
    typeof service.name !== 'string' ||
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
    key: `${service.name}|${host}`,
    name: service.name,
    host,
    port: service.port,
    fp: rawFp ?? null,
  };
}

/**
 * Name-keyed tracking of emitted peers for one browse — shared by the
 * `up`/`down` handlers so a re-announcement or a late `down` can
 * retract exactly the row that was emitted. Keyed by service NAME
 * (unique on the LAN): `service.host` on a `down` can differ from the
 * chosen advert address, so name|host would miss and leave a stale
 * row behind. Exported for the tracker unit test.
 */
export const createPeerTracker = (
  onFound: (peer: SyncDiscoveredPeer) => void,
  onLost: (key: string) => void,
): { up(service: Service): void; down(service: Service): void } => {
  const seen = new Map<
    string,
    { peer: SyncDiscoveredPeer; host?: string; port?: number }
  >();
  return {
    up(service) {
      const prior = seen.get(service.name);
      const peer = peerOf(service);
      if (peer === null) {
        // A re-announcement with no pairable address must retract the
        // previously emitted row — otherwise the last pick stays
        // dialable forever.
        if (prior !== undefined) {
          seen.delete(service.name);
          onLost(prior.peer.key);
        }
        return;
      }
      // A re-announcement whose resolved addresses changed can
      // re-rank the chosen host — retract the row keyed by the
      // old pick so the stale endpoint never stays dialable.
      if (prior !== undefined && prior.peer.key !== peer.key) {
        onLost(prior.peer.key);
      }
      seen.set(service.name, {
        peer,
        host: service.host,
        port: service.port,
      });
      onFound(peer);
    },
    down(service) {
      const entry = seen.get(service.name);
      if (entry === undefined) {
        return;
      }
      // Match the down to the emitted GENERATION by the service's own
      // SRV identity — never by the address we picked to dial, which
      // can re-rank across ups of the same generation. A down from an
      // older generation (death + re-announce on a new port/host) can
      // arrive after the new up and must not kill the fresh row.
      const staleGeneration =
        (typeof service.port === 'number' &&
          service.port !== entry.port) ||
        (typeof service.host === 'string' &&
          service.host !== '' &&
          typeof entry.host === 'string' &&
          entry.host !== '' &&
          service.host !== entry.host);
      if (staleGeneration) {
        return;
      }
      seen.delete(service.name);
      onLost(entry.peer.key);
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
