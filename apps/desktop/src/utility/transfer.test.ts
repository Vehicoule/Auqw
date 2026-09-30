import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import { CHANNELS } from '../shared/channels.ts';
import type { UtilityResponse } from './envelope.ts';
import { createUtilityRouter } from './router.ts';
import { createTransferService } from './transfer.ts';

export async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'auqw-transfer-'));
  const mediaDir = join(root, 'media');
  const service = createTransferService({ mediaDir, maxSinks: 2 });
  const route = createUtilityRouter(service.handlers);
  let nextId = 1;
  const call = (
    channel: string,
    args?: unknown,
  ): Promise<UtilityResponse> => {
    const id = nextId;
    nextId += 1;
    return route({ id, channel, args });
  };

  const payload = Buffer.from('hello auqw offline desktop');
  const digest = createHash('sha256').update(payload).digest('hex');

  try {
    // begin → write → commit → finalize (verified digest) → file landed.
    const began = await call(CHANNELS.transferBegin, {
      destPath: 'track.mp4',
      resumeAtBytes: 0,
    });
    assert(began.ok, 'begin resolves');
    const sinkId = (began.result as { sinkId: string }).sinkId;

    const written = await call(CHANNELS.transferWrite, {
      sinkId,
      data: payload.toString('base64'),
    });
    assert(written.ok, 'write resolves');

    const committed = await call(CHANNELS.transferCommit, { sinkId });
    assert(
      committed.ok &&
        (committed.result as { offset: number }).offset ===
          payload.length,
      'commit returns durable offset',
    );

    const finalized = await call(CHANNELS.transferFinalize, {
      sinkId,
      expected: digest,
    });
    assert(
      finalized.ok &&
        (finalized.result as { digest: string }).digest === digest,
      'finalize returns the real digest',
    );
    const landed = await readFile(join(mediaDir, 'track.mp4'));
    assertEqual(landed.toString(), payload.toString(), 'bytes landed');

    // Digest mismatch deletes the partial and fails invalid-response.
    const began2 = await call(CHANNELS.transferBegin, {
      destPath: 'bad.mp4',
      resumeAtBytes: 0,
    });
    assert(began2.ok, 'second begin resolves');
    const sinkId2 = (began2.result as { sinkId: string }).sinkId;
    await call(CHANNELS.transferWrite, {
      sinkId: sinkId2,
      data: payload.toString('base64'),
    });
    const mismatched = await call(CHANNELS.transferFinalize, {
      sinkId: sinkId2,
      expected: '0'.repeat(64),
    });
    assert(
      !mismatched.ok && mismatched.error?.kind === 'invalid-response',
      'digest mismatch fails invalid-response',
    );
    const statBad = await call(CHANNELS.transferStat, { name: 'bad.mp4' });
    assert(
      statBad.ok &&
        (statBad.result as { exists: boolean }).exists === false,
      'mismatched partial is deleted, not finalized',
    );

    // A stat failure is not absence — exists:false would let
    // DownloadManager remove a live file with its ledger row.
    // POSIX-only: EACCES needs DAC bits on the managed dir.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(mediaDir, 0o000);
      try {
        const denied = await call(CHANNELS.transferStat, {
          name: 'track.mp4',
        });
        assert(
          !denied.ok && denied.error?.kind === 'permission-denied',
          'an unreadable dir fails typed, never exists:false',
        );
      } finally {
        await chmod(mediaDir, 0o700);
      }
    }

    // Resume: a .part matching resumeAtBytes appends in place.
    await writeFile(join(mediaDir, 'part.mp4.part'), payload.subarray(0, 8));
    const resumed = await call(CHANNELS.transferBegin, {
      destPath: 'part.mp4',
      resumeAtBytes: 8,
    });
    assert(resumed.ok, 'resume begin resolves');
    const resumeSink = (resumed.result as { sinkId: string }).sinkId;
    await call(CHANNELS.transferWrite, {
      sinkId: resumeSink,
      data: payload.subarray(8).toString('base64'),
    });
    await call(CHANNELS.transferFinalize, {
      sinkId: resumeSink,
      expected: digest,
    });
    const resumedBytes = await readFile(join(mediaDir, 'part.mp4'));
    assertEqual(
      resumedBytes.toString(),
      payload.toString(),
      'resumed transfer lands the whole file',
    );

    // Resume past stored bytes → invalid-response (never splice).
    const overResume = await call(CHANNELS.transferBegin, {
      destPath: 'part.mp4',
      resumeAtBytes: 999_999,
    });
    assert(
      !overResume.ok && overResume.error?.kind === 'invalid-response',
      'resume beyond stored bytes fails',
    );

    // Resume on a longer .part reconciles to the kept prefix.
    await writeFile(join(mediaDir, 'long.mp4.part'), payload);
    const longer = await call(CHANNELS.transferBegin, {
      destPath: 'long.mp4',
      resumeAtBytes: 8,
    });
    assert(longer.ok, 'over-long partial reconciles');
    const longSink = (longer.result as { sinkId: string }).sinkId;
    await call(CHANNELS.transferWrite, {
      sinkId: longSink,
      data: payload.subarray(8).toString('base64'),
    });
    await call(CHANNELS.transferFinalize, {
      sinkId: longSink,
      expected: digest,
    });
    assertEqual(
      (await readFile(join(mediaDir, 'long.mp4'))).toString(),
      payload.toString(),
      'reconciled prefix yields the whole file',
    );

    // A duplicate destPath while a sink is open is refused.
    const dup = await call(CHANNELS.transferBegin, {
      destPath: 'dup.mp4',
      resumeAtBytes: 0,
    });
    assert(dup.ok, 'first dup sink opens');
    const dup2 = await call(CHANNELS.transferBegin, {
      destPath: 'dup.mp4',
      resumeAtBytes: 0,
    });
    assert(
      !dup2.ok && dup2.error?.kind === 'invalid-request',
      'duplicate open sink refused',
    );
    await call(CHANNELS.transferAbort, {
      sinkId: (dup.result as { sinkId: string }).sinkId,
      keep: false,
    });

    // Concurrent begins on one destPath can't split the check across
    // the slot wait — the reservation is made before the first await.
    const race1 = call(CHANNELS.transferBegin, {
      destPath: 'raced.mp4',
      resumeAtBytes: 0,
    });
    const race2 = call(CHANNELS.transferBegin, {
      destPath: 'raced.mp4',
      resumeAtBytes: 0,
    });
    const [raceRes1, raceRes2] = await Promise.all([race1, race2]);
    assert(
      raceRes1.ok !== raceRes2.ok,
      'exactly one raced begin wins the destination',
    );
    const loser = raceRes1.ok ? raceRes2 : raceRes1;
    assert(
      !loser.ok && loser.error?.kind === 'invalid-request',
      'raced loser fails invalid-request',
    );
    const winner = raceRes1.ok ? raceRes1 : raceRes2;
    assert(winner.ok, 'winner sink is usable');
    await call(CHANNELS.transferAbort, {
      sinkId: (winner.result as { sinkId: string }).sinkId,
      keep: false,
    });

    // Escaping names never reach disk.
    const escaped = await call(CHANNELS.transferBegin, {
      destPath: '../escape.bin',
      resumeAtBytes: 0,
    });
    assert(
      !escaped.ok && escaped.error?.kind === 'invalid-request',
      'path escape refused',
    );
    // The internal `.replace` namespace can't be claimed publicly.
    const reserved = await call(CHANNELS.transferBegin, {
      destPath: 'song.replace',
      resumeAtBytes: 0,
    });
    assert(
      !reserved.ok && reserved.error?.kind === 'invalid-request',
      'reserved backup suffix refused',
    );

    // Unknown sink ids are typed, not raw.
    const unknown = await call(CHANNELS.transferCommit, {
      sinkId: '00000000-0000-0000-0000-000000000000',
    });
    assert(
      !unknown.ok && unknown.error?.kind === 'invalid-request',
      'unknown sink typed',
    );

    // Concurrency cap: maxSinks=2 → two opens held, third queues until
    // a slot frees; bounded waiters refuse beyond the cap.
    const held1 = await call(CHANNELS.transferBegin, {
      destPath: 'held1.mp4',
      resumeAtBytes: 0,
    });
    const held2 = await call(CHANNELS.transferBegin, {
      destPath: 'held2.mp4',
      resumeAtBytes: 0,
    });
    assert(held1.ok && held2.ok, 'two sinks held');
    let queued = false;
    const queuedPromise = call(CHANNELS.transferBegin, {
      destPath: 'queued.mp4',
      resumeAtBytes: 0,
    }).then((res) => {
      queued = true;
      return res;
    });
    assertEqual(queued, false, 'third begin waits on the cap');
    await call(CHANNELS.transferAbort, {
      sinkId: (held1.result as { sinkId: string }).sinkId,
      keep: false,
    });
    const freed = await queuedPromise;
    assert(freed.ok, 'queued begin lands after a release');
    await call(CHANNELS.transferAbort, {
      sinkId: (freed.result as { sinkId: string }).sinkId,
      keep: false,
    });
    await call(CHANNELS.transferAbort, {
      sinkId: (held2.result as { sinkId: string }).sinkId,
      keep: false,
    });

    // Sweep honors the keep set and live sinks.
    await writeFile(join(mediaDir, 'stale-a.mp4.part'), payload);
    await writeFile(join(mediaDir, 'stale-b.mp4.part'), payload);
    const swept = await call(CHANNELS.transferSweepPartials, {
      keepPaths: ['stale-a.mp4.part'],
    });
    assert(
      swept.ok &&
        (swept.result as { swept: number }).swept === 1,
      'sweep removes unkept partials only',
    );
    const stats = await call(CHANNELS.transferStats);
    assert(
      stats.ok &&
        (stats.result as { bytes: number }).bytes > 0 &&
        (stats.result as { partials: number }).partials === 1 &&
        (stats.result as { files: number }).files === 3,
      'stats count finals and partials',
    );

    // Remove is idempotent over file + .part.
    const removed = await call(CHANNELS.transferRemove, {
      name: 'track.mp4',
    });
    assert(removed.ok, 'remove resolves');
    const after = await call(CHANNELS.transferStat, { name: 'track.mp4' });
    assert(
      after.ok &&
        (after.result as { exists: boolean }).exists === false,
      'removed file reports gone',
    );

    // Remove refuses a name held by a live sink — unlinking its
    // `.part` mid-write strands the finalize. Abort is the end for
    // in-flight transfers, not remove.
    const liveBegin = await call(CHANNELS.transferBegin, {
      destPath: 'live.mp4',
      resumeAtBytes: 0,
    });
    assert(liveBegin.ok, 'live begin resolves');
    const liveSink = (liveBegin.result as { sinkId: string }).sinkId;
    await call(CHANNELS.transferWrite, {
      sinkId: liveSink,
      data: payload.subarray(0, 4).toString('base64'),
    });
    const removeLive = await call(CHANNELS.transferRemove, {
      name: 'live.mp4',
    });
    assert(
      !removeLive.ok && removeLive.error?.kind === 'unavailable',
      'remove refuses a live destination',
    );
    await call(CHANNELS.transferAbort, { sinkId: liveSink, keep: false });
    const removeAfter = await call(CHANNELS.transferRemove, {
      name: 'live.mp4',
    });
    assert(removeAfter.ok, 'remove resolves once the sink is gone');

    // A begin racing a removal refuses — it can't write a `.part`
    // the in-flight unlink would delete out from under it.
    const racing = call(CHANNELS.transferRemove, { name: 'race.mp4' });
    const deniedBegin = await call(CHANNELS.transferBegin, {
      destPath: 'race.mp4',
      resumeAtBytes: 0,
    });
    assert(
      !deniedBegin.ok && deniedBegin.error?.kind === 'unavailable',
      'begin refuses a name mid-removal',
    );
    await racing;
    const postRace = await call(CHANNELS.transferBegin, {
      destPath: 'race.mp4',
      resumeAtBytes: 0,
    });
    assert(postRace.ok, 'begin resolves once the removal lands');
    const postRaceSink = (postRace.result as { sinkId: string }).sinkId;
    await call(CHANNELS.transferAbort, {
      sinkId: postRaceSink,
      keep: false,
    });

    // A second removal of the same name refuses while the first is
    // still in flight — the shared claim must not clear early and
    // reopen the name to begin mid-delete.
    const dupeFirst = call(CHANNELS.transferRemove, { name: 'dupe.mp4' });
    const dupeSecond = await call(CHANNELS.transferRemove, {
      name: 'dupe.mp4',
    });
    assert(
      !dupeSecond.ok && dupeSecond.error?.kind === 'unavailable',
      'overlapping removal refuses',
    );
    await dupeFirst;

    // keep: true retains the partial for a later resume.
    const keepable = await call(CHANNELS.transferBegin, {
      destPath: 'keep.mp4',
      resumeAtBytes: 0,
    });
    assert(keepable.ok, 'keepable begin resolves');
    const keepSink = (keepable.result as { sinkId: string }).sinkId;
    await call(CHANNELS.transferWrite, {
      sinkId: keepSink,
      data: payload.subarray(0, 8).toString('base64'),
    });
    await call(CHANNELS.transferAbort, { sinkId: keepSink, keep: true });
    const list = await call(CHANNELS.transferList);
    assert(list.ok, 'list resolves');
    const sinks = (list.result as { sinks: { sinkId: string }[] }).sinks;
    assertEqual(sinks.length, 0, 'no live sinks after abort');
    const kept = await readFile(join(mediaDir, 'keep.mp4.part')).catch(
      () => null,
    );
    assert(
      kept !== null && kept.length === 8,
      'kept partial survives abort',
    );

    // A terminal op queues behind the one in flight on the same
    // sink — finalize publishes, then the queued abort lands on the
    // closed sink and fails typed instead of racing mid-publish.
    const chainedBegin = await call(CHANNELS.transferBegin, {
      destPath: 'chained.mp4',
      resumeAtBytes: 0,
    });
    assert(chainedBegin.ok, 'chained begin resolves');
    const chainSink = (chainedBegin.result as { sinkId: string }).sinkId;
    await call(CHANNELS.transferWrite, {
      sinkId: chainSink,
      data: payload.toString('base64'),
    });
    const finInFlight = call(CHANNELS.transferFinalize, {
      sinkId: chainSink,
      expected: digest,
    });
    const abortQueued = call(CHANNELS.transferAbort, {
      sinkId: chainSink,
      keep: false,
    });
    const [finRes, abortRes] = await Promise.all([
      finInFlight,
      abortQueued,
    ]);
    assert(finRes.ok, 'in-flight finalize completes at the boundary');
    assert(
      !abortRes.ok && abortRes.error?.kind === 'invalid-request',
      'abort queued behind the close fails typed',
    );
    assertEqual(
      (await readFile(join(mediaDir, 'chained.mp4'))).toString(),
      payload.toString(),
      'finalize-before-abort publishes the file',
    );
    const lateWrite = await call(CHANNELS.transferWrite, {
      sinkId: chainSink,
      data: payload.toString('base64'),
    });
    assert(
      !lateWrite.ok && lateWrite.error?.kind === 'invalid-request',
      'post-close write fails typed',
    );

    // A decoded 4MiB frame encodes to exactly 5,592,408 base64 chars —
    // the cap must admit the maximum frame the chunker can emit.
    const maxFrame = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const frameBegin = await call(CHANNELS.transferBegin, {
      destPath: 'frame.mp4',
      resumeAtBytes: 0,
    });
    assert(frameBegin.ok, 'frame begin resolves');
    const frameSink = (frameBegin.result as { sinkId: string }).sinkId;
    const maxWrite = await call(CHANNELS.transferWrite, {
      sinkId: frameSink,
      data: maxFrame.toString('base64'),
    });
    assert(maxWrite.ok, 'max-size frame passes the write cap');
    await call(CHANNELS.transferAbort, {
      sinkId: frameSink,
      keep: false,
    });

    service.close();
    const afterClose = await call(CHANNELS.transferBegin, {
      destPath: 'late.mp4',
      resumeAtBytes: 0,
    });
    assert(
      !afterClose.ok && afterClose.error?.kind === 'released',
      'closed service rejects released',
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }

  // The startup orphan sweep aborts when the ledger can't be read —
  // an unreadable index must never destroy resumable progress.
  const root2 = mkdtempSync(join(tmpdir(), 'auqw-sweep-'));
  const media2 = join(root2, 'media');
  try {
    await mkdir(media2, { recursive: true });
    await writeFile(join(media2, 'old.mp4.part'), 'stale');
    const staleDate = new Date(Date.now() - 120_000);
    await utimes(join(media2, 'old.mp4.part'), staleDate, staleDate);
    const deadDb = createTransferService({
      mediaDir: media2,
      database: () => {
        throw new Error('db is locked');
      },
    });
    const sweptDead = await deadDb.sweepOrphans();
    assertEqual(sweptDead, 0, 'unreadable ledger aborts the sweep');
    const survived = await readFile(join(media2, 'old.mp4.part'));
    assertEqual(
      survived.toString(),
      'stale',
      'a resumable partial survives a dead index',
    );
    deadDb.close();

    // A healthy ledger with a resumable row keeps its .part; a stale
    // unclaimed one is reaped.
    const db = new DatabaseSync(join(root2, 'auqw.db'));
    db.exec(
      'CREATE TABLE downloads (file_path TEXT, state TEXT)',
    );
    db.prepare(
      "INSERT INTO downloads VALUES ('keep.mp4', 'transferring')",
    ).run();
    await writeFile(join(media2, 'keep.mp4.part'), 'keep');
    const stale2 = new Date(Date.now() - 120_000);
    await utimes(join(media2, 'keep.mp4.part'), stale2, stale2);
    await utimes(join(media2, 'old.mp4.part'), stale2, stale2);
    const sweeping = createTransferService({
      mediaDir: media2,
      database: () => db,
    });
    // `.replace` recovery: a backup with no live destination is the
    // parked incumbent of a crashed publish — restore it. One beside
    // a live destination is the stale half of a landed publish —
    // delete it.
    await writeFile(join(media2, 'crashed.mp4.replace'), 'old bytes');
    await writeFile(join(media2, 'stale.mp4'), 'new bytes');
    await writeFile(join(media2, 'stale.mp4.replace'), 'old bytes');
    const swept = await sweeping.sweepOrphans();
    assertEqual(swept, 1, 'only the unclaimed stale partial reaped');
    const keptRow = await readFile(
      join(media2, 'keep.mp4.part'),
    ).catch(() => null);
    assert(keptRow !== null, 'resumable ledger row kept its partial');
    const restored = await readFile(join(media2, 'crashed.mp4'));
    assertEqual(
      restored.toString(),
      'old bytes',
      'parked incumbent restored after a crashed publish',
    );
    const restoredBackup = await readFile(
      join(media2, 'crashed.mp4.replace'),
    ).catch(() => null);
    assert(restoredBackup === null, 'restored backup is gone');
    const staleBackup = await readFile(
      join(media2, 'stale.mp4.replace'),
    ).catch(() => null);
    assert(staleBackup === null, 'stale backup reaped');
    const landedDest = await readFile(join(media2, 'stale.mp4'));
    assertEqual(landedDest.toString(), 'new bytes', 'live dest kept');
    sweeping.close();
    db.close();
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }

  /* --------------------------------------------------------------
   * transfer:fetch* — the download wire leg over Node fetch. The
   * renderer's CSP forbids https, so range fetches live here; these
   * prove minted headers ride verbatim, redirects stay on https, and
   * failures surface typed kinds the policy can retry.
   * ------------------------------------------------------------ */
  const fetchRoot = mkdtempSync(join(tmpdir(), 'auqw-tfetch-'));
  try {
    const seen: { url: string; headers: HeadersInit | undefined }[] = [];
    const scripted = new Map<string, Response>();
    const fakeFetch = ((
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      seen.push({ url, headers: init?.headers });
      const response = scripted.get(url);
      if (response === undefined) {
        // Node's own transport failure is a TypeError.
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(response);
    }) as typeof fetch;
    const svc = createTransferService({
      mediaDir: join(fetchRoot, 'media'),
      fetchImpl: fakeFetch,
    });
    const fetchRoute = createUtilityRouter(svc.handlers);
    let fetchSeq = 1;
    const fetchCall = (
      channel: string,
      args?: unknown,
    ): Promise<UtilityResponse> => {
      const id = fetchSeq;
      fetchSeq += 1;
      return fetchRoute({ id, channel, args });
    };
    const argsFor = (requestId: string, url: string) => ({
      requestId,
      url,
      headers: { 'user-agent': 'auqw-test/1.0', Range: 'bytes=0-3' },
    });

    // Head + body round-trip; minted headers ride verbatim.
    scripted.set(
      'https://cdn.example/ok',
      new Response('hello', {
        status: 206,
        headers: { 'content-range': 'bytes 0-4/9' },
      }),
    );
    const head = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-1', 'https://cdn.example/ok'),
    );
    assert(head.ok, 'fetch head ok');
    const headResult = head.result as {
      status: number;
      headers: [string, string][];
    };
    assertEqual(headResult.status, 206, 'status surfaced');
    assert(
      headResult.headers.some(
        ([name, value]) =>
          name === 'content-range' && value === 'bytes 0-4/9',
      ),
      'response headers surfaced',
    );
    const body = await fetchCall(CHANNELS.transferFetchBody, {
      requestId: 'f-1',
    });
    assert(body.ok, 'fetch body ok');
    assertEqual(
      (body.result as { data: string }).data,
      Buffer.from('hello').toString('base64'),
      'body base64 round-trips',
    );
    const sentHeaders = new Headers(seen[0]?.headers);
    assertEqual(
      sentHeaders.get('user-agent'),
      'auqw-test/1.0',
      'minted UA sent verbatim',
    );
    assertEqual(sentHeaders.get('range'), 'bytes=0-3', 'range sent');
    const again = await fetchCall(CHANNELS.transferFetchBody, {
      requestId: 'f-1',
    });
    assert(
      !again.ok && again.error.kind === 'invalid-request',
      'body is single-use',
    );

    // https→https redirect followed with the same headers; off-https
    // refused.
    scripted.set(
      'https://cdn.example/hop',
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn2.example/land' },
      }),
    );
    scripted.set(
      'https://cdn2.example/land',
      new Response('x', { status: 206 }),
    );
    const hopped = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-2', 'https://cdn.example/hop'),
    );
    assert(
      hopped.ok && (hopped.result as { status: number }).status === 206,
      'https redirect followed',
    );
    const hopHeaders = new Headers(seen[seen.length - 1]?.headers);
    assertEqual(
      hopHeaders.get('user-agent'),
      'auqw-test/1.0',
      'headers ride the redirect hop',
    );
    scripted.set(
      'https://cdn.example/plain',
      new Response(null, {
        status: 302,
        headers: { location: 'http://cdn.example/off' },
      }),
    );
    const plain = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-3', 'https://cdn.example/plain'),
    );
    assert(
      !plain.ok && plain.error.kind === 'invalid-response',
      'cleartext redirect refused',
    );

    // Non-https urls refuse before any fetch is issued.
    const http = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-4', 'http://cdn.example/x'),
    );
    assert(
      !http.ok && http.error.kind === 'invalid-request',
      'http url refused',
    );
    assert(
      seen.every((entry) => entry.url.startsWith('https://')),
      'no cleartext fetch issued',
    );

    // Transport failure → transient (retryable), never 'cancelled'.
    const failed = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-5', 'https://cdn.example/missing'),
    );
    assert(
      !failed.ok && failed.error.kind === 'transient',
      'transport failure is retryable',
    );

    // Aborting a parked response frees the requestId; unknown ids are
    // a no-op; a duplicate requestId refuses.
    scripted.set(
      'https://cdn.example/ok2',
      new Response('b', { status: 206 }),
    );
    const parked = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-6', 'https://cdn.example/ok2'),
    );
    assert(parked.ok);
    const aborted = await fetchCall(CHANNELS.transferFetchAbort, {
      requestId: 'f-6',
    });
    assert(aborted.ok, 'abort of live fetch ok');
    const bodyAfterAbort = await fetchCall(CHANNELS.transferFetchBody, {
      requestId: 'f-6',
    });
    assert(
      !bodyAfterAbort.ok && bodyAfterAbort.error.kind === 'invalid-request',
      'aborted response denies body',
    );
    const noop = await fetchCall(CHANNELS.transferFetchAbort, {
      requestId: 'never-issued',
    });
    assert(noop.ok, 'abort of unknown id is a no-op');
    const dup = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-6', 'https://cdn.example/ok2'),
    );
    assert(dup.ok, 'requestId reusable after abort');
    const dup2 = await fetchCall(
      CHANNELS.transferFetch,
      argsFor('f-6', 'https://cdn.example/ok2'),
    );
    assert(
      !dup2.ok && dup2.error.kind === 'invalid-request',
      'duplicate live requestId refused',
    );
    await fetchCall(CHANNELS.transferFetchAbort, { requestId: 'f-6' });
    svc.close();
  } finally {
    rmSync(fetchRoot, { recursive: true, force: true });
  }
}
