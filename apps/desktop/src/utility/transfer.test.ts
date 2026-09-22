import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
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

    // Escaping names never reach disk.
    const escaped = await call(CHANNELS.transferBegin, {
      destPath: '../escape.bin',
      resumeAtBytes: 0,
    });
    assert(
      !escaped.ok && escaped.error?.kind === 'invalid-request',
      'path escape refused',
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
}
