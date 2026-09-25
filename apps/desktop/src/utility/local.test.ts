import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import { MIGRATIONS } from '@auqw/storage-sqlite';
import { CHANNELS } from '../shared/channels.ts';
import type { UtilityResponse } from './envelope.ts';
import { createUtilityRouter } from './router.ts';
import { createLocalService } from './local.ts';
import { createTagService } from './tags.ts';

export async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'auqw-local-'));
  const userData = join(root, 'userData');
  const mediaDir = join(userData, 'media');
  const dbPath = join(userData, 'auqw.db');
  await mkdir(mediaDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    for (const sql of migration) {
      db.exec(sql);
    }
  }
  const local = createLocalService({ database: () => db, mediaDir });
  const tags = createTagService({ database: () => db });
  const route = createUtilityRouter({
    ...local.handlers,
    ...tags.handlers,
  });
  let nextId = 1;
  const call = (
    channel: string,
    args?: unknown,
  ): Promise<UtilityResponse> => {
    const id = nextId;
    nextId += 1;
    return route({ id, channel, args });
  };
  const insertRecording = (id: string, provenance = 'provider'): void => {
    db.prepare(
      `INSERT INTO recordings (id, title, artwork_json, version_labels_json, provenance)
       VALUES (?, 'x', '[]', '[]', ?)`,
    ).run(id, provenance);
  };

  try {
    // The real-file smoke: pick → add → commit source row → enumerate
    // → index → probe → file://. This is the mount-leg call shape.
    const folder = join(root, 'collection');
    await mkdir(folder, { recursive: true });
    const audio = join(folder, 'demo.wav');
    await writeFile(audio, Buffer.alloc(2048, 1));

    const added = await call(CHANNELS.localAdd, { paths: [folder] });
    assert(added.ok, 'local:add validates a picked dir');
    const pick = (added.result as {
      picks: { treeUri: string; label: string; kind: string }[];
    }).picks[0];
    assertEqual(pick?.kind, 'dir', 'dir pick kind');
    assertEqual(pick?.label, 'collection', 'dir pick label');

    // The engine commits the source row through storage:* — here the
    // insert stands in for SqliteStorage's write path.
    db.prepare(
      'INSERT INTO local_sources (source_id, tree_uri, label, added_ms) VALUES (?, ?, ?, ?)',
    ).run('src-1', pick?.treeUri ?? '', pick?.label ?? '', 1);

    const enumerated = await call(CHANNELS.tagreadEnumerate, {
      treeUri: pick?.treeUri,
    });
    assert(enumerated.ok, 'enumerate the granted tree');
    const docs = (enumerated.result as { entries: { docId: string }[] })
      .entries;
    assertEqual(docs[0]?.docId, 'demo.wav', 'picked dir lists the doc');

    insertRecording('rec-1', 'local');
    db.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-1', 'src-1', 'demo.wav', 2048, 'fp', 'rec-1')`,
    ).run();

    const probed = await call(CHANNELS.localProbe, {
      recordingId: 'rec-1',
    });
    // The service resolves the file through realpath before minting the
    // URI (its confinement check), so the expectation does too — on
    // macOS tmpdir() sits behind the /var symlink and the raw spelling
    // never matches the resolved one.
    assert(
      probed.ok &&
        (probed.result as { uri: string }).uri ===
          `file://${await realpath(audio)}`,
      'probe resolves a file:// URI',
    );

    // Downloads win over local rows — stored bytes are the owner.
    await writeFile(join(mediaDir, 'dl-1'), Buffer.alloc(64, 2));
    insertRecording('rec-2');
    db.prepare(
      `INSERT INTO downloads
       (download_id, recording_id, provider, source_ref_json, file_path,
        bytes, state, committed_offset, priority, requested_ms)
       VALUES ('d-1', 'rec-2', 'p', '{}', 'dl-1', 64, 'available', 64, 0, 0)`,
    ).run();
    const probedDl = await call(CHANNELS.localProbe, {
      recordingId: 'rec-2',
    });
    assert(probedDl.ok, 'download probe resolves');
    assertEqual(
      (probedDl.result as { uri: string }).uri,
      `file://${mediaDir}/dl-1`,
      'available downloads probe to the media dir',
    );

    // A download row that claims bytes but has none falls through.
    insertRecording('rec-3');
    db.prepare(
      `INSERT INTO downloads
       (download_id, recording_id, provider, source_ref_json, file_path,
        bytes, state, committed_offset, priority, requested_ms)
       VALUES ('d-2', 'rec-3', 'p', '{}', 'gone', 64, 'available', 64, 0, 0)`,
    ).run();
    const probedMissing = await call(CHANNELS.localProbe, {
      recordingId: 'rec-3',
    });
    assert(probedMissing.ok, 'missing download probe resolves');
    assertEqual(
      (probedMissing.result as { uri: string | null }).uri,
      null,
      'a vanished download probes null',
    );

    // A download row carrying a separator can never resolve outside
    // the media dir — a non-bare file_path yields no playable bytes.
    insertRecording('rec-4');
    db.prepare(
      `INSERT INTO downloads
       (download_id, recording_id, provider, source_ref_json, file_path,
        bytes, state, committed_offset, priority, requested_ms)
       VALUES ('d-3', 'rec-4', 'p', '{}', '../escape', 64, 'available', 64, 0, 0)`,
    ).run();
    const probedEscape = await call(CHANNELS.localProbe, {
      recordingId: 'rec-4',
    });
    assert(
      probedEscape.ok &&
        (probedEscape.result as { uri: string | null }).uri === null,
      'a non-bare file_path never escapes the media dir',
    );

    // playback returns every playable recording; sweep counts vanished
    // index rows.
    const playback = await call(CHANNELS.localPlayback);
    assert(playback.ok, 'playback resolves');
    const entries = (playback.result as {
      entries: { recordingId: string; uri: string }[];
    }).entries;
    assert(
      entries.some((e) => e.recordingId === 'rec-1') &&
        entries.some((e) => e.recordingId === 'rec-2') &&
        !entries.some((e) => e.recordingId === 'rec-3'),
      'playback serves only files that exist',
    );

    // local:list reflects the committed source rows.
    const listed = await call(CHANNELS.localList);
    assert(listed.ok, 'list resolves');
    const sources = (listed.result as {
      sources: { sourceId: string; fileCount: number }[];
    }).sources;
    assertEqual(sources[0]?.sourceId, 'src-1', 'list returns sources');
    assertEqual(sources[0]?.fileCount, 1, 'file counts joined');

    // Vanished file → sweep reports it against its source.
    await rm(join(folder, 'demo.wav'), { force: true });
    const swept = await call(CHANNELS.localSweep);
    assert(swept.ok, 'sweep resolves');
    const sweepResult = swept.result as {
      missing: number;
      sources: { sourceId: string; missing: number }[];
    };
    assertEqual(sweepResult.missing, 1, 'sweep counts the vanished row');
    assertEqual(
      sweepResult.sources[0]?.sourceId,
      'src-1',
      'sweep groups by source',
    );

    // Unreadable is not vanished: a permission-denied row is skipped,
    // never counted missing — 'missing' prunes index rows, and a
    // permission fault must not cost the row. POSIX-only: EACCES
    // needs DAC bits.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await writeFile(audio, Buffer.alloc(16, 3));
      await chmod(audio, 0o000);
      const deniedSweep = await call(CHANNELS.localSweep);
      assert(deniedSweep.ok, 'sweep resolves over denied rows');
      assertEqual(
        (deniedSweep.result as { missing: number }).missing,
        0,
        'permission-denied rows are not missing',
      );
      await chmod(audio, 0o644);
      await rm(audio, { force: true });
    }

    // Picked files validate as audio-only, single-doc trees.
    const filePick = await call(CHANNELS.localAdd, { paths: [audio] });
    assert(
      !filePick.ok && filePick.error?.kind === 'invalid-request',
      'a deleted path is not pickable',
    );
    await writeFile(audio, Buffer.alloc(16, 9));
    const pickedFile = await call(CHANNELS.localAdd, { paths: [audio] });
    assert(pickedFile.ok, 'picked file resolves');
    const fileDesc = (pickedFile.result as {
      picks: { treeUri: string; kind: string }[];
    }).picks[0];
    assertEqual(fileDesc?.kind, 'file', 'file pick kind');
    assert(
      fileDesc?.treeUri.startsWith('picked-file:') === true,
      'picked-file treeUri minted',
    );
    const notAudio = join(root, 'notes.txt');
    await writeFile(notAudio, 'nope');
    const rejected = await call(CHANNELS.localAdd, { paths: [notAudio] });
    assert(
      !rejected.ok && rejected.error?.kind === 'invalid-request',
      'non-audio file refused',
    );
    const relative = await call(CHANNELS.localAdd, {
      paths: ['not/absolute.wav'],
    });
    assert(
      !relative.ok && relative.error?.kind === 'invalid-request',
      'relative path refused',
    );
  } finally {
    local.close();
    tags.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
