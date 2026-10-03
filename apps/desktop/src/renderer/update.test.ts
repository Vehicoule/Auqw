import { assertDeepEqual, assertEqual } from '@auqw/application/testing';
import type {
  AuqwApi,
  UpdateSnapshotPayload,
} from '../shared/contract.ts';
import { createDesktopUpdate } from './update.ts';

/**
 * The renderer's update port — act() routes the verb the banner/card
 * showed: 'ready-to-restart' only restarts while the checked release
 * IS the staged run's; a newer release's offer supersedes into the
 * new pipeline (or the release page), never into the stale image.
 */

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
};

const ASSET_URL =
  'https://github.com/Vehicoule/Auqw/releases/download/vX/auqw.AppImage';
const RELEASE_URL = 'https://github.com/Vehicoule/Auqw/releases/tag/vX';

const snapshot = (
  version: string,
  apply: UpdateSnapshotPayload['apply'],
  capability: UpdateSnapshotPayload['capability'] = 'install',
): UpdateSnapshotPayload => ({
  status: {
    state: 'available',
    version,
    url: RELEASE_URL,
    artifact: { name: 'auqw.AppImage', url: ASSET_URL },
    checksums: { name: 'SHA256SUMS-Linux.txt', url: ASSET_URL },
  },
  currentVersion: '0.1.0',
  apply,
  capability,
});

function fakeApi(): {
  api: AuqwApi;
  calls: string[];
  push: (payload: UpdateSnapshotPayload) => void;
} {
  const calls: string[] = [];
  let listener: ((payload: UpdateSnapshotPayload) => void) | null = null;
  const idle: UpdateSnapshotPayload = {
    status: { state: 'idle' },
    currentVersion: '0.1.0',
    apply: { state: 'idle' },
    capability: 'install',
  };
  const verb = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };
  return {
    api: {
      update: {
        status: () => Promise.resolve(idle),
        check: () => Promise.resolve(idle),
        open: verb('open'),
        apply: verb('apply'),
        reapply: verb('reapply'),
        cancel: verb('cancel'),
        restart: verb('restart'),
        onState: (l: (payload: UpdateSnapshotPayload) => void) => {
          listener = l;
          return () => undefined;
        },
      },
    } as unknown as AuqwApi,
    calls,
    push: (payload) => listener?.(payload),
  };
}

export async function run(): Promise<void> {
  // same-version 'ready-to-restart' → the restart verb relaunches
  {
    const { api, calls, push } = fakeApi();
    const port = createDesktopUpdate(api);
    port.subscribe(() => undefined);
    await settle();
    push(snapshot('9.9.9', { state: 'ready-to-restart', version: '9.9.9' }));
    port.act();
    await settle();
    assertDeepEqual(calls, ['restart']);
  }

  // a newer checked release supersedes the staged restart — the
  // offer's tap starts ITS pipeline, never restarts into the stale
  // image; same routing the 'applied' leg already had
  {
    const { api, calls, push } = fakeApi();
    const port = createDesktopUpdate(api);
    port.subscribe(() => undefined);
    await settle();
    push(
      snapshot('9.9.10', {
        state: 'ready-to-restart',
        version: '9.9.9',
      }),
    );
    port.act();
    await settle();
    assertDeepEqual(calls, ['apply']);
  }

  // …and on an 'open' build the superseding offer opens the page
  {
    const { api, calls, push } = fakeApi();
    const port = createDesktopUpdate(api);
    port.subscribe(() => undefined);
    await settle();
    push(
      snapshot(
        '9.9.10',
        { state: 'ready-to-restart', version: '9.9.9' },
        'open',
      ),
    );
    port.act();
    await settle();
    assertDeepEqual(calls, ['open']);
  }

  // a live run ignores the affordance — cancel is the card's verb
  {
    const { api, calls, push } = fakeApi();
    const port = createDesktopUpdate(api);
    port.subscribe(() => undefined);
    await settle();
    push(snapshot('9.9.9', { state: 'verifying', version: '9.9.9' }));
    port.act();
    await settle();
    assertEqual(calls.length, 0);
  }
}
