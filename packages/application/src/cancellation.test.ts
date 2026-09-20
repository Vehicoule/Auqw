import { CancellationSource } from './cancellation.ts';
import { assert, assertEqual } from './testing/assert.ts';

export function run(): void {
  const source = new CancellationSource();
  assert(!source.signal.cancelled);

  let fired = 0;
  const unsub = source.signal.subscribe(() => {
    fired += 1;
  });
  source.cancel();
  assert(source.signal.cancelled);
  assertEqual(fired, 1);

  // Idempotent cancel: listeners fire once.
  source.cancel();
  assertEqual(fired, 1);

  // Unsubscribe prevents delivery.
  const s2 = new CancellationSource();
  let fired2 = 0;
  const unsub2 = s2.signal.subscribe(() => {
    fired2 += 1;
  });
  unsub2();
  unsub2(); // double-unsubscribe is safe
  s2.cancel();
  assertEqual(fired2, 0);
  void unsub;

  // Subscribing after cancel invokes immediately, returns no-op.
  const s3 = new CancellationSource();
  s3.cancel();
  let fired3 = 0;
  const unsub3 = s3.signal.subscribe(() => {
    fired3 += 1;
  });
  assertEqual(fired3, 1);
  unsub3();
  assertEqual(fired3, 1);

  // A throwing listener does not prevent other listeners.
  const s4 = new CancellationSource();
  let fired4 = 0;
  s4.signal.subscribe(() => {
    throw new Error('boom');
  });
  s4.signal.subscribe(() => {
    fired4 += 1;
  });
  s4.cancel();
  assertEqual(fired4, 1);
}
