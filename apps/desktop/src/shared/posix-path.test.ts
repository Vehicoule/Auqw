import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import {
  fileURLToPath,
  isAbsolute,
  join,
  pathToFileURL,
  relative,
} from './posix-path.ts';

export function run(): void {
  // POSIX round-trip — the common host shape.
  assertEqual(fileURLToPath('file:///music/a%20b'), '/music/a b', 'posix decode');
  assertEqual(
    pathToFileURL('/music/a b').href,
    'file:///music/a%20b',
    'posix encode',
  );

  // Drive-letter forms round-trip — the utility mints `file:///C:/...`
  // on Windows and the renderer must hand back the same URI.
  assertEqual(fileURLToPath('file:///C:/Music/rips'), 'C:/Music/rips', 'drive decode');
  assertEqual(
    pathToFileURL('C:/Music/rips').href,
    'file:///C:/Music/rips',
    'drive encode keeps the colon literal',
  );
  assertEqual(
    pathToFileURL(fileURLToPath('file:///D:/x%20y')).href,
    'file:///D:/x%20y',
    'drive round-trip is stable',
  );
  // Windows returns `C:\…` from its own APIs — the encoder normalizes
  // backslashes so the drive colon never reaches %3A.
  assertEqual(
    pathToFileURL('C:\\Music\\rips').href,
    'file:///C:/Music/rips',
    'backslash drive normalizes',
  );
  assertEqual(
    pathToFileURL('\\\\nas\\share\\a.wav').href,
    'file://nas/share/a.wav',
    'backslash UNC normalizes',
  );
  // On POSIX a backslash is a filename character — it encodes as %5C
  // rather than splitting the path.
  assertEqual(
    pathToFileURL('/music/we\\ird.wav').href,
    'file:///music/we%5Cird.wav',
    'posix backslash is a filename char',
  );

  // UNC grants keep their host as the root.
  assertEqual(
    fileURLToPath('file://nas/share/a.wav'),
    '//nas/share/a.wav',
    'UNC decode',
  );
  assertEqual(
    pathToFileURL('//nas/share/a.wav').href,
    'file://nas/share/a.wav',
    'UNC encode',
  );
  assert(isAbsolute('//nas/share'), 'UNC root is absolute');

  // isAbsolute admits every grant shape.
  assert(isAbsolute('/x'), 'posix absolute');
  assert(isAbsolute('C:/x'), 'drive absolute');
  assert(!isAbsolute('rel/x'), 'relative refused');
  assert(!isAbsolute('C:x'), 'drive-relative is not absolute');

  // join keeps the drive root; relative stays honest across roots.
  assertEqual(join('C:/Music', 'sub/a.wav'), 'C:/Music/sub/a.wav', 'drive join');
  assertEqual(join('//nas', 'share/a.wav'), '//nas/share/a.wav', 'UNC join');
  assertEqual(relative('C:/Music', 'C:/Music/sub'), 'sub', 'drive relative');
  assertEqual(
    relative('C:/Music', 'D:/other/x'),
    '../../D:/other/x',
    'cross-drive escapes via ..',
  );
}
