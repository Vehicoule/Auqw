import type { CancellationSignal } from '../cancellation.ts';
import type { Result } from '../errors.ts';
import type { SyncCursor } from '../sync/sync-engine.ts';
import type { ClientHello } from '../sync/sync-wire.ts';

/**
 * The phone-side LAN-sync transport seams (docs/specs/sync.md, slice
 * 4). The desktop owns a listener (`apps/desktop/src/utility`), the
 * phone dials: TCP connect → plaintext hello/challenge → sealed
 * pair-or-resume auth → open sync session. Three injectables cover
 * everything the pure-TS client cannot do itself: raw sockets, the
 * noise-v1 primitives (node:crypto on the desktop is absent under RN —
 * shells inject whatever their runtime carries), and identity/peer
 * custody (secure storage).
 */

/** One end of a LAN connection — mirrors the desktop's WireSocketLike. */
export interface SyncSocket {
  /** Peer address when the underlying transport knows one. */
  readonly remoteAddress?: string | undefined;
  write(data: Uint8Array): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  on(
    event: 'error',
    listener: (error: { readonly message: string }) => void,
  ): unknown;
  on(event: 'end', listener: () => void): unknown;
  /**
   * Graceful half-close — queued writes flush before FIN (net.Socket
   * semantics). The pump treats a substrate without end() as destroy().
   */
  end?(): unknown;
  destroy(): void;
}

/** TCP dialer. `timeoutMs` bounds the connect; failures stay typed. */
export interface SyncSocketPort {
  connect(opts: {
    host: string;
    port: number;
    timeoutMs: number;
    signal?: CancellationSignal;
  }): Promise<Result<SyncSocket>>;
}

/**
 * Directional AEAD codec — per-direction sequence counters bind each
 * frame to its position (noise-v1: iv = 4 zero bytes ‖ u64le seq).
 */
export interface SyncFrameCodec {
  seal(plain: Uint8Array): Uint8Array;
  /** Throws on a short, out-of-sequence, or tampered frame. */
  open(frame: Uint8Array): Uint8Array;
}

/**
 * The device identity the client presents — SPKI/PKCS8 DER base64 so
 * custody records stay byte-identical to the desktop's format.
 */
export type SyncIdentity = {
  readonly pub: string;
  readonly priv: string;
};

/**
 * The client half of one handshake — a fresh ephemeral per begin().
 * `complete` does the DH×3 + HKDF derivation and validates the
 * challenge: malformed shapes fail `invalid-response`; a `pinnedFp`
 * mismatch fails `permission-denied` (a server keying under an
 * identity other than what custody pinned).
 */
export interface SyncClientHandshake {
  hello(): ClientHello;
  complete(
    challengeJson: unknown,
    opts: { pinnedFp?: string },
  ): Result<{
    codec: SyncFrameCodec;
    registered: boolean;
    serverPub: string;
    serverFp: string;
  }>;
}

/**
 * The suite the client speaks. `begin` binds a fresh ephemeral; each
 * connection gets its own handshake — never reuse one across dials.
 * `createIdentity` mints a fresh device keypair — the suite owns
 * keygen so a different construction could mint different material.
 */
export interface SyncClientCrypto {
  readonly name: string;
  readonly identity: SyncIdentity;
  createIdentity(): SyncIdentity;
  begin(opts: { deviceId: string; name: string }): SyncClientHandshake;
}

/**
 * A desktop we have paired with. `fp` pins the server identity on
 * every later dial; `peerCursor` is the desktop's watermark map
 * learned from its last delta — the `since` filter for the phone's
 * next export, and the implicit ack of what it already merged.
 */
export type SyncPeer = {
  readonly fp: string;
  readonly name: string;
  readonly endpoints: readonly string[];
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  readonly peerCursor: SyncCursor;
  readonly lastSyncAt?: number;
};

/**
 * Identity + peer custody. Implementations write through the
 * platform's secure store (expo-secure-store on the phone; the
 * desktop's safeStorage channel mirrors it server-side). Identity and
 * peer records are the phone's ONLY sync secrets — the private key
 * never leaves this seam.
 */
export interface SyncClientKeys {
  identityGet(
    signal?: CancellationSignal,
  ): Promise<
    Result<{
      readonly deviceId: string;
      readonly identity: SyncIdentity;
    } | null>
  >;
  identitySet(
    record: { readonly deviceId: string; readonly identity: SyncIdentity },
    signal?: CancellationSignal,
  ): Promise<Result<void>>;
  peerList(signal?: CancellationSignal): Promise<Result<readonly SyncPeer[]>>;
  peerPut(
    peer: SyncPeer,
    signal?: CancellationSignal,
  ): Promise<Result<void>>;
  peerDelete(fp: string, signal?: CancellationSignal): Promise<Result<void>>;
}
