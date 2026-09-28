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
  /**
   * Teardown hook for adapters holding bridge subscriptions —
   * `SyncClient.close()` invokes it after killing sessions. Adapters
   * with nothing to release leave it undefined.
   */
  close?(): void;
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
  /** sha256(SPKI DER) hex — verify a claimed pub against a session's
      verified serverFp before custody accepts it. */
  fingerprintOf(pub: string): string;
  begin(opts: { deviceId: string; name: string }): SyncClientHandshake;
}

/**
 * The responder half of one handshake — the server role either side
 * can take under symmetric pairing (docs/specs/sync.md). `accept`
 * validates the hello's key material cryptographically, mints the
 * challenge, and returns the sealed session codec plus the caller's
 * identity claims. Throws on malformed keys — callers treat a throw
 * as connection death, not a typed reply.
 */
export interface SyncResponderCrypto {
  readonly name: string;
  readonly identity: SyncIdentity;
  accept(
    hello: ClientHello,
    opts: { registered: boolean },
  ): {
    readonly challenge: Uint8Array;
    readonly codec: SyncFrameCodec;
    readonly peer: {
      readonly deviceId: string;
      readonly name: string;
      readonly devPub: string;
      readonly devFp: string;
    };
  };
}

/** A bound inbound listener — desktop node:net or the auqw-expo socket. */
export interface SyncSocketListener {
  readonly port: number;
  close(): void;
}

/**
 * The inbound-socket seam — the pair host's transport. Production:
 * `node:net` on the desktop, the auqw-expo `syncListen` bridge on the
 * phone; tests inject a loopback. `onSocket` fires per accepted
 * connection; `onError` reports async listen failures post-bind.
 */
export interface SyncAcceptorPort {
  listen(opts: {
    onSocket(socket: SyncSocket): void;
    onError?(error: { readonly message: string }): void;
  }): Promise<Result<SyncSocketListener>>;
  /**
   * Terminal teardown — drops the acceptor's own resources (native
   * event subscriptions, accept threads). `listen()` stays valid for
   * reuse via `SyncSocketListener.close()`; `close()` is for when the
   * whole acceptor is being disposed.
   */
  close?(): void;
}

/**
 * A `_auqw._tcp` service found on the LAN — `host`/`port` are dialable
 * as-is; `fp` is the advertised identity fp for pre-dial pinning.
 */
export interface SyncDiscoveredPeer {
  /**
   * Stable per-service identity (`name|host|port`) — the adapter mints
   * it and both `found` and `lost` carry it, so two adverts sharing a
   * display name stay distinct rows and a re-announced listener port
   * supersedes the old row instead of shadowing it.
   */
  readonly key: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /**
   * Every pairable resolved address, best-first (`host` is [0]) —
   * the dial tries each in order so a dead route under the ranked
   * pick falls through to a reachable sibling.
   */
  readonly addresses: readonly string[];
  readonly fp: string | null;
}

export interface SyncDiscoverySession {
  close(): void;
}

/**
 * mDNS browse seam — platform glue (bonjour on desktop, NsdManager on
 * Android). Browse is best-effort: pairing never depends on it (QR +
 * code carry the endpoint), so a missing seam degrades to "no nearby
 * list", never a failure.
 */
export interface SyncDiscoveryPort {
  browse(opts: {
    onFound(peer: SyncDiscoveredPeer): void;
    /** `key` = the lost service's identity, as minted on `found`. */
    onLost(key: string): void;
  }): Promise<Result<SyncDiscoverySession>>;
}

/** `_auqw._tcp` advertise options — name is the human label, fp the
 * identity fingerprint (TXT `dev`). */
export interface SyncAdvertiseOpts {
  readonly port: number;
  readonly name: string;
  readonly fp: string;
  readonly onError?: () => void;
}

export interface SyncAdvertiser {
  close(): void;
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
  /**
   * The peer's deviceId — captured when the peer hosted the pairing
   * (its welcome discloses the responder identity); absent on records
   * from a responder that never shared it.
   */
  readonly deviceId?: string;
  /** The peer's device public key (SPKI b64) — welcome host field. */
  readonly pub?: string;
  /**
   * The peer's bundled POT service as `host:port`, learned from the
   * pairing payload — shares `endpoints`' freshness horizon (a
   * desktop restart rebinds both; the next pair refreshes).
   */
  readonly pot?: string;
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
  /**
   * Atomic existence-gated merge: under the same serialization as
   * peerPut/peerDelete, read the stored row and overlay resume-owned
   * fields — the stored `peerCursor`, `lastSyncAt`, `pairedAt`, and
   * `pot` survive; `name` and `lastSeenAt` replace; `endpoints`,
   * `deviceId`, and `pub` replace only when the incoming value is
   * non-empty. `false` when custody no longer carries the fp, so a
   * concurrent peerDelete can't be resurrected — and a sync round's
   * cursor write can't be lost between a caller-side read and write.
   */
  peerTouch(
    peer: SyncPeer,
    signal?: CancellationSignal,
  ): Promise<Result<boolean>>;
  peerDelete(fp: string, signal?: CancellationSignal): Promise<Result<void>>;
  /**
   * Atomic read-merge-write for host-side custody updates (re-pair):
   * under the same serialization as peerPut/peerDelete, merge the
   * incoming row over the stored one — the stored `peerCursor`,
   * `lastSyncAt`, `pairedAt`, and `pot` survive; the incoming `name`,
   * `endpoints`, `deviceId`, `pub`, and `lastSeenAt` replace. The
   * alternative (peerList + peerPut) leaves a window where a sync
   * round's cursor write lands between the read and the write and is
   * lost.
   */
  peerMerge(
    peer: SyncPeer,
    signal?: CancellationSignal,
  ): Promise<Result<void>>;
}
