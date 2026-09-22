import { Bonjour, type Service } from 'bonjour-service';
import type { SyncAdvertise } from './sync-server.ts';

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
  return ({ port, name, onError: hook }) => {
    onError = hook;
    const service: Service = bonjour.publish({
      name,
      type: 'auqw',
      protocol: 'tcp',
      port,
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
