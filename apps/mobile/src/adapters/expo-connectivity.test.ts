import { assert, assertEqual } from '@auqw/application/testing';
import type {
  AuqwConnectivityEvent,
  AuqwConnectivityNative,
  AuqwExpoSubscription,
} from './auqw-expo-surface.ts';
import { createExpoConnectivity } from './expo-connectivity.ts';

class FakeConnectivityNative implements AuqwConnectivityNative {
  watchers = 0;
  failSnapshot = false;
  private readonly listeners = new Set<
    (event: AuqwConnectivityEvent) => void
  >();

  connectivitySnapshot(): Promise<AuqwConnectivityEvent> {
    if (this.failSnapshot) {
      return Promise.reject(new Error('native absent'));
    }
    return Promise.resolve({ online: true, metered: false });
  }

  failWatch = false;

  connectivityWatch(): void {
    if (this.failWatch) {
      throw new Error('callback quota exceeded');
    }
    this.watchers += 1;
    // Native emits a baseline edge on watch.
    this.emit({ online: true, metered: false });
  }

  connectivityUnwatch(): void {
    this.watchers -= 1;
  }

  addConnectivityChangedListener(
    listener: (event: AuqwConnectivityEvent) => void,
  ): AuqwExpoSubscription {
    this.listeners.add(listener);
    let active = true;
    return {
      remove: () => {
        if (active) {
          active = false;
          this.listeners.delete(listener);
        }
      },
    };
  }

  emit(event: AuqwConnectivityEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

export async function run(): Promise<void> {
  // Refcount: first subscribe watches once; a second subscribe does
  // not re-watch; baseline edge reaches subscribers immediately.
  {
    const native = new FakeConnectivityNative();
    const port = createExpoConnectivity(native);
    const seen: AuqwConnectivityEvent[] = [];
    const off1 = port.subscribe((e) => seen.push(e));
    assertEqual(native.watchers, 1);
    assertEqual(seen.length, 1); // baseline edge on first watch
    const off2 = port.subscribe(() => {});
    assertEqual(native.watchers, 1);
    off1();
    assertEqual(native.watchers, 1); // still one listener left
    off2();
    assertEqual(native.watchers, 0); // last unsubscribe drops watch
    const off3 = port.subscribe(() => {});
    assertEqual(native.watchers, 1); // re-watch on a fresh subscribe
    off3();
  }

  // Change edges fan out; a throwing listener cannot break others.
  {
    const native = new FakeConnectivityNative();
    const port = createExpoConnectivity(native);
    const seen: AuqwConnectivityEvent[] = [];
    port.subscribe((e) => seen.push(e));
    port.subscribe(() => {
      throw new Error('listener exploded');
    });
    native.emit({ online: false, metered: false });
    assertEqual(seen.length, 2); // baseline + the real edge
    assertEqual(seen[1]?.online, false);
  }

  // Watch failure rolls back watching + listener so retry succeeds.
  {
    const native = new FakeConnectivityNative();
    const port = createExpoConnectivity(native);
    native.failWatch = true;
    let threw = false;
    try {
      port.subscribe(() => {});
    } catch {
      threw = true;
    }
    assert(threw, 'watch failure should propagate to subscribe');
    assertEqual(native.watchers, 0);
    native.failWatch = false;
    const off = port.subscribe(() => {});
    assertEqual(native.watchers, 1); // clean retry after rollback
    off();
    // The abandoned first listener still holds the watch open — it is
    // a live subscriber that never got an unsub handle.
    assertEqual(native.watchers, 1);
  }

  // Snapshot plumbing failure degrades to honest offline, never a throw.
  {
    const native = new FakeConnectivityNative();
    native.failSnapshot = true;
    const port = createExpoConnectivity(native);
    const snap = await port.snapshot();
    assert(snap.ok, 'snapshot should degrade, not reject');
    assertEqual(snap.value.online, false);
  }
}
