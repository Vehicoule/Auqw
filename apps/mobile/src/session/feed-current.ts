/**
 * The last-known feed authority set, persisted by the mobile feed
 * port (`feed.ts`) so a network-free boot can still refuse plugin
 * pairs the last successful sync had already dropped — the expo
 * host registers guests for the whole session and has no unload
 * seam, so a dropped pair that loads at boot answers provider calls
 * until process restart. The feed sweep exempts this sidecar's
 * name; a missing or malformed document fails open because an
 * unreachable feed never gates last-known-good loads.
 *
 * Native-free so the codec is drivable under plain Node (same
 * convention as `sync-emit.ts`).
 */

/** Sidecar filename inside the plugin cache dir — `syncPluginFeed`'s
 * sweep exempts exactly this name from artifact cleanup. */
export const FEED_CURRENT_FILE = 'feed.json';

/** Persisted shape: `{ "current": [...feed ids] }`. */
export function serializeFeedCurrent(current: readonly string[]): string {
  return JSON.stringify({ current });
}

/** A sidecar naming this many plugins is implausible — fail open
 * rather than let a runaway document pin the gate. */
const MAX_FEED_IDS = 128;

/** One feed id — the `[a-z0-9][a-z0-9-]*` grammar, checked char by
 * char so a hostile sidecar can't ride regex backtracking. */
function isFeedId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 64
  ) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    const lower = c >= 0x61 && c <= 0x7a;
    const digit = c >= 0x30 && c <= 0x39;
    if (!lower && !digit && !(i > 0 && c === 0x2d)) {
      return false;
    }
  }
  return true;
}

/**
 * The gate set from a sidecar body, or null when it deviates in any
 * way — the caller fails open on null. Strict on purpose: anything
 * but a flat `{current: [feed ids]}` is no gate at all.
 */
export function parseFeedCurrent(text: string): ReadonlySet<string> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const current =
    typeof doc === 'object' && doc !== null
      ? (doc as Record<string, unknown>)['current']
      : null;
  if (
    !Array.isArray(current) ||
    current.length > MAX_FEED_IDS ||
    !current.every(isFeedId)
  ) {
    return null;
  }
  return new Set(current);
}
