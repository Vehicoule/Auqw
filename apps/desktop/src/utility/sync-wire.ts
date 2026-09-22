/**
 * The sync LAN wire framing: every message is `[u32le length][payload]`.
 * Two caps — a small cap while the peer is still handshaking and a
 * larger one inside an authenticated session — keep a hostile or
 * broken peer from making the listener buffer unbounded garbage. A
 * frame whose declared length exceeds the phase cap destroys the
 * connection immediately: the head is the bound, it is never trusted.
 */

export type WireSocketLike = {
  /** Peer address when the underlying transport has one (net.Socket). */
  readonly remoteAddress?: string | undefined;
  write(
    data: Uint8Array,
    callback?: (error?: Error | null) => void,
  ): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  destroy(): void;
};

export type WireCloseReason = 'peer' | 'error' | 'oversize' | 'local';

export type WirePump = {
  /**
   * Length-prefixes and writes one payload; false when the payload
   * exceeds the phase cap or the pump is closed — callers that need
   * guaranteed delivery must check the return.
   */
  send(payload: Uint8Array): boolean;
  /** Raise the payload cap once the session is authenticated. */
  upgrade(maxPayload: number): void;
  /** The cap a single declared frame length may not exceed. */
  readonly maxPayload: number;
  readonly closed: boolean;
  close(): void;
};

const HEADER_BYTES = 4;

export function attachWirePump(opts: {
  socket: WireSocketLike;
  /** Cap while the peer is unauthenticated. */
  maxPayload: number;
  onFrame: (payload: Buffer) => void;
  onClose: (reason: WireCloseReason) => void;
}): WirePump {
  const { socket } = opts;
  let maxPayload = opts.maxPayload;
  let buffered = Buffer.alloc(0);
  let closed = false;

  function finish(reason: WireCloseReason): void {
    if (closed) {
      return;
    }
    closed = true;
    opts.onClose(reason);
  }

  function drain(): void {
    while (!closed && buffered.length >= HEADER_BYTES) {
      const declared = buffered.readUInt32LE(0);
      if (declared === 0 || declared > maxPayload) {
        // A lying or oversize head — drop the peer, never allocate.
        socket.destroy();
        finish('oversize');
        return;
      }
      if (buffered.length < HEADER_BYTES + declared) {
        return;
      }
      const frame = buffered.subarray(HEADER_BYTES, HEADER_BYTES + declared);
      buffered = buffered.subarray(HEADER_BYTES + declared);
      opts.onFrame(frame);
    }
  }

  socket.on('data', (chunk: Uint8Array) => {
    if (closed) {
      return;
    }
    buffered =
      buffered.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([buffered, chunk]);
    drain();
  });
  socket.on('close', () => finish('peer'));
  socket.on('end', () => finish('peer'));
  socket.on('error', () => finish('error'));

  return {
    send(payload) {
      if (closed || payload.length > maxPayload) {
        return false;
      }
      const head = Buffer.alloc(HEADER_BYTES);
      head.writeUInt32LE(payload.length, 0);
      try {
        socket.write(Buffer.concat([head, payload]));
      } catch {
        finish('error');
        return false;
      }
      return true;
    },
    upgrade(nextMax: number): void {
      maxPayload = nextMax;
    },
    get maxPayload(): number {
      return maxPayload;
    },
    get closed(): boolean {
      return closed;
    },
    close(): void {
      if (closed) {
        return;
      }
      try {
        socket.destroy();
      } catch {
        // Best effort — the peer may already be gone.
      }
      finish('local');
    },
  };
}
