import {
  isPumpClientMessage,
  type PumpError,
  type PumpReady,
  type PumpServerMessage,
} from '../shared/pump-protocol.ts';
import type { PluginHostLike } from './host.ts';
import { napiSlug } from './stream.ts';

/**
 * The utility-side byte pump for one prepared stream handle. It owns a
 * single `streamOpen` attach (opened at port attach, closed on client
 * `close`/port end) and pushes `streamRead` chunks to the renderer over
 * a brokered MessagePort — the MSE primary path's byte feed.
 *
 * Flow control is credit-based (`grant`), seeks re-anchor via `seek` +
 * epoch bump so stale in-flight reads are dropped client-side.
 */

/** The brokered port shape — MessagePortMain's structural subset. */
export type PumpPort = {
  postMessage(message: unknown): void;
  on(
    event: 'message' | 'close',
    listener: (event?: { data: unknown }) => void,
  ): void;
  start(): void;
  close(): void;
};

const READ_LEN = 128 * 1024;
const MAX_IN_FLIGHT_READS = 1;

/**
 * Seam verdicts the read retry can still beat in place: a latched
 * `transient`/`rate-limit` surfaces on one read and the *next* read
 * re-drives the seam pump (re-mint/refetch behind the same attach).
 * Retrying there keeps the MSE pipeline alive through a flap the way
 * Media3's in-place read retry does on mobile — every other kind is
 * terminal for this handle (dead → the engine's re-prepare hop) or
 * untyped (transport death → io-error). The budget caps how much
 * silence a stalling upstream can buy before the verdict reports.
 */
const READ_RETRY_KINDS: ReadonlySet<string> = new Set([
  'transient',
  'rate-limit',
]);
const READ_RETRY_ATTEMPTS = 2;
export const READ_RETRY_BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createStreamPump(deps: {
  readonly host: () => PluginHostLike;
  readonly handle: string;
  readonly port: PumpPort;
}): void {
  let opened = false;
  let closed = false;
  let position = 0;
  let credit = 0;
  let epoch = 0;
  let eof = false;
  let pumping = false;
  // Re-drive budget for in-place latch kinds; a served chunk resets
  // it — a new flap earns fresh retries.
  let readRetries = 0;
  // Reads the stream at most one at a time; a seek while a read is in
  // flight just re-anchors — the in-flight chunk carries the old epoch
  // and the client drops it on arrival.
  let inFlight = 0;

  function send(message: PumpServerMessage): void {
    if (closed) {
      return;
    }
    try {
      deps.port.postMessage(message);
    } catch {
      // A dead renderer port leaves the pump without a client — close.
      close();
    }
  }

  function sendError(code: string): void {
    const message: PumpError = {
      kind: 'error',
      epoch,
      code,
      // The code carries the taxonomy; raw throw text (paths, native
      // messages) never crosses the pump boundary.
      message: 'pump failed',
    };
    send(message);
    close();
  }

  async function pump(): Promise<void> {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      while (!closed && credit > 0 && !eof) {
        if (inFlight >= MAX_IN_FLIGHT_READS) {
          return;
        }
        inFlight += 1;
        const readPosition = position;
        const readEpoch = epoch;
        try {
          const chunk = await deps
            .host()
            .streamRead(deps.handle, readPosition, Math.min(READ_LEN, credit));
          inFlight -= 1;
          if (closed) {
            return;
          }
          if (readEpoch !== epoch) {
            // Stale-epoch read: the client re-anchored while this was in
            // flight — drop the chunk and re-issue at the new position.
            continue;
          }
          if (chunk.byteLength === 0) {
            eof = true;
            send({ kind: 'eof', epoch });
            return;
          }
          readRetries = 0;
          position += chunk.byteLength;
          credit -= chunk.byteLength;
          send({
            kind: 'data',
            position: readPosition,
            epoch,
            bytes: new Uint8Array(chunk),
          });
        } catch (thrown) {
          inFlight -= 1;
          if (readEpoch !== epoch) {
            // Stale-epoch read failed after a seek — keep pumping at
            // the re-anchored position; returning here strands the
            // post-seek grant's credit with nothing left to spend it.
            continue;
          }
          const slug = napiSlug(thrown);
          if (
            slug !== null &&
            READ_RETRY_KINDS.has(slug) &&
            readRetries < READ_RETRY_ATTEMPTS
          ) {
            // The latch answered this read; re-reading re-drives the
            // seam's own recovery under the same attach. The backoff
            // keeps a re-latching seam from spinning the loop; close
            // is re-checked by the while condition.
            readRetries += 1;
            await sleep(READ_RETRY_BACKOFF_MS);
            continue;
          }
          // A typed napi rejection carries its taxonomy slug — a
          // re-mint verdict like `provider-wall` must reach the
          // renderer verbatim; only untyped transport deaths are
          // io-error.
          sendError(slug ?? 'io-error');
          return;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    try {
      if (opened) {
        deps.host().streamClose(deps.handle);
      }
    } catch {
      // Detach is best-effort — the registry reaps dead attaches anyway.
    }
    try {
      deps.port.close();
    } catch {
      // Port may already be closed from the renderer side.
    }
  }

  try {
    const remaining = deps.host().streamOpen(deps.handle, 0);
    opened = true;
    const ready: PumpReady = { kind: 'ready', remaining, epoch };
    send(ready);
  } catch {
    sendError('unavailable');
    return;
  }

  deps.port.on('message', (event) => {
    const raw: unknown = event?.data;
    if (!isPumpClientMessage(raw)) {
      return;
    }
    switch (raw.kind) {
      case 'grant':
        credit += raw.bytes;
        void pump();
        break;
      case 'seek':
        position = raw.position;
        epoch = raw.epoch;
        credit = 0;
        eof = false;
        break;
      case 'close':
        close();
        break;
    }
  });
  deps.port.on('close', () => {
    close();
  });
  deps.port.start();
}
