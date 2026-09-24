import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import { createLocalPlayback } from './local-playback.ts';

export function run(): void {
  const uri = createLocalPlayback({
    mediaDir: '/data/media',
    fileFor: (id) => (id === 'dl' ? 'name.mp4' : null),
    uriFor: (id) => (id === 'local' ? 'file:///music/a.wav' : null),
  });

  // A stored download wins over a local file — the ledger owns bytes.
  assertEqual(
    uri('dl'),
    'file:///data/media/name.mp4',
    'downloads resolve under the managed dir',
  );
  // A provenance-local row falls through to its docUri.
  assertEqual(uri('local'), 'file:///music/a.wav', 'local docUri');
  // Nothing owned → null, per the SessionDeps contract.
  assertEqual(uri('nothing'), null, 'unknown recordings resolve null');

  // Names and dirs with spaces/unicode encode per-segment, not as one
  // blob — the URI stays navigable for Chromium's file scheme parser.
  const spaced = createLocalPlayback({
    mediaDir: '/data/my media',
    fileFor: () => 'a b.mp4',
    uriFor: () => null,
  });
  assertEqual(
    spaced('x'),
    'file:///data/my%20media/a%20b.mp4',
    'spaces percent-encode per segment',
  );

  assert(uri('dl') !== uri('local'), 'priority order is observable');
}
