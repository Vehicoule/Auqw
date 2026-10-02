import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertEqual } from '@auqw/application/testing';
import { verifyUtilityIntegrity } from './utility-integrity.ts';

function sha(file: string): string {
  return createHash('sha256').update(file, 'utf8').digest('hex');
}

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'auqw-integrity-'));
  try {
    // A manifest covering the loose files verifies silently.
    mkdirSync(join(dir, 'app.asar.unpacked'), { recursive: true });
    writeFileSync(
      join(dir, 'app.asar.unpacked', 'index.cjs'),
      'utility entry',
      'utf8',
    );
    writeFileSync(join(dir, 'auqw_node_bindings.node'), 'napi', 'utf8');
    writeFileSync(
      join(dir, 'utility-integrity.sha256'),
      [
        `${sha('utility entry')}  app.asar.unpacked/index.cjs`,
        `${sha('napi')}  auqw_node_bindings.node`,
        '',
      ].join('\n'),
      'utf8',
    );
    verifyUtilityIntegrity(dir);

    // A tampered byte anywhere refuses the fork.
    writeFileSync(
      join(dir, 'app.asar.unpacked', 'index.cjs'),
      'utility entry — patched',
      'utf8',
    );
    assertEqual(
      throws(() => verifyUtilityIntegrity(dir)),
      'utility-integrity: digest mismatch: app.asar.unpacked/index.cjs',
    );

    // A manifest entry for a file that is gone refuses too.
    writeFileSync(
      join(dir, 'app.asar.unpacked', 'index.cjs'),
      'utility entry',
      'utf8',
    );
    rmSync(join(dir, 'auqw_node_bindings.node'));
    assertEqual(
      throws(() => verifyUtilityIntegrity(dir)),
      'utility-integrity: manifest names a missing file: auqw_node_bindings.node',
    );
    writeFileSync(join(dir, 'auqw_node_bindings.node'), 'napi', 'utf8');

    // No manifest at all — packaged forks refuse.
    rmSync(join(dir, 'utility-integrity.sha256'));
    assert(
      throws(() => verifyUtilityIntegrity(dir)).startsWith(
        'utility-integrity: manifest missing',
      ),
      'missing manifest did not refuse',
    );

    // Traversal / malformed lines refuse — a manifest must only ever
    // name files beneath resourcesPath.
    writeFileSync(
      join(dir, 'utility-integrity.sha256'),
      `${sha('utility entry')}  ../../etc/passwd\n`,
      'utf8',
    );
    assert(
      throws(() => verifyUtilityIntegrity(dir)).startsWith(
        'utility-integrity: malformed manifest',
      ),
      'traversal line did not refuse',
    );
    writeFileSync(join(dir, 'utility-integrity.sha256'), '\n', 'utf8');
    assert(
      throws(() => verifyUtilityIntegrity(dir)).startsWith(
        'utility-integrity: manifest covered no files',
      ),
      'empty manifest did not refuse',
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function throws(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}
