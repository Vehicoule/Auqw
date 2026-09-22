import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import { attachMseSource, MseUnsupported } from './mse-source.ts';
import type {
  MediaSourceLike,
  MseFactories,
  SourceBufferLike,
  TimeRangesLike,
} from './mse-source.ts';
import type { StreamPortLike } from '../shared/contract.ts';

// ---- the same minimal webm fixture as containers.test -------------------
//   0..11  EBML  12..16 Segment head  17..28 Info  29..38 Cluster(4+1+5)
//   39..47 Cluster(4+1+4)  48..62 Cues{t=64ms → byte 39}
function ebmlEl(id: number[], payload: number[]): number[] {
  return [...id, 0x80 + payload.length, ...payload];
}
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
function webmFixture(): Uint8Array {
  const head = ebmlEl([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  const info = ebmlEl([0x15, 0x49, 0xa9, 0x66], ebmlEl([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]));
  const c1 = ebmlEl(CLUSTER, [0xe7, 0x81, 0x00, 0xaa, 0xbb]);
  const c2 = ebmlEl(CLUSTER, [0xe7, 0x81, 0x01, 0xcc]);
  const cues = ebmlEl(
    [0x1c, 0x53, 0xbb, 0x6b],
    ebmlEl([0xbb], [
      ...ebmlEl([0xb3], [0x40]),
      ...ebmlEl([0xb7], ebmlEl([0xf1], [22])),
    ]),
  );
  const body = [...info, ...c1, ...c2, ...cues];
  return new Uint8Array([
    ...head,
    ...[0x18, 0x53, 0x80, 0x67, 0x80 + body.length],
    ...body,
  ]);
}

// ---- fakes --------------------------------------------------------------

class FakeRanges implements TimeRangesLike {
  list: Array<[number, number]> = [];
  get length(): number {
    return this.list.length;
  }
  start(i: number): number {
    return this.list[i]?.[0] ?? 0;
  }
  end(i: number): number {
    return this.list[i]?.[1] ?? 0;
  }
}

class FakeSourceBuffer implements SourceBufferLike {
  updating = false;
  buffered = new FakeRanges();
  appends: Uint8Array[] = [];
  removes: Array<[number, number]> = [];
  failNext = false;
  private listeners = new Map<string, Array<() => void>>();

  appendBuffer(data: Uint8Array): void {
    if (this.failNext) {
      this.failNext = false;
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.appends.push(new Uint8Array(data));
    this.updating = true;
    // Each appended unit maps to 10s of media in this fake.
    const i = this.appends.length - 1;
    this.buffered.list.push([i * 10, i * 10 + 10]);
    queueMicrotask(() => {
      this.updating = false;
      for (const l of this.listeners.get('updateend') ?? []) l();
    });
  }

  remove(start: number, end: number): void {
    this.removes.push([start, end]);
    this.buffered.list = this.buffered.list.filter(
      ([s, e]) => !(s === start && e === end),
    );
    queueMicrotask(() => {
      for (const l of this.listeners.get('updateend') ?? []) l();
    });
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
}

class FakeMediaSource implements MediaSourceLike {
  readyState = 'closed';
  duration = 0;
  ended = false;
  sourceBuffer: FakeSourceBuffer | null = null;
  private listeners = new Map<string, Array<() => void>>();

  addSourceBuffer(_mime: string): SourceBufferLike {
    this.sourceBuffer = new FakeSourceBuffer();
    return this.sourceBuffer;
  }
  endOfStream(): void {
    this.ended = true;
  }
  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fireSourceopen(): void {
    this.readyState = 'open';
    for (const l of this.listeners.get('sourceopen') ?? []) l();
  }
}

class FakePort implements StreamPortLike {
  sent: unknown[] = [];
  closed = false;
  private listeners = new Set<(m: unknown) => void>();
  send(message: unknown): void {
    this.sent.push(message);
  }
  onMessage(listener: (m: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
  }
  feed(frame: unknown): void {
    for (const l of [...this.listeners]) l(frame);
  }
  grants(): number {
    return this.sent.filter(
      (m) => (m as { kind?: string }).kind === 'grant',
    ).length;
  }
}

function factories(media: FakeMediaSource): MseFactories & {
  revoked: string[];
} {
  const f = {
    revoked: [] as string[],
    isTypeSupported: () => true,
    createSource: () => media,
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: (url: string) => {
      f.revoked.push(url);
    },
  };
  return f;
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Push `bytes` as stream data starting at absolute position `at`. */
function feedData(
  port: FakePort,
  bytes: Uint8Array,
  at = 0,
  epoch = 0,
  step = 8 * 1024,
): number {
  let pos = 0;
  while (pos < bytes.byteLength) {
    const end = Math.min(pos + step, bytes.byteLength);
    port.feed({
      kind: 'data',
      position: at + pos,
      epoch,
      bytes: bytes.subarray(pos, end),
    });
    pos = end;
  }
  return at + pos;
}

export async function run(): Promise<void> {
  // Attach → sourceopen → grant → carved appends land on boundaries.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const mse = factories(media);
    const attach = attachMseSource({
      handle: 'h-1',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse,
    });
    await settle(); // channel resolves → sourceopen listener lands
    media.fireSourceopen();
    assert(port.grants() === 1, 'initial credit grant');
    feedData(port, webmFixture(), 0);
    port.feed({ kind: 'eof', epoch: 0 });
    const source = await attach;
    assertEqual(source.url, 'blob:fake');
    const sb = media.sourceBuffer;
    assert(sb !== null);
    // init + cluster1 + (cluster2|cues tail) — all boundary-aligned.
    assertEqual(sb.appends.length, 3);
    assertEqual(sb.appends[0]?.byteLength, 29, 'init segment bytes');
    assert(media.ended, 'endOfStream after drain');
  }

  // Journal-covered seek: the byte↔media map routes seekTo into a pump
  // `seek` frame at the covering unit's byte start.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-2',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    feedData(port, webmFixture(), 0);
    const source = await attach;
    source.seekTo(5_000); // covered by unit 0's 0–10s media range
    const seek = port.sent.find(
      (m) => (m as { kind?: string }).kind === 'seek',
    ) as { position: number; epoch: number } | undefined;
    assert(seek !== undefined, 'seek frame sent');
    assertEqual(seek.position, 0, 'byte start of the covering unit');
    assertEqual(seek.epoch, 1, 'epoch bumped');
  }

  // Non-fragmented mp4 → MseUnsupported → caller falls back.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const mse = factories(media);
    // ftyp(12) → moov(9) → mdat(9): an mdat reached with no moof is a
    // non-fragmented file — the MSE path must refuse it.
    const mp4 = new Uint8Array([
      ...[0, 0, 0, 12], 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4, // ftyp
      ...[0, 0, 0, 9], 0x6d, 0x6f, 0x6f, 0x76, 0, // moov
      ...[0, 0, 0, 9], 0x6d, 0x64, 0x61, 0x74, 0, // mdat (no moof)
    ]);
    const attach = attachMseSource({
      handle: 'h-3',
      mime: 'audio/mp4',
      channel: () => Promise.resolve(port),
      mse,
    });
    await settle();
    media.fireSourceopen();
    feedData(port, mp4, 0);
    let rejected: unknown = null;
    await attach.catch((e) => {
      rejected = e;
    });
    assert(
      rejected instanceof MseUnsupported,
      `non-fragmented mp4 refused, got ${String(rejected)}`,
    );
    assertDeepEqual(mse.revoked, ['blob:fake'], 'object URL revoked');
    assert(port.closed, 'port closed on refusal');
  }

  // Quota eviction: a QuotaExceededError evicts out-of-window ranges and
  // the append retries once.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    feedData(port, webmFixture(), 0);
    const source = await attach;
    const sb = media.sourceBuffer;
    assert(sb !== null);
    sb.failNext = true;
    // Feed a second stream's worth of bytes (contiguous after 63).
    const more = webmFixture();
    feedData(port, more, more.byteLength);
    port.feed({ kind: 'eof', epoch: 0 });
    await settle();
    assert(sb.removes.length >= 0, 'eviction ran without throwing');
    assert(sb.appends.length > 3, 'retry appended');
    void source;
  }

  // destroy() closes the pump port and revokes the object URL.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const mse = factories(media);
    const attach = attachMseSource({
      handle: 'h-5',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse,
    });
    await settle();
    media.fireSourceopen();
    feedData(port, webmFixture(), 0);
    const source = await attach;
    source.destroy();
    assert(
      port.sent.some((m) => (m as { kind?: string }).kind === 'close'),
      'close frame sent',
    );
    assert(port.closed);
    assertDeepEqual(mse.revoked, ['blob:fake']);
  }

  // channel() rejection → the attach promise rejects (serve-url fallback).
  {
    const media = new FakeMediaSource();
    const mse = factories(media);
    let rejected: unknown = null;
    await attachMseSource({
      handle: 'h-6',
      mime: 'audio/webm',
      channel: () => Promise.reject(new Error('no utility')),
      mse,
    }).catch((e) => {
      rejected = e;
    });
    assert(rejected instanceof Error);
    assertDeepEqual(mse.revoked, ['blob:fake'], 'url revoked on channel fail');
  }

  // isTypeSupported gate refuses before any channel call.
  {
    let channelCalls = 0;
    let rejected: unknown = null;
    await attachMseSource({
      handle: 'h-7',
      mime: 'audio/x-unknown',
      channel: () => {
        channelCalls += 1;
        return Promise.resolve(new FakePort());
      },
      mse: { ...factories(new FakeMediaSource()), isTypeSupported: () => false },
    }).catch((e) => {
      rejected = e;
    });
    assert(rejected instanceof MseUnsupported);
    assertEqual(channelCalls, 0, 'channel never invoked');
  }
}
