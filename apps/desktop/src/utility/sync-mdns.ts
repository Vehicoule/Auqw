import { Bonjour, type Service } from 'bonjour-service';
import {
  appError,
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
  const host = service.addresses?.find(
    (a) => typeof a === 'string' && !a.includes('%'),
  );
  if (
    typeof service.name !== 'string' ||
    host === undefined ||
    typeof service.port !== 'number'
  ) {
    return null;
  }
  const rawFp =
    service.txt !== null &&
    typeof service.txt === 'object' &&
    typeof service.txt[TXT_FP] === 'string'
      ? service.txt[TXT_FP]
      : null;
  return {
    name: service.name,
    host,
    port: service.port,
    fp: rawFp !== null && /^[0-9a-f]{64}$/.test(rawFp) ? rawFp : null,
  };
}

/**
 * mDNS browse — the desktop's LocalSend-style "nearby" list. Same
 * best-effort posture as advertise: a browse failure resolves to an
 * empty list, never a pairing blocker.
 */
export const createBonjourBrowse = (): SyncDiscoveryPort => {
  let bonjour: Bonjour | null = null;
  return {
    async browse({ onFound, onLost }) {
      try {
        bonjour ??= new Bonjour({}, () => {
          // Async socket failure — the browser below emits no more
          // events; the session stays open but quiet rather than
          // crashing the utility host.
        });
        const browser = bonjour.find({
          type: SERVICE_TYPE,
          protocol: SERVICE_PROTOCOL,
        });
        const seen = new Map<string, SyncDiscoveredPeer>();
        const key = (service: Service): string =>
          `${service.name}|${service.host}`;
        const up = (service: Service) => {
          const peer = peerOf(service);
          if (peer !== null) {
            seen.set(key(service), peer);
            onFound(peer);
          }
        };
        const down = (service: Service) => {
          const peer = seen.get(key(service));
          if (peer !== undefined) {
            seen.delete(key(service));
            onLost(peer.name);
          }
        };
        browser.on('up', up);
        browser.on('down', down);
        browser.start();
        const session: SyncDiscoverySession = {
          close() {
            browser.off('up', up);
            browser.off('down', down);
            try {
              browser.stop();
            } catch {
              // best effort
            }
          },
        };
        return ok(session);
      } catch (thrown) {
        return err(
          appError(
            'unavailable',
            `sync: mdns browse failed — ${
              thrown instanceof Error ? thrown.message : 'unknown'
            }`,
          ),
        );
      }
    },
  };
};
