import type {
  SyncFrameCodec,
  SyncIdentity,
} from '../ports/sync-transport.ts';
import type { NoiseSuite } from '../sync/noise.ts';
import type { ClientHello } from '../sync/sync-wire.ts';

/**
 * The caller half of a noise-v1 handshake, minus sockets — the
 * test-only replacement for the retired production `createTestPeer`.
 * It is the REAL client crypto (whatever suite the test injects) so a
 * loopback run exercises the same derivation the app ships; only the
 * connection machinery is skipped. Handshake objects are single-use —
 * mint one peer per connection.
 */
export type NoiseTestPeer = {
  readonly identity: SyncIdentity;
  readonly deviceId: string;
  readonly name: string;
  hello(): ClientHello;
  /**
   * Complete the client half — malformed challenges and a `pinnedFp`
   * mismatch throw (the session's connection-death contract).
   */
  complete(
    challengeJson: unknown,
    pinnedFp?: string,
  ): { codec: SyncFrameCodec; registered: boolean };
};

export function createNoiseTestPeer(
  noise: Pick<NoiseSuite, 'clientCrypto' | 'createIdentity'>,
  opts: {
    deviceId: string;
    name: string;
    /** Reuse a device key across connections — alias/resume tests. */
    identity?: SyncIdentity;
  },
): NoiseTestPeer {
  const identity = opts.identity ?? noise.createIdentity();
  const handshake = noise
    .clientCrypto(identity)
    .begin({ deviceId: opts.deviceId, name: opts.name });
  return {
    identity,
    deviceId: opts.deviceId,
    name: opts.name,
    hello: () => handshake.hello(),
    complete(challengeJson, pinnedFp) {
      const done = handshake.complete(challengeJson, {
        ...(pinnedFp === undefined ? {} : { pinnedFp }),
      });
      if (!done.ok) {
        throw new Error(done.error.message);
      }
      return {
        codec: done.value.codec,
        registered: done.value.registered,
      };
    },
  };
}
