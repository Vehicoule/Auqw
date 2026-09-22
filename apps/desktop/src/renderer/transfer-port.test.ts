import type { CancellationSignal } from '@auqw/application';
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
}
