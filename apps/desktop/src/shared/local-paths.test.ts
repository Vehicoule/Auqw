import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import {
  docIdConfined,
  docUriFor,
  parseTree,
  toFileUri,
} from './local-paths.ts';

export function run(): void {
  // toFileUri: per-segment encoding keeps '/' structure, escapes the
  // bytes a URL can't carry.
  assertEqual(
    toFileUri('/music/a b/c#d.wav'),
    'file:///music/a%20b/c%23d.wav',
    'segments encode, separators preserved',
  );
  assertEqual(
    toFileUri('/rel'),
    'file:///rel',
    'rooted paths stay rooted',
  );

  // docUriFor: dir trees join; picked-file trees return the file.
  assertEqual(
    docUriFor('/music', 'sub/a.wav'),
    'file:///music/sub/a.wav',
    'dir tree docUri',
  );
  assertEqual(
    docUriFor('/music/', 'a.wav'),
    'file:///music/a.wav',
    'trailing slash normalized',
  );
  assertEqual(
    docUriFor('picked-file:/m/solo.wav', 'solo.wav'),
    'file:///m/solo.wav',
    'picked-file docUri ignores docId',
  );
  assertEqual(
    docUriFor('content://tree/x', 'a'),
    null,
    'foreign schemes resolve null',
  );

  // parseTree round-trips the two desktop grant shapes.
  const dir = parseTree('/music/rips');
  assert(dir?.kind === 'dir' && dir.absPath === '/music/rips', 'dir parse');
  const file = parseTree('picked-file:/m/a.wav');
  assert(
    file?.kind === 'file' && file.absPath === '/m/a.wav',
    'picked-file parse',
  );
  assertEqual(parseTree('relative/path'), null, 'relatives rejected');

  // docId confinement: escapes and separator tricks refuse.
  assert(docIdConfined('sub/a.wav'), 'normal docId passes');
  assert(!docIdConfined('../up'), 'parent escape refused');
  assert(!docIdConfined('a/../b'), 'mid-path escape refused');
  assert(!docIdConfined('/abs'), 'absolute docId refused');
  assert(!docIdConfined('a\\b'), 'backslash refused');
  assert(!docIdConfined(''), 'empty refused');
}
