import type { CancellationSignal } from '@auqw/application';
import { CancellationSource } from '@auqw/application';
import {
  assert,
  assertEqual,
} from '@auqw/application/testing';
import type { AuqwApi } from '../shared/contract.ts';
import { shellError } from '../shared/errors.ts';
import { createDesktopTransfer } from './transfer-port.ts';

const signal: CancellationSignal = {
  cancelled: false,
  subscribe: () => () => undefined,
};

function fakeApi(overrides: Partial<Record<string, unknown>> = {}): AuqwApi {
  const writes: string[] = [];
  return {
    transfer: {
      ensureDir: () => Promise.resolve(undefined),
      begin:
        (overrides['begin'] as AuqwApi['transfer']['begin']) ??
        (() => Promise.resolve({ sinkId: crypto.randomUUID() })),
      write: (args: { sinkId: string; data: string }) => {
        writes.push(args.data);
        return Promise.resolve(undefined);
      },
      commit: () => Promise.resolve({ offset: 0 }),
      finalize: () =>
        Promise.resolve({ digest: 'a'.repeat(64) }),
      abort: () => Promise.resolve(undefined),
      stat: () => Promise.resolve({ exists: true, bytes: 10 }),
      remove: () => Promise.resolve(undefined),
      sweepPartials: () => Promise.resolve({ swept: 2 }),
      list: () => Promise.resolve({ sinks: [], files: [] }),
      status: (args: { sinkId: string }) =>
        Promise.resolve({
          sinkId: args.sinkId,
          destPath: 'x',
          committedBytes: 0,
          openedMs: 1,
        }),
      stats: () =>
        Promise.resolve({
          bytes: 42,
          files: 1,
          partials: 0,
          freeBytes: 1024,
        }),
    },
    __writes: writes,
  } as unknown as AuqwApi;
}

