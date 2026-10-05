import { assert, assertEqual } from '@auqw/application/testing';
import {
  FEED_CURRENT_FILE,
  parseFeedCurrent,
  serializeFeedCurrent,
} from './feed-current.ts';

/**
 * The last-known feed authority set's sidecar codec — the boot-time
 * revocation gate's contract. Anything but a strict `{current:[ids]}`
 * in feed-id grammar must fail open (null), never fail closed.
 */
export async function runFeedCurrent(): Promise<void> {
  // The sync sweep exempts exactly this name — drift between the two
  // silently sweeps the authority set itself.
  assertEqual(FEED_CURRENT_FILE, 'feed.json');

  // Round-trip preserves the set's membership, not its order.
  const set = parseFeedCurrent(serializeFeedCurrent(['alpha', 'b-2']));
  assert(set !== null, 'serialized set parses');
  assert(set.has('alpha') && set.has('b-2') && set.size === 2);

  // Every deviation fails open — a malformed or hostile sidecar can
  // never gate last-known-good loads.
  assertEqual(parseFeedCurrent('not json'), null);
  assertEqual(parseFeedCurrent('null'), null);
  assertEqual(parseFeedCurrent('[]'), null);
  assertEqual(parseFeedCurrent('{}'), null);
  assertEqual(parseFeedCurrent('{"current":"alpha"}'), null);
  assertEqual(parseFeedCurrent('{"current":[1]}'), null);
  assertEqual(parseFeedCurrent('{"current":[null]}'), null);
  // Non-feed-id shapes are deviations — 'Alpha', '-lead', 'trail_'
  // can never be legitimate entries, so the whole document is null.
  assertEqual(parseFeedCurrent('{"current":["Alpha"]}'), null);
  assertEqual(parseFeedCurrent('{"current":["-lead"]}'), null);
  assertEqual(parseFeedCurrent('{"current":["trail_"]}'), null);
  // One bad entry invalidates the document.
  assertEqual(parseFeedCurrent('{"current":["alpha",1]}'), null);
  // Over the cap fails open too.
  assertEqual(
    parseFeedCurrent(
      serializeFeedCurrent(
        Array.from({ length: 200 }, (_, i) => `p${i}`),
      ),
    ),
    null,
  );

  // A valid set gates on membership — the revoked-id check the boot
  // load applies per verified pair.
  const gated = parseFeedCurrent('{"current":["deezer","ytm"]}');
  assert(gated !== null);
  assert(gated.has('deezer') && !gated.has('itunes'));
}
