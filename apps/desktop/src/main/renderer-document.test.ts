import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from '@auqw/application/testing';
import { isRendererDocument } from './renderer-document.ts';

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-renderer-doc-'));
  try {
    const renderer = join(dir, 'app.html');
    writeFileSync(renderer, '<html></html>', 'utf8');

    // The exact spelling matches.
    assert(isRendererDocument(renderer, renderer), 'exact path matches');
    // `file:////…` yields a leading `//`; interior doubles and `.`/`..`
    // segments are all the same document.
    assert(
      isRendererDocument(`//${renderer}`, renderer),
      'leading // spelling matches',
    );
    assert(
      isRendererDocument(`${dir}//app.html`, renderer),
      'interior // spelling matches',
    );
    assert(
      isRendererDocument(`${dir}/missing/../app.html`, renderer),
      '.. segment spelling matches',
    );
    // A symlink spelling resolves to the same inode.
    const alias = join(dir, 'alias.html');
    symlinkSync(renderer, alias);
    assert(isRendererDocument(alias, renderer), 'symlink spelling matches');
    // Case variants match where the filesystem is case-insensitive.
    const upper = join(dir, 'APP.HTML');
    assert(
      isRendererDocument(upper, renderer, 'darwin'),
      'case variant matches on darwin',
    );
    assert(
      !isRendererDocument(upper, renderer, 'linux'),
      'case variant is a different name on linux',
    );

    // Sibling names are never the document.
    const other = join(dir, 'other.html');
    writeFileSync(other, '<html></html>', 'utf8');
    assert(!isRendererDocument(other, renderer), 'other file does not match');
    assert(
      !isRendererDocument(join(dir, 'missing.html'), renderer),
      'missing path does not match',
    );
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'app.html'), '<html></html>', 'utf8');
    assert(
      !isRendererDocument(join(sub, 'app.html'), renderer),
      'same basename elsewhere does not match',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
