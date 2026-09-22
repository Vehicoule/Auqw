import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import type { PluginHostLike } from './host.ts';
import { createStreamPump, type PumpPort } from './bytes.ts';

type Sent = Array<{ kind?: string; [key: string]: unknown }>;

function fakePort(): PumpPort & {
  sent: Sent;
  emitMessage(data: unknown): void;
  emitClose(): void;
  closed: boolean;
  started: boolean;
} {
  const listeners = new Map<string, Array<(event?: { data: unknown }) => void>>();
  const port = {
    sent: [] as Sent,
    closed: false,
    started: false,
    postMessage(message: unknown) {
      port.sent.push(message as { kind?: string });
    },
    on(event: 'message' | 'close', listener: (event?: { data: unknown }) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    start() {
      port.started = true;
    },
    close() {
      port.closed = true;
    },
    emitMessage(data: unknown) {
      for (const listener of listeners.get('message') ?? []) {
        listener({ data });
      }
    },
    emitClose() {
      for (const listener of listeners.get('close') ?? []) {
        listener();
      }
    },
  };
  return port;
}

function fakeHost(
  bytes: Uint8Array,
  overrides: Partial<PluginHostLike> = {},
): PluginHostLike & { closes: string[]; reads: number[] } {
  const host = {
    closes: [] as string[],
    reads: [] as number[],
    async loadPlugin() {
      return 'id';
    },
    async startPrepare() {
      return { type: 'prepared' as const, stream: undefined };
    },
    cancel() {},
    devPrepareUrl() {
      return { handle: 'd', mime: 'audio/mp4' };
    },
    streamServeUrl() {
      return 'http://127.0.0.1:9/s/x';
    },
    streamOpen() {
      return bytes.byteLength;
    },
    async streamRead(_handle: string, position: number, length: number) {
      host.reads.push(position);
      return Buffer.from(bytes.subarray(position, position + length));
    },
    streamClose(handle: string) {
      host.closes.push(handle);
    },
    streamRelease() {},
    streamPhaseMarks() {
      return { mintMs: 1, attachMs: 1 };
    },
    ...overrides,
  };
  return host as PluginHostLike & { closes: string[]; reads: number[] };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export async function run(): Promise<void> {
  // ready announces the open; grants gate reads until credit exists.
  {
    const bytes = new Uint8Array(1024).fill(7);
    const host = fakeHost(bytes);
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-1', port });
    assert(port.started, 'port started on attach');
    assertDeepEqual(port.sent[0], { kind: 'ready', remaining: 1024, epoch: 0 });
    await settle();
    assertEqual(port.sent.length, 1, 'no reads without credit');
    port.emitMessage({ kind: 'grant', bytes: 256 });
    await settle();
    const data = port.sent.filter((m) => m.kind === 'data');
    assert(data.length >= 1, 'grant produced data frames');
    assertDeepEqual(data[0], {
      kind: 'data',
      position: 0,
      epoch: 0,
      bytes: new Uint8Array(256).fill(7),
    });
  }

  // EOF arrives once the stream is drained; close detaches the handle.
  {
    const bytes = new Uint8Array(64).fill(3);
    const host = fakeHost(bytes);
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-2', port });
    port.emitMessage({ kind: 'grant', bytes: 4096 });
    await settle();
    const kinds = port.sent.map((m) => m.kind);
    assert(kinds.includes('data'), 'bytes flowed');
    assert(kinds.includes('eof'), 'eof after the drain');
    port.emitMessage({ kind: 'close' });
    assertDeepEqual(host.closes, ['h-2'], 'close detaches the stream');
    assert(port.closed, 'port closed');
  }

  // A seek re-anchors the position, zeroes credit, and bumps the epoch —
  // the next grant reads from the new position only.
  {
    const bytes = new Uint8Array(512).fill(9);
    const host = fakeHost(bytes);
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-3', port });
    port.emitMessage({ kind: 'grant', bytes: 128 });
    await settle();
    port.emitMessage({ kind: 'seek', position: 300, epoch: 1 });
    await settle();
    const before = port.sent.filter((m) => m.kind === 'data').length;
    port.emitMessage({ kind: 'grant', bytes: 64 });
    await settle();
    const after = port.sent.filter((m) => m.kind === 'data');
    assert(after.length > before, 'post-seek grant produced data');
    const last = after[after.length - 1];
    assertEqual(last?.position, 300, 'reads resumed at the seek position');
    assertEqual(last?.epoch, 1, 'data carries the seek epoch');
  }

  // A slow read in flight when the seek lands is re-issued at the new
  // position — its stale-epoch chunk is dropped, never sent.
  {
    const bytes = new Uint8Array(1024).fill(5);
    let release: (() => void) | undefined;
    let calls = 0;
    const host = fakeHost(bytes, {
      async streamRead(_h: string, position: number, length: number) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Buffer.from(bytes.subarray(position, position + length));
      },
    });
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-4', port });
    port.emitMessage({ kind: 'grant', bytes: 256 });
    await settle();
    port.emitMessage({ kind: 'seek', position: 700, epoch: 2 });
    release?.();
    await settle();
    // The seek zeroed credit — a new grant reads at the re-anchored
    // position under the new epoch.
    port.emitMessage({ kind: 'grant', bytes: 64 });
    await settle();
    const data = port.sent.filter((m) => m.kind === 'data');
    assert(
      data.every((m) => m.epoch === 2),
      'no stale-epoch chunk crossed the port',
    );
    assertEqual(data[0]?.position, 700, 're-read at the re-anchored position');
  }

  // A stale-epoch read that *rejects* after a seek must not strand the
  // post-seek credit: the pump keeps reading at the re-anchored
  // position, not dead-stop on the old epoch's failure.
  {
    const bytes = new Uint8Array(1024).fill(6);
    let reject: ((e: Error) => void) | undefined;
    let calls = 0;
    const host = fakeHost(bytes, {
      async streamRead(_h: string, position: number, length: number) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((_r, rej) => {
            reject = rej;
          });
        }
        return Buffer.from(bytes.subarray(position, position + length));
      },
    });
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-4b', port });
    port.emitMessage({ kind: 'grant', bytes: 256 });
    await settle();
    // The in-flight read is epoch 0; the seek re-anchors to epoch 1 and
    // the new grant is already queued when the stale read finally dies.
    port.emitMessage({ kind: 'seek', position: 700, epoch: 1 });
    port.emitMessage({ kind: 'grant', bytes: 128 });
    reject?.(new Error('socket died mid-read'));
    await settle();
    const data = port.sent.filter((m) => m.kind === 'data');
    assert(
      data.length >= 1 && data.every((m) => m.epoch === 1),
      'post-seek credit still produced reads after the stale rejection',
    );
    assertEqual(data[0]?.position, 700, 'reads continued at the anchor');
    assert(
      port.sent.every((m) => m.kind !== 'error'),
      'stale rejection never surfaced as an error frame',
    );
  }

  // A streamOpen failure surfaces as an error frame, then closes.
  {
    const host = fakeHost(new Uint8Array(0), {
      streamOpen() {
        throw new Error('streams-capped');
      },
    });
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-5', port });
    const error = port.sent.find((m) => m.kind === 'error');
    assert(error !== undefined, 'open failure sent an error frame');
    assertEqual(error?.['code'], 'unavailable');
    assert(port.closed, 'failed attach closed the port');
  }

  // A port 'close' event detaches the stream exactly once.
  {
    const host = fakeHost(new Uint8Array(8).fill(1));
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-6', port });
    port.emitClose();
    port.emitMessage({ kind: 'close' });
    assertDeepEqual(host.closes, ['h-6'], 'detach ran once');
  }

  // Invalid client frames are dropped silently.
  {
    const host = fakeHost(new Uint8Array(8).fill(1));
    const port = fakePort();
    createStreamPump({ host: () => host, handle: 'h-7', port });
    port.emitMessage({ kind: 'grant', bytes: -1 });
    port.emitMessage('grant');
    port.emitMessage({ kind: 'seek', position: 0 });
    await settle();
    assertEqual(
      port.sent.filter((m) => m.kind === 'data').length,
      0,
      'invalid frames produced no reads',
    );
  }
}
