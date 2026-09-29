// Coverage for the pure helpers the hook wires: the advance walk
// target, the row-actions sheet list, the stage download affordance,
// the playlist download plan, and the stored-error retry toast. The
// hook itself is thin wiring — the app-level journeys keep behavior
// identical evidence.
import { assert, assertEqual } from '@auqw/application/testing';
import {
  setLocale,
  setToastSink,
  t,
} from '@auqw/ui-shared';
import {
  fixtureEntityItems,
  fixtureQueue,
} from '@auqw/ui-shared/fixtures';
import type { DownloadRecord } from '@auqw/application';
import {
  advanceTargetId,
  playlistDownloadPlan,
  reportStoredDownloadError,
  rowActionsModel,
  stageDownloadChip,
} from './types.ts';
import type { SourceRef } from '@auqw/application';

setLocale('en');

// ---- advanceTargetId ------------------------------------------------
// The gate sees the walk target the engine would land on: next skips
// failed occurrences, previous restarts past 3 s / steps back
// otherwise, and repeat=all wraps both edges.

const occ = (id: string) => ({ occurrenceId: id, recordingId: `r-${id}` });
const occurrences = fixtureQueue.occurrences.map((o) => ({
  occurrenceId: o.occurrenceId,
  recordingId: o.recordingId,
}));

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  'occ-2',
  'next walks the canonical order',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: null,
    failedIds: new Set(['occ-2']),
    repeat: 'off',
    positionMs: 0,
  }),
  'occ-3',
  'next skips a marked-failed target like the engine does',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-8',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'all',
    positionMs: 0,
  }),
  'occ-1',
  'repeat=all wraps the tail back to the walk head',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-8',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  null,
  'no wrap under repeat=off',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: 'occ-4',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 97_200,
  }),
  'occ-4',
  'previous past 3 s restarts the current track',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: 'occ-4',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 1_000,
  }),
  'occ-3',
  'previous early in the track steps back one',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'all',
    positionMs: 1_000,
  }),
  'occ-8',
  'repeat=all wraps the head back to the tail',
);

// Dealt (shuffle) walk: positions follow the dealt order, not the
// canonical one.
assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: 'occ-1',
    dealtOrder: ['occ-1', 'occ-5', 'occ-2'],
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  'occ-5',
  'shuffle walks the dealt order',
);

