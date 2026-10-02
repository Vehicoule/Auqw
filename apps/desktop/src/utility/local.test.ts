import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  chmod,
  mkdir,
  realpath,
  rename,
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
import { dirTreeUri } from '../shared/local-paths.ts';
import type { UtilityResponse } from './envelope.ts';
import { createUtilityRouter } from './router.ts';
import { createLocalGrants } from './local-grants.ts';
import { createLocalService } from './local.ts';
import { createStorageService } from './storage.ts';
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
  // The grant authority is utility-owned — `local:add` mints here,
  // dbW's renderer-role row inserts are UI mirrors only.
  const localGrants = createLocalGrants({
    path: join(userData, 'local-grants.json'),
    database: () => db,
  });
  const local = createLocalService({
    database: () => db,
    mediaDir,
    grants: localGrants,
  });
  const tags = createTagService({ grants: localGrants });
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

    // The verdict belongs to the resolved PATH, not the URI string —
    // a symlink re-point moves the target without touching the index
    // (the freshness stamp stays put), so a cached answer must still
    // match the realpath computed on THIS call. Prime a denial with
    // `swap` still pointing at the unowned `evil`, then re-point it.
    const swapUri = pathToFileURL(swap).href;
    const primed = await call(CHANNELS.localResolve, { uri: swapUri });
    assert(
      primed.ok &&
        (primed.result as { uri: string | null }).uri === null,
      'the pre-swap denial is the one being primed',
    );
    await rm(swap);
    await symlink(granted, swap);
    const repointAllow = await call(CHANNELS.localResolve, {
      uri: swapUri,
    });
    assert(
      repointAllow.ok &&
        (repointAllow.result as { uri: string | null }).uri ===
          pathToFileURL(await realpath(granted)).href,
      'a re-pointed symlink re-evaluates against its new target',
    );
    // …and the allowed direction: a verdict minted while the link
    // named owned bytes dies the moment the link names anything else.
    const turncoat = join(folder, 'turncoat.wav');
    await symlink(granted, turncoat);
    const turnUri = pathToFileURL(turncoat).href;
    const firstLook = await call(CHANNELS.localResolve, { uri: turnUri });
    assert(
      firstLook.ok &&
        (firstLook.result as { uri: string | null }).uri !== null,
      'a link to owned bytes resolves',
    );
    await rm(turncoat);
    await symlink(evil, turncoat);
    const secondLook = await call(CHANNELS.localResolve, {
      uri: turnUri,
    });
    assert(
      secondLook.ok &&
        (secondLook.result as { uri: string | null }).uri === null,
      'a stale allow dies with the target it was minted for',
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
    // A directory or FIFO wearing an indexed name can never serve
    // bytes — the open must refuse typed 'unavailable' (not a raw
    // EISDIR surfacing as 'internal', and never a parked open).
    const dirRow = join(folder, 'dirrow');
    await mkdir(dirRow);
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-5', 'src-1', 'dirrow', 0, 'fp5', 'rec-1')`,
    ).run();
    const dirRead = await call(CHANNELS.localRead, {
      uri: pathToFileURL(dirRow).href,
      position: 0,
      maxLen: 8,
    });
    assert(
      !dirRead.ok && dirRead.error?.kind === 'unavailable',
      'a directory at an owned name reads unavailable',
    );
    if (process.platform !== 'win32') {
      const fifoRow = join(folder, 'pipe');
      execFileSync('mkfifo', [fifoRow]);
      dbW.prepare(
        `INSERT INTO local_files
         (file_id, source_id, doc_id, size, fingerprint, recording_id)
         VALUES ('lf-6', 'src-1', 'pipe', 0, 'fp6', 'rec-1')`,
      ).run();
      const fifoResult = await Promise.race([
        call(CHANNELS.localRead, {
          uri: pathToFileURL(fifoRow).href,
          position: 0,
          maxLen: 8,
        }),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 5000);
          timer.unref();
        }),
      ]);
      assert(
        typeof fifoResult === 'object' &&
          fifoResult !== null &&
          !fifoResult.ok &&
          fifoResult.error?.kind === 'unavailable',
        'a FIFO at an owned name fails typed — never parks the open',
      );
    }
    // A symlink-escape read is denied at the gate — `turncoat` ends
    // pointing at the unowned `evil` from the re-point check above.
    const turnRead = await call(CHANNELS.localRead, {
      uri: turnUri,
      position: 0,
      maxLen: 8,
    });
    assert(
      !turnRead.ok && turnRead.error?.kind === 'permission-denied',
      'a symlink-escape read is permission-denied',
    );

    // Anchor swaps: the grant is bound to the path that was picked,
    // so renaming the granted name aside and wearing a symlink at it
    // can never re-point confinement at the link's target. The swap
    // targets are fresh files the gate has never judged — a cached
    // verdict can't stand in for the check under test.
    const swapTarget = join(root, 'swap-target.wav');
    await writeFile(swapTarget, Buffer.alloc(8, 0xee));

    // A picked FILE grant: rename the file aside, symlink its name at
    // the outside target — resolve and read must stay denied.
    const pickedSwap = join(root, 'picked-swap.wav');
    await writeFile(pickedSwap, Buffer.alloc(16, 4));
    const pickedAdd = await call(CHANNELS.localAdd, {
      paths: [pickedSwap],
    });
    assert(pickedAdd.ok, 'picked file for the anchor swap');
    const pickedTree = (pickedAdd.result as {
      picks: { treeUri: string }[];
    }).picks[0];
    dbW.prepare(
      `INSERT INTO local_sources (source_id, tree_uri, label, added_ms)
       VALUES ('src-swap', ?, 'swap', 1)`,
    ).run(pickedTree?.treeUri ?? '');
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-swap', 'src-swap', 'picked-swap.wav', 16, 'fps',
               'rec-1')`,
    ).run();
    const pickedSwapUri = pathToFileURL(pickedSwap).href;
    const pickedPre = await call(CHANNELS.localResolve, {
      uri: pickedSwapUri,
    });
    assert(
      pickedPre.ok &&
        (pickedPre.result as { uri: string | null }).uri !== null,
      'a picked file resolves before the swap',
    );
    const pickedParked = `${pickedSwap}.parked`;
    await rename(pickedSwap, pickedParked);
    await symlink(swapTarget, pickedSwap);
    const pickedPost = await call(CHANNELS.localResolve, {
      uri: pickedSwapUri,
    });
    assert(
      pickedPost.ok &&
        (pickedPost.result as { uri: string | null }).uri === null,
      'a swapped picked-file anchor refuses resolve',
    );
    const pickedPostRead = await call(CHANNELS.localRead, {
      uri: pickedSwapUri,
      position: 0,
      maxLen: 8,
    });
    assert(
      !pickedPostRead.ok &&
        pickedPostRead.error?.kind === 'permission-denied',
      'a swapped picked-file anchor refuses read',
    );
    await rm(pickedSwap);
    await rename(pickedParked, pickedSwap);

    // A picked DIR grant: rename the root aside, symlink its name at
    // an outside dir holding the same relative names — the indexed
    // row confined under the minted root must not follow.
    const anchorDir = join(root, 'anchored');
    await mkdir(anchorDir);
    await writeFile(join(anchorDir, 'inner.wav'), Buffer.alloc(8, 6));
    const anchorAdd = await call(CHANNELS.localAdd, {
      paths: [anchorDir],
    });
    assert(anchorAdd.ok, 'picked dir for the anchor swap');
    const anchorTree = (anchorAdd.result as {
      picks: { treeUri: string }[];
    }).picks[0];
    dbW.prepare(
      `INSERT INTO local_sources (source_id, tree_uri, label, added_ms)
       VALUES ('src-anchor', ?, 'anchored', 1)`,
    ).run(anchorTree?.treeUri ?? '');
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-anchor', 'src-anchor', 'inner.wav', 8, 'fpa',
               'rec-1')`,
    ).run();
    const anchorUri = pathToFileURL(join(anchorDir, 'inner.wav')).href;
    const anchorPre = await call(CHANNELS.localResolve, {
      uri: anchorUri,
    });
    assert(
      anchorPre.ok &&
        (anchorPre.result as { uri: string | null }).uri !== null,
      'an indexed dir row resolves before the swap',
    );
    const relocated = join(root, 'relocated');
    await mkdir(relocated);
    await writeFile(join(relocated, 'inner.wav'), Buffer.alloc(8, 0xee));
    const anchorParked = `${anchorDir}.parked`;
    await rename(anchorDir, anchorParked);
    await symlink(relocated, anchorDir);
    const anchorPost = await call(CHANNELS.localResolve, {
      uri: anchorUri,
    });
    assert(
      anchorPost.ok &&
        (anchorPost.result as { uri: string | null }).uri === null,
      'a swapped dir anchor refuses resolve',
    );
    const anchorPostRead = await call(CHANNELS.localRead, {
      uri: anchorUri,
      position: 0,
      maxLen: 8,
    });
    assert(
      !anchorPostRead.ok &&
        anchorPostRead.error?.kind === 'permission-denied',
      'a swapped dir anchor refuses read',
    );
    await rm(anchorDir);
    await rename(anchorParked, anchorDir);
    const anchorBack = await call(CHANNELS.localResolve, {
      uri: anchorUri,
    });
    assert(
      anchorBack.ok &&
        (anchorBack.result as { uri: string | null }).uri !== null,
      'a restored dir anchor resolves again',
    );

    // The media dir itself: same swap against the managed-downloads
    // root — a ledger row must not follow the dir's new target.
    const outsideMedia = join(root, 'outside-media');
    await mkdir(outsideMedia);
    await writeFile(join(outsideMedia, 'dl-1'), Buffer.alloc(8, 0xee));
    const mediaParked = `${mediaDir}.parked`;
    await rename(mediaDir, mediaParked);
    await symlink(outsideMedia, mediaDir);
    const mediaPost = await call(CHANNELS.localResolve, { uri: dlUri });
    assert(
      mediaPost.ok &&
        (mediaPost.result as { uri: string | null }).uri === null,
      'a swapped media anchor refuses resolve',
    );
    const mediaPostRead = await call(CHANNELS.localRead, {
      uri: dlUri,
      position: 0,
      maxLen: 8,
    });
    assert(
      !mediaPostRead.ok &&
        mediaPostRead.error?.kind === 'permission-denied',
      'a swapped media anchor refuses read',
    );
    await rm(mediaDir);
    await rename(mediaParked, mediaDir);
    const mediaBack = await call(CHANNELS.localResolve, { uri: dlUri });
    assert(
      mediaBack.ok &&
        (mediaBack.result as { uri: string | null }).uri !== null,
      'a restored media anchor resolves again',
    );

    // — Grant authority: the store is utility-owned, so a renderer
    //   `local_sources` write is a UI mirror, never a mint. A fully
    //   forged source+file pair resolves nothing, reads nothing,
    //   enumerates nothing.
    const forgedDir = join(root, 'forged');
    await mkdir(forgedDir);
    const forgedFile = join(forgedDir, 'secret.wav');
    await writeFile(forgedFile, Buffer.alloc(32, 9));
    const forgedTree = dirTreeUri(forgedDir);
    insertRecording('rec-forged', 'local');
    dbW.prepare(
      `INSERT INTO local_sources (source_id, tree_uri, label, added_ms)
       VALUES ('src-forged', ?, 'forged', 1)`,
    ).run(forgedTree);
    dbW.prepare(
      `INSERT INTO local_files
       (file_id, source_id, doc_id, size, fingerprint, recording_id)
       VALUES ('lf-forged', 'src-forged', 'secret.wav', 32, 'fpf',
               'rec-forged')`,
    ).run();
    const forgedUri = pathToFileURL(await realpath(forgedFile)).href;
    const forgedEnum = await call(CHANNELS.tagreadEnumerate, {
      treeUri: forgedTree,
    });
    assert(
      !forgedEnum.ok && forgedEnum.error?.kind === 'permission-denied',
      'a forged local_sources row grants no enumeration',
    );
    const forgedProbe = await call(CHANNELS.localProbe, {
      recordingId: 'rec-forged',
    });
    assert(
      forgedProbe.ok &&
        (forgedProbe.result as { uri: string | null }).uri === null,
      'a forged local_sources row grants no probe',
    );
    const forgedResolve = await call(CHANNELS.localResolve, {
      uri: forgedUri,
    });
    assert(
      forgedResolve.ok &&
        (forgedResolve.result as { uri: string | null }).uri === null,
      'a forged local_sources row grants no resolve',
    );
    const forgedRead = await call(CHANNELS.localRead, {
      uri: forgedUri,
      position: 0,
      maxLen: 8,
    });
    assert(
      !forgedRead.ok &&
        forgedRead.error?.kind === 'permission-denied',
      'a forged local_sources row grants no read',
    );

    // The storage path itself — the exact channel a compromised
    // renderer would write through — can't mint either: a committed
    // INSERT is a mirror row, and enumerate still denies.
    const storage = createStorageService({
      dbPath,
      localGrants,
    });
    const sRoute = createUtilityRouter(storage.handlers);
    let sSeq = 500;
    const sCall = (
      channel: string,
      args?: unknown,
    ): Promise<UtilityResponse> => {
      const id = sSeq;
      sSeq += 1;
      return sRoute({ id, channel, args });
    };
    const neverDir = join(root, 'never-added');
    await mkdir(neverDir);
    const neverTree = dirTreeUri(neverDir);
    const insTx = await sCall(CHANNELS.storageBegin, undefined);
    assert(insTx.ok, 'insert tx begins');
    const insId = (insTx.result as { txId: string }).txId;
    const insRow = await sCall(CHANNELS.storageExecute, {
      txId: insId,
      sql: `INSERT INTO local_sources
            (source_id, tree_uri, label, added_ms)
            VALUES ('src-never', ?, 'never', 1)`,
      params: [neverTree],
    });
    assert(insRow.ok, 'forged insert executes');
    const insCommit = await sCall(CHANNELS.storageCommit, {
      txId: insId,
    });
    assert(insCommit.ok, 'forged insert commits');
    const neverEnum = await call(CHANNELS.tagreadEnumerate, {
      treeUri: neverTree,
    });
    assert(
      !neverEnum.ok && neverEnum.error?.kind === 'permission-denied',
      'a committed storage insert never mints a grant',
    );

    // Removal rides the same boundary: deleting the source row in a
    // storage tx revokes the grant — a live tree denies again while
    // the mirror row disappears from local:list too.
    const revocableDir = join(root, 'revocable');
    await mkdir(revocableDir);
    await writeFile(join(revocableDir, 'gone.wav'), Buffer.alloc(8, 3));
    const revAdd = await call(CHANNELS.localAdd, {
      paths: [revocableDir],
    });
    assert(revAdd.ok, 'revocable pick adds');
    const revTree = (revAdd.result as { picks: { treeUri: string }[] })
      .picks[0]?.treeUri;
    const preDeleteEnum = await call(CHANNELS.tagreadEnumerate, {
      treeUri: revTree,
    });
    assert(preDeleteEnum.ok, 'the picked tree enumerates live');
    dbW.prepare(
      `INSERT INTO local_sources (source_id, tree_uri, label, added_ms)
       VALUES ('src-rev', ?, 'rev', 1)`,
    ).run(revTree ?? '');
    const delTx = await sCall(CHANNELS.storageBegin, undefined);
    assert(delTx.ok, 'delete tx begins');
    const delId = (delTx.result as { txId: string }).txId;
    await sCall(CHANNELS.storageExecute, {
      txId: delId,
      sql: `DELETE FROM local_sources WHERE source_id = 'src-rev'`,
      params: [],
    });
    const delCommit = await sCall(CHANNELS.storageCommit, {
      txId: delId,
    });
    assert(delCommit.ok, 'source-removal commit lands');
    const postDeleteEnum = await call(CHANNELS.tagreadEnumerate, {
      treeUri: revTree,
    });
    assert(
      !postDeleteEnum.ok &&
        postDeleteEnum.error?.kind === 'permission-denied',
      'a removed source revokes the grant in the authority',
    );
    storage.close();

    // Bootstrap: a store whose file never ran imports the rows that
    // predate it — once. File existence is the sentinel: a row added
    // after the file exists never re-imports on the next boot.
    const bootPath = join(userData, 'boot-grants.json');
    const booted = createLocalGrants({
      path: bootPath,
      database: () => db,
    });
    assert(
      booted.has(neverTree),
      'bootstrap imports pre-existing source rows',
    );
    const lateTree = dirTreeUri(join(root, 'late'));
    dbW.prepare(
      `INSERT INTO local_sources (source_id, tree_uri, label, added_ms)
       VALUES ('src-late', ?, 'late', 1)`,
    ).run(lateTree);
    const rebooted = createLocalGrants({
      path: bootPath,
      database: () => db,
    });
    assert(
      rebooted.has(neverTree),
      'a persisted grant survives restart',
    );
    assert(
      !rebooted.has(lateTree),
      'no re-import once the store file exists',
    );
  } finally {
    local.close();
    tags.close();
    db.close();
    dbW.close();
    rmSync(root, { recursive: true, force: true });
  }
}