export async function run(): Promise<void> {
  const api = fakeApi();
  const port = createDesktopTransfer(api);

  // A full transfer round-trips base64 bytes through the sink seam.
  const began = await port.begin(
    { destPath: 'a.mp4', resumeAtBytes: 0 },
    signal,
  );
  assert(began.ok, 'begin resolves');
  const sink = began.value;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const wrote = await sink.write(bytes);
  assert(wrote.ok, 'write resolves');
  assertEqual(
    (api as unknown as { __writes: string[] }).__writes[0],
    'AQIDBA==',
    'bytes ride base64',
  );
  const committed = await sink.commit();
  assert(committed.ok && committed.value === 0, 'commit offset');
  const done = await sink.finalize(null);
  assert(done.ok && done.value === 'a'.repeat(64), 'digest returned');
  const postClose = await sink.write(bytes);
  assert(
    !postClose.ok && postClose.error.kind === 'released',
    'writes after finalize refuse',
  );

  // stat/sweep/usage/freeBytes surface the cache ops.
  const stat = await port.stat('a.mp4', signal);
  assert(stat.ok && stat.value.exists && stat.value.bytes === 10, 'stat');
  const swept = await port.sweepPartials(['x.part'], signal);
  assert(swept.ok && swept.value === 2, 'sweep count crosses');
  const usage = await port.usage(signal);
  assert(usage.ok && usage.value === 42, 'usage reads stats.bytes');
  const free = await port.freeBytes(signal);
  assert(free.ok && free.value === 1024, 'freeBytes reads statfs');

  // A typed failure maps to the app kind the engine branches on.
  const deniedApi = fakeApi({
    begin: () =>
      Promise.reject(shellError('storage-full', 'disk full')),
  });
  const deniedPort = createDesktopTransfer(deniedApi);
  const denied = await deniedPort.begin(
    { destPath: 'a', resumeAtBytes: 0 },
    signal,
  );
  assert(
    !denied.ok && denied.error.kind === 'storage-full',
    'ENOSPC stays storage-full across the seam',
  );

  // A cancelled signal never reaches IPC.
  const dead: CancellationSignal = {
    cancelled: true,
    subscribe: () => () => undefined,
  };
  const aborted = await port.begin({ destPath: 'x', resumeAtBytes: 0 }, dead);
  assert(
    !aborted.ok && aborted.error.kind === 'cancelled',
    'cancelled begin short-circuits',
  );

  // A cancel landing mid-write settles typed `cancelled` — not the
  // dead-sink shell error the utility-side abort races against — and
  // the remaining chunks never issue.
  const src = new CancellationSource();
  const midApi = fakeApi();
  const origWrite = midApi.transfer.write.bind(midApi.transfer);
  let midWrites = 0;
  (midApi.transfer as Record<string, unknown>)['write'] = (args: {
    sinkId: string;
    data: string;
  }) => {
    midWrites += 1;
    const sent = origWrite(args);
    src.cancel(); // the signal fires while the sink is live
    return sent;
  };
  const midPort = createDesktopTransfer(midApi);
  const midBegan = await midPort.begin(
    { destPath: 'b.mp4', resumeAtBytes: 0 },
    src.signal,
  );
  assert(midBegan.ok, 'mid begin resolves');
  // > 4MiB so the write splits into two frames — the cancel lands
  // between them.
  const midWrite = await midBegan.value.write(
    new Uint8Array(4 * 1024 * 1024 + 1),
  );
  assert(
    !midWrite.ok && midWrite.error.kind === 'cancelled',
    'mid-write cancel settles cancelled, not the dead-sink error',
  );
  assertEqual(midWrites, 1, 'remaining chunks never issue');

  // A cancel while begin is parked behind the utility settles
  // immediately — and the sink minted when the late IPC lands is
  // reaped (keep:false) instead of leaking a live write handle.
  const parkedSrc = new CancellationSource();
  const release: ((v: { sinkId: string }) => void)[] = [];
  const aborts: { sinkId: string; keep: boolean }[] = [];
  const parkedApi = fakeApi({
    begin: () =>
      new Promise<{ sinkId: string }>((resolve) => {
        release.push(resolve);
      }),
  });
  (parkedApi.transfer as Record<string, unknown>)['abort'] = (args: {
    sinkId: string;
    keep: boolean;
  }) => {
    aborts.push(args);
    return Promise.resolve(undefined);
  };
  const parkedPort = createDesktopTransfer(parkedApi);
  const pendingBegin = parkedPort.begin(
    { destPath: 'c.mp4', resumeAtBytes: 0 },
    parkedSrc.signal,
  );
  parkedSrc.cancel();
  const settled = await pendingBegin;
  assert(
    !settled.ok && settled.error.kind === 'cancelled',
    'cancel settles while begin is still parked',
  );
  const releaseBegin = release[0];
  assert(releaseBegin !== undefined, 'begin parked inside the fake');
  releaseBegin({ sinkId: 'sink-late' });
  for (let i = 0; i < 50 && aborts.length === 0; i += 1) {
    await Promise.resolve();
  }
  assertEqual(aborts.length, 1, 'late-minted sink reaped');
  assert(
    aborts[0] !== undefined && aborts[0].keep === false,
    'reaped sink dropped, not kept',
  );

  // A cancelled op settles only AFTER the shared teardown lands —
  // DownloadManager removes the file on 'cancelled'; reporting it
  // while the utility still holds the handle races the removal on
  // Windows and strands the row in `removing`.
  const holdSrc = new CancellationSource();
  const holdApi = fakeApi();
  const writeReleases: (() => void)[] = [];
  let abortDone = false;
  const abortReleases: (() => void)[] = [];
  (holdApi.transfer as Record<string, unknown>)['write'] = () =>
    new Promise<void>((resolve) => {
      writeReleases.push(resolve);
    });
  (holdApi.transfer as Record<string, unknown>)['abort'] = () =>
    new Promise<void>((resolve) => {
      abortReleases.push(() => {
        abortDone = true;
        resolve();
      });
    });
  const holdPort = createDesktopTransfer(holdApi);
  const holdBegan = await holdPort.begin(
    { destPath: 'd.mp4', resumeAtBytes: 0 },
    holdSrc.signal,
  );
  assert(holdBegan.ok, 'teardown begin resolves');
  const pendingWrite = holdBegan.value.write(new Uint8Array([9]));
  await Promise.resolve();
  holdSrc.cancel();
  const fired = await Promise.race([
    pendingWrite.then(() => 'write-settled' as const),
    Promise.resolve().then(() => 'still-parked' as const),
  ]);
  assertEqual(
    fired,
    'still-parked',
    'cancelled op waits on the utility-side teardown',
  );
  const releaseAbort = abortReleases[0];
  assert(releaseAbort !== undefined, 'teardown armed by the cancel');
  const releaseParked = writeReleases[0];
  assert(releaseParked !== undefined, 'write parked inside the fake');
  releaseParked();
  releaseAbort();
  const heldWrite = await pendingWrite;
  assert(
    !heldWrite.ok && heldWrite.error.kind === 'cancelled',
    'write settles cancelled only after teardown lands',
  );
  assert(abortDone, 'utility-side abort landed before the settle');
}