assertEqual(
  advanceTargetId({
    method: 'next',
    occurrences,
    currentOccurrenceId: null,
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  null,
  'no cursor → no next target',
);

assertEqual(
  advanceTargetId({
    method: 'previous',
    occurrences,
    currentOccurrenceId: null,
    dealtOrder: null,
    failedIds: new Set(),
    repeat: 'off',
    positionMs: 0,
  }),
  null,
  'no cursor → previous stays put',
);

// ---- rowActionsModel -------------------------------------------------
const ref: SourceRef = { provider: 'ytm', kind: 'track', id: 'x1' };
const rec = (state: DownloadRecord['state']) =>
  ({
    state,
    error:
      state === 'failed_with_retry'
        ? { kind: 'offline', message: 'no link' }
        : null,
  }) as Pick<DownloadRecord, 'state' | 'error'>;

// Entity fixtures carry albumRef+artistRef so the metadata branch
// exercises the entity-hop actions too.
const meta = fixtureEntityItems[0]!;

const baseKeys = rowActionsModel({
  target: { kind: 'recording', recordingId: 'r-1' },
  liked: false,
  title: 'T',
  recordFor: () => null,
  downloadRefFor: () => ref,
  radioSeedable: false,
}).actions.map((a) => a.key);
assertEqual(
  baseKeys.join(','),
  'like,enqueue,add,download',
  'recording rows carry like/enqueue/add/download',
);

assert(
  rowActionsModel({
    target: { kind: 'recording', recordingId: 'r-1' },
    liked: true,
    title: 'T',
    recordFor: () => null,
    downloadRefFor: () => ref,
    radioSeedable: false,
  }).actions[0]!.label === t('common.unlike'),
  'a liked target offers Unlike',
);

{
  const actions = rowActionsModel({
    target: { kind: 'recording', recordingId: 'r-1' },
    liked: false,
    title: 'T',
    recordFor: () => rec('failed_with_retry'),
    downloadRefFor: () => null,
    radioSeedable: false,
  }).actions.map((a) => a.key);
  assertEqual(
    actions.join(','),
    'like,enqueue,add,download,removeDownload',
    'a failed ledger row offers retry AND an explicit remove out',
  );
}

{
  const actions = rowActionsModel({
    target: { kind: 'metadata', meta },
    liked: false,
    title: 'T',
    recordFor: () => null,
    downloadRefFor: () => null,
    radioSeedable: true,
  }).actions.map((a) => a.key);
  assertEqual(
    actions.join(','),
    'enqueue,add,radio,album,artist',
    'metadata rows carry enqueue/add + seedable radio + entity hops',
  );
}

assertEqual(
  rowActionsModel({
    target: { kind: 'metadata', meta },
    liked: false,
    title: 'T',
    recordFor: () => null,
    downloadRefFor: () => null,
    radioSeedable: false,
  }).actions.some((a) => a.key === 'radio'),
  false,
  'the radio affordance hides when the seed provider cannot seed',
);

// ---- stageDownloadChip ----------------------------------------------
assertEqual(
  stageDownloadChip({
    recordingId: null,
    recordFor: () => rec('available'),
    downloadRefFor: () => ref,
    chipFor: () => 'idle',
  }),
  null,
  'no playing track → no affordance',
);

assertEqual(
  stageDownloadChip({
    recordingId: 'r-1',
    recordFor: () => null,
    downloadRefFor: () => null,
    chipFor: () => 'idle',
  }),
  null,
  'unowned + undownloadable → hidden',
);

assertEqual(
  stageDownloadChip({
    recordingId: 'r-1',
    recordFor: () => null,
    downloadRefFor: () => ref,
    chipFor: () => null,
  }),
  'idle',
  'downloadable but not started shows the idle chip',
);

assertEqual(
  stageDownloadChip({
    recordingId: 'r-1',
    recordFor: () => rec('available'),
    downloadRefFor: () => null,
    chipFor: () => 'stored',
  }),
  'stored',
  'a ledger row surfaces its chip even with no provider ref',
);

// ---- playlistDownloadPlan -------------------------------------------
const entry = (recordingId: string) => ({ recordingId, selectedRef: null });

{
  const plan = playlistDownloadPlan({
    entries: [entry('a'), entry('b')],
    isOwned: () => false,
    downloadRefFor: () => ref,
    recordFor: () => null,
  });
  assertEqual(plan.state, 'none');
  assertEqual(plan.requests.length, 2);
}

{
  const plan = playlistDownloadPlan({
    entries: [entry('a'), entry('b'), entry('c')],
    isOwned: (id) => id === 'a',
    downloadRefFor: (id) => (id === 'c' ? null : ref),
    recordFor: () => null,
  });
  assertEqual(plan.state, 'partial');
  assertEqual(
    plan.requests.map((r) => r.recordingId).join(','),
    'b',
    'requests skip owned rows and unresolvable refs',
  );
}

{
  const plan = playlistDownloadPlan({
    entries: [entry('a')],
    isOwned: () => true,
    downloadRefFor: () => ref,
    recordFor: () => rec('available'),
  });
  assertEqual(plan.state, 'all');
  assertEqual(plan.requests.length, 0);
}

// ---- reportStoredDownloadError --------------------------------------
const toasts: string[] = [];
setToastSink((text) => {
  toasts.push(text);
});
reportStoredDownloadError(null);
assertEqual(toasts.length, 0, 'no stored error → no toast');
reportStoredDownloadError({ kind: 'offline', message: 'no link' });
assertEqual(toasts.length, 1, 'stored error toasts');

console.log('app-shell tests passed');
