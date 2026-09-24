import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import {
  dirTreeUri,
  docIdConfined,
  docUriFor,
  parseTree,
  pathConfined,
  pickedFileTreeUri,
  toFileUri,
} from './local-paths.ts';

export function run(): void {
  // toFileUri: pathToFileURL handles separators and escapes — the URI
  // stays navigable for Chromium's file-scheme parser.
  assertEqual(
    toFileUri('/music/a b/c#d.wav'),
    'file:///music/a%20b/c%23d.wav',
    'segments encode, separators preserved',
  );

  // Grants mint as file: URLs — platform-independent by construction
  // (drive letters + UNC parse via fileURLToPath on Windows).
  assertEqual(dirTreeUri('/music/rips'), 'file:///music/rips', 'dir grant');
  assertEqual(
    pickedFileTreeUri('/m/a.wav'),
    'picked-file:file:///m/a.wav',
    'picked-file grant',
  );

  // docUriFor: dir trees join the POSIX docId under the tree; picked
  // files return the embedded file URL verbatim.
  assertEqual(
    docUriFor('file:///music', 'sub/a.wav'),
    'file:///music/sub/a.wav',
    'dir tree docUri',
  );
  assertEqual(
    docUriFor('file:///music/', 'a.wav'),
    'file:///music/a.wav',
    'trailing slash normalized',
  );
  assertEqual(
    docUriFor('picked-file:file:///m/solo.wav', 'solo.wav'),
    'file:///m/solo.wav',
    'picked-file docUri ignores docId',
  );
  assertEqual(
    docUriFor('content://tree/x', 'a'),
    null,
    'foreign schemes resolve null',
  );
  // A Windows-minted dir grant still resolves — the URI form is
  // platform-independent even when the OS path is not.
  assertEqual(
    docUriFor('file:///C:/Music/rips', 'sub/a.wav'),
    'file:///C:/Music/rips/sub/a.wav',
    'drive-letter grant docUri',
  );

  // parseTree round-trips both grant shapes and refuses non-URL forms.
  const dir = parseTree('file:///music/rips');
  assert(
    dir?.kind === 'dir' && dir.absPath === '/music/rips',
    'dir parse',
  );
  const file = parseTree('picked-file:file:///m/a.wav');
  assert(
    file?.kind === 'file' && file.absPath === '/m/a.wav',
    'picked-file parse',
  );
  assertEqual(parseTree('relative/path'), null, 'relatives rejected');
  assertEqual(
    parseTree('/bare/posix/path'),
    null,
    'bare paths are not grants — grants are file: URLs',
  );

  // docId confinement: escapes and separator tricks refuse.
  assert(docIdConfined('sub/a.wav'), 'normal docId passes');
  assert(!docIdConfined('../up'), 'parent escape refused');
  assert(!docIdConfined('a/../b'), 'mid-path escape refused');
  assert(!docIdConfined('/abs'), 'absolute docId refused');
  assert(!docIdConfined('a\\b'), 'backslash refused');
  assert(!docIdConfined(''), 'empty refused');
  assert(!docIdConfined('a/./b'), 'dot segment refused');

  // pathConfined: strictly-inside semantics, platform-aware.
  assert(pathConfined('/root', '/root/a/b'), 'child inside');
  assert(!pathConfined('/root', '/root'), 'root is not inside itself');
  assert(!pathConfined('/root', '/root/../other'), 'escape refused');
  assert(!pathConfined('/root', '/roots/x'), 'sibling-prefix refused');
  assert(
    pathConfined('/root', '/root/..hidden/song.wav'),
    'a ..-named folder inside the tree stays confined',
  );
}
