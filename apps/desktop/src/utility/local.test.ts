import { mkdtempSync, rmSync } from 'node:fs';
import {
  chmod,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
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
  // Two connections mirror production: the services read through
  // `db` (the indexDb accessor role) while every table write goes
  // through `dbW` (the SqliteStorage role) — cross-connection commits
  // are what PRAGMA data_version reports, so the gate's freshness
  // stamp only behaves correctly under the two-handle shape.
  const db = new DatabaseSync(dbPath);
  const dbW = new DatabaseSync(dbPath);
  dbW.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    for (const sql of migration) {
      dbW.exec(sql);
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
    dbW.prepare(
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
    dbW.prepare(
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
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-1', 'src-1', 'demo.wav', 2048, 'fp', 'rec-1')`,
    ).run();

    const probed = await call(CHANNELS.localProbe, {
      recordingId: 'rec-1',
    });
    // The service resolves the file through realpath before minting the
    // URI (its symlink-confinement check) and mints with pathToFileURL
    // (percent-encoding, Windows-aware), so the expectation does the
    // same — on macOS tmpdir() sits behind the /var symlink and a raw
    // path string never matches the minted URI.
    assert(
      probed.ok &&
        (probed.result as { uri: string }).uri ===
          pathToFileURL(await realpath(audio)).href,
      'probe resolves a file:// URI',
    );

    // Downloads win over local rows — stored bytes are the owner.
    await writeFile(join(mediaDir, 'dl-1'), Buffer.alloc(64, 2));
    insertRecording('rec-2');
    dbW.prepare(
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
      pathToFileURL(join(mediaDir, 'dl-1')).href,
      'available downloads probe to the media dir',
    );

    // A download row that claims bytes but has none falls through.
    insertRecording('rec-3');
    dbW.prepare(
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
    dbW.prepare(
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

    // `local:resolve` — an indexed file's file:// URI comes back
    // realpath'd; escapes, unindexed files, ungranted paths, and
    // non-file URIs refuse. The gate needs a `local_files` row — the
    // picked dir is granted, but only indexed bytes are readable.
    const granted = join(folder, 'again.wav');
    await writeFile(granted, Buffer.alloc(32, 7));
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-2', 'src-1', 'again.wav', 32, 'fp2', 'rec-1')`,
    ).run();
    const grantedUri = pathToFileURL(granted).href;
    const resolved = await call(CHANNELS.localResolve, {
      uri: grantedUri,
    });
    assert(
      resolved.ok &&
        (resolved.result as { uri: string | null }).uri ===
          pathToFileURL(await realpath(granted)).href,
      'resolve returns the realpath URI for an indexed file',
    );
    const unindexed = join(folder, 'unindexed.wav');
    await writeFile(unindexed, Buffer.alloc(8, 3));
    const skipped = await call(CHANNELS.localResolve, {
      uri: pathToFileURL(unindexed).href,
    });
    assert(
      skipped.ok &&
        (skipped.result as { uri: string | null }).uri === null,
      'an unindexed file inside the granted folder refuses',
    );
    const outside = await call(CHANNELS.localResolve, {
      uri: pathToFileURL(join(root, 'notes.txt')).href,
    });
    assert(
      outside.ok &&
        (outside.result as { uri: string | null }).uri === null,
      'a path outside every root refuses',
    );
    const evil = join(root, 'evil.wav');
    await writeFile(evil, Buffer.alloc(8, 0));
    const swap = join(folder, 'swap.wav');
    await symlink(evil, swap);
    // Index the swap name so the refusal must come from the realpath
    // gate — not merely from the file missing the index.
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-3', 'src-1', 'swap.wav', 8, 'fp3', 'rec-1')`,
    ).run();
    const escaped = await call(CHANNELS.localResolve, {
      uri: pathToFileURL(swap).href,
    });
    assert(
      escaped.ok &&
        (escaped.result as { uri: string | null }).uri === null,
      'a symlink escape refuses at attach time',
    );
    // The media dir counts as a root for managed-download URIs.
    const dlUri = pathToFileURL(join(mediaDir, 'dl-1')).href;
    const resolvedDl = await call(CHANNELS.localResolve, {
      uri: dlUri,
    });
    assert(
      resolvedDl.ok &&
        (resolvedDl.result as { uri: string | null }).uri !== null,
      'a media-dir URI resolves',
    );
    // …but only for ledger-owned bytes — an unmanaged file beside the
    // downloads stays denied.
    const unmanaged = join(mediaDir, 'not-a-download.wav');
    await writeFile(unmanaged, Buffer.alloc(8, 9));
    const unmanagedResolve = await call(CHANNELS.localResolve, {
      uri: pathToFileURL(unmanaged).href,
    });
    assert(
      unmanagedResolve.ok &&
        (unmanagedResolve.result as { uri: string | null }).uri === null,
      'an unmanaged file inside the media dir refuses',
    );
    const unmanagedRead = await call(CHANNELS.localRead, {
      uri: pathToFileURL(unmanaged).href,
      position: 0,
      maxLen: 8,
    });
    assert(
      !unmanagedRead.ok &&
        unmanagedRead.error?.kind === 'permission-denied',
      'an unmanaged media-dir read is permission-denied',
    );
    // UPDATEs move the freshness stamp too — a download leaving
    // 'available' revokes its cached allow on the next call.
    dbW.prepare(`UPDATE downloads SET state = 'removing'
                WHERE download_id = 'd-1'`).run();
    const revokedResolve = await call(CHANNELS.localResolve, {
      uri: dlUri,
    });
    assert(
      revokedResolve.ok &&
        (revokedResolve.result as { uri: string | null }).uri === null,
      'a download leaving available loses its verdict',
    );
    dbW.prepare(`UPDATE downloads SET state = 'available'
                WHERE download_id = 'd-1'`).run();
    const restoredResolve = await call(CHANNELS.localResolve, {
      uri: dlUri,
    });
    assert(
      restoredResolve.ok &&
        (restoredResolve.result as { uri: string | null }).uri !== null,
      'restoring available re-arms the verdict',
    );

    // `local:read` — ranged bytes over the same grant gate.
    const read = await call(CHANNELS.localRead, {
      uri: grantedUri,
      position: 0,
      maxLen: 16,
    });
    assert(
      read.ok &&
        (read.result as { data: string }).data ===
          Buffer.alloc(16, 7).toString('base64'),
      'read serves granted bytes',
    );
    const tail = await call(CHANNELS.localRead, {
      uri: grantedUri,
      position: 30,
      maxLen: 16,
    });
    assert(
      tail.ok &&
        (tail.result as { data: string }).data ===
          Buffer.alloc(2, 7).toString('base64'),
      'read clips at EOF',
    );
    const eof = await call(CHANNELS.localRead, {
      uri: grantedUri,
      position: 32,
      maxLen: 16,
    });
    assert(
      eof.ok && (eof.result as { data: string }).data === '',
      'read past EOF returns empty',
    );
    const denied = await call(CHANNELS.localRead, {
      uri: pathToFileURL(evil).href,
      position: 0,
      maxLen: 8,
    });
    assert(
      !denied.ok && denied.error?.kind === 'permission-denied',
      'an ungranted read is permission-denied',
    );
    const unindexedRead = await call(CHANNELS.localRead, {
      uri: pathToFileURL(unindexed).href,
      position: 0,
      maxLen: 8,
    });
    assert(
      !unindexedRead.ok &&
        unindexedRead.error?.kind === 'permission-denied',
      'an unindexed file under the root is permission-denied',
    );
    // A file deleted between resolve and open reads as a typed
    // 'unavailable' — never a malformed null result.
    const gone = join(folder, 'gone.wav');
    await writeFile(gone, Buffer.alloc(8, 5));
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-4', 'src-1', 'gone.wav', 8, 'fp4', 'rec-1')`,
    ).run();
    const goneUri = pathToFileURL(gone).href;
    const goneResolve = await call(CHANNELS.localResolve, {
      uri: goneUri,
    });
    assert(goneResolve.ok, 'gone file resolves while present');
    rmSync(gone);
    const goneRead = await call(CHANNELS.localRead, {
      uri: goneUri,
      position: 0,
      maxLen: 8,
    });
    assert(
      !goneRead.ok && goneRead.error?.kind !== 'invalid-response',
      'a vanished file reads a typed failure',
    );
  } finally {
    local.close();
    tags.close();
    db.close();
    dbW.close();
    rmSync(root, { recursive: true, force: true });
  }
}
