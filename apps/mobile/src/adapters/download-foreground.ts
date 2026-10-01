/**
 * Single owner for the dataSync foreground-service count. The native
 * `downloadsActiveChanged` takes the ABSOLUTE active-download count —
 * a second writer passing its own count (the update APK saying 0
 * while a media transfer is live, or vice versa) would drop the
 * other's background protection mid-flight. Every writer funnels
 * through this aggregate: the media controller reports its row count,
 * non-media downloads hold a ref, and the sum is what reaches native.
 *
 * Delivery is tracked separately from the desired count: a rejected
 * send leaves `delivered` stale so the next report — including the
 * disposal's zero — retries the edge. Writers' `send` should let a
 * native rejection propagate (log first if needed); the drain
 * swallows it after marking undelivered.
 */

type Send = (count: number) => Promise<unknown>;

let send: Send | null = null;
let mediaCount = 0;
let extraHolds = 0;
let delivered = -1;
let draining = false;

async function drain(): Promise<void> {
  if (draining) {
    return;
  }
  draining = true;
  try {
    // Re-checks the aggregate per pass: counts landing mid-flight
    // coalesce to the latest desired value — only the newest edge is
    // ever on the wire.
    while (delivered !== mediaCount + extraHolds) {
      const transport = send;
      if (transport === null) {
        return;
      }
      const next = mediaCount + extraHolds;
      try {
        await transport(next);
        delivered = next;
      } catch {
        // A failed edge stays undelivered — the next emit retries
        // it, so a dropped zero can't leave the service running.
        return;
      }
    }
  } finally {
    draining = false;
  }
}

function emit(): Promise<void> {
  return drain();
}

/** The media controller's transferring-row count, re-derived per
    download-set change. The caller's `send` wraps the native call
    (with its own logging) — whichever writer last registered is the
    transport, since every send targets the same native method. */
export function mediaDownloadsActive(
  nextSend: Send,
  count: number,
): Promise<void> {
  send = nextSend;
  mediaCount = count;
  return emit();
}

/**
 * A non-media download — the update APK — holds background
 * protection for its own lifetime. Ref-counted so its release never
 * zeroes a live media count (and vice versa); the returned release
 * is idempotent.
 */
export function holdDownloadForeground(nextSend: Send): () => void {
  send = nextSend;
  extraHolds += 1;
  void emit();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    extraHolds -= 1;
    void emit();
  };
}
