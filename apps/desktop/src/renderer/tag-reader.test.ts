import type { CancellationSignal } from '@auqw/application';
import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import type { AuqwApi } from '../shared/contract.ts';
import { shellError } from '../shared/errors.ts';
import { createDesktopTagReader } from './tag-reader.ts';

const signal: CancellationSignal = {
  cancelled: false,
  subscribe: () => () => undefined,
};

function fakeApi(overrides: {
  pickFolder?: () => Promise<string | null>;
  pickFiles?: () => Promise<readonly string[]>;
  localAdd?: (args: { paths: readonly string[] }) => Promise<unknown>;
  enumerate?: (args: { treeUri: string }) => Promise<unknown>;
}): AuqwApi {
  return {
    dialog: {
      pickFolder:
        overrides.pickFolder ?? (() => Promise.resolve(null)),
      pickFiles:
        overrides.pickFiles ?? (() => Promise.resolve([])),
    },
    local: {
      add:
        overrides.localAdd ??
        (() =>
          Promise.resolve({
            picks: [
              { treeUri: '/music', label: 'music', kind: 'dir' },
            ],
          })),
    },
    tagread: {
      enumerate:
        overrides.enumerate ??
        (() =>
          Promise.resolve({
            entries: [
              {
                docId: 'a.wav',
                name: 'a.wav',
                size: 10,
                mime: 'audio/wav',
                modifiedMs: 1,
              },
            ],
          })),
      fingerprint: () => Promise.resolve({ fingerprints: [] }),
      read: () => Promise.resolve({ tags: [] }),
    },
  } as unknown as AuqwApi;
}

export async function run(): Promise<void> {
  // pickFolder: dialog → local:add validation → PickedFolder.
  const picked = createDesktopTagReader(
    fakeApi({ pickFolder: () => Promise.resolve('/music') }),
  );
  const folder = await picked.pickFolder(signal);
  assert(folder.ok && folder.value.treeUri === '/music', 'dir pick');

  // Cancelled picker → no-result (the engine treats it as user bail).
  const cancelled = createDesktopTagReader(fakeApi({}));
  const bail = await cancelled.pickFolder(signal);
  assert(!bail.ok && bail.error.kind === 'no-result', 'cancel maps');

  // A staged pick wins over the dialog — the picked-file path.
  const stagedReader = createDesktopTagReader(
    fakeApi({
      pickFolder: () => Promise.reject(new Error('dialog must not open')),
    }),
  );
  stagedReader.stagePick({ treeUri: 'picked-file:/a.wav', label: 'a.wav' });
  const staged = await stagedReader.pickFolder(signal);
  assert(
    staged.ok && staged.value.treeUri === 'picked-file:/a.wav',
    'staged pick consumed first',
  );

  // pickLocalFiles: pickFiles → local:add → staged, returned.
  const filePicker = createDesktopTagReader(
    fakeApi({
      pickFiles: () => Promise.resolve(['/a.wav', '/b.wav']),
      localAdd: (args) =>
        Promise.resolve({
          picks: args.paths.map((p) => ({
            treeUri: `picked-file:${p}`,
            label: p.split('/').pop(),
            kind: 'file' as const,
          })),
        }),
    }),
  );
  const files = await filePicker.pickLocalFiles(signal);
  assert(files.ok && files.value.length === 2, 'two files staged');
  // And each drained pick satisfies a later addFolder without dialog.
  const d1 = await filePicker.pickFolder(signal);
  const d2 = await filePicker.pickFolder(signal);
  assert(
    d1.ok && d1.value.treeUri === 'picked-file:/a.wav' && d2.ok,
    'staged picks drain in order',
  );

  // Enumerate maps the payload shape through.
  const reader = createDesktopTagReader(fakeApi({}));
  const entries = await reader.enumerate('/music', signal);
  assert(
    entries.ok && entries.value[0]?.docId === 'a.wav',
    'enumerate maps entries',
  );

  // A typed failure crosses as the mapped app kind.
  const deniedReader = createDesktopTagReader(
    fakeApi({
      enumerate: () =>
        Promise.reject(
          shellError('permission-denied', 'grant revoked'),
        ),
    }),
  );
  const denied = await deniedReader.enumerate('/music', signal);
  assert(
    !denied.ok && denied.error.kind === 'permission-denied',
    'shell kind maps to app kind',
  );

  // docUri stays sync + pure — same math the utility applies.
  assertEqual(
    reader.docUri('/music', 'sub/a.wav'),
    'file:///music/sub/a.wav',
    'docUri is file:// over the tree',
  );
  assertEqual(
    reader.docUri('picked-file:/m/a b.wav', 'a b.wav'),
    'file:///m/a%20b.wav',
    'picked-file docUri encodes',
  );

  // Cancellation short-circuits before any IPC.
  const cancelledSignal: CancellationSignal = {
    cancelled: true,
    subscribe: () => () => undefined,
  };
  const early = await reader.enumerate('/music', cancelledSignal);
  assert(
    !early.ok && early.error.kind === 'cancelled',
    'cancelled signal short-circuits',
  );
}
