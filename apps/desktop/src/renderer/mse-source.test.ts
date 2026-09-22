import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import {
  attachMseSource,
  MseAborted,
  MseUnsupported,
} from './mse-source.ts';
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
  /** Append indexes that produce no buffered range — init segments
   * land no media, so these model header-only appends. */
  rangelessAppends = new Set<number>();
  /** When true, appends EXTEND the last range instead of adding one —
   * Chromium merges adjacent appended media into a single TimeRange. */
  mergeAppends = false;
  media: FakeMediaSource | null = null;
  private listeners = new Map<string, Array<() => void>>();

  appendBuffer(data: Uint8Array): void {
    if (this.failNext) {
      this.failNext = false;
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    }
    // Per the MSE spec, an append on an ended source transitions it
    // back to open and refires sourceopen before the append lands.
    if (this.media !== null && this.media.readyState === 'ended') {
      const media = this.media;
      media.ended = false;
      media.readyState = 'open';
      queueMicrotask(() => media.fireSourceopen());
    }
    this.appends.push(new Uint8Array(data));
    this.updating = true;
    // Each appended unit maps to 10s of media in this fake.
    const i = this.appends.length - 1;
    if (!this.rangelessAppends.has(i)) {
      const last = this.buffered.list[this.buffered.list.length - 1];
      if (this.mergeAppends && last !== undefined) {
        this.buffered.list[this.buffered.list.length - 1] = [
          last[0],
          last[1] + 10,
        ];
      } else {
        this.buffered.list.push([i * 10, i * 10 + 10]);
      }
    }
    queueMicrotask(() => {
      this.updating = false;
      for (const l of this.listeners.get('updateend') ?? []) l();
    });
  }

  remove(start: number, end: number): void {
    this.removes.push([start, end]);
    // Real SourceBuffers split on partial overlap — a remove of the
    // middle of a merged range leaves the uncovered pieces buffered.
    const next: Array<[number, number]> = [];
    for (const [s, e] of this.buffered.list) {
      if (e <= start || s >= end) {
        next.push([s, e]);
        continue;
      }
      if (s < start) {
        next.push([s, start]);
      }
      if (e > end) {
        next.push([end, e]);
      }
    }
    this.buffered.list = next;
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
    this.sourceBuffer.media = this;
    return this.sourceBuffer;
  }
  endOfStream(): void {
    this.ended = true;
    this.readyState = 'ended';
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
  grantedBytes(): number {
    return this.sent
      .filter(
        (m): m is { bytes: number } =>
          (m as { kind?: string }).kind === 'grant',
      )
      .reduce((acc, m) => acc + m.bytes, 0);
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
    const { url } = await attach;
    const source = await (await attach).ready;
    assertEqual(url, 'blob:fake');
    assertEqual(source.url, 'blob:fake');
    const sb = media.sourceBuffer;
    assert(sb !== null);
    // init + cluster1 + (cluster2|cues tail) — all boundary-aligned.
    assertEqual(sb.appends.length, 3);
    assertEqual(sb.appends[0]?.byteLength, 29, 'init segment bytes');
    assert(media.ended, 'endOfStream after drain');
  }

  // Journal-covered seek with the media no longer buffered: the
  // byte↔media map routes seekTo into a pump `seek` frame at the
  // covering unit's byte start. (A still-buffered target is an
  // element-only rewind — no pump frame.)
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
    const source = await (await attach).ready;
    const sb = media.sourceBuffer;
    assert(sb !== null);
    sb.buffered.list = [[30, 40]]; // early media evicted
    source.seekTo(5_000); // journaled at 0–10s but no longer buffered
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
    await (await attach).ready.catch((e) => {
      rejected = e;
    });
    assert(
      rejected instanceof MseUnsupported,
      `non-fragmented mp4 refused, got ${String(rejected)}`,
    );
    assertDeepEqual(mse.revoked, ['blob:fake'], 'object URL revoked');
    assert(port.closed, 'port closed on refusal');
  }

  // Quota eviction: a QuotaExceededError evicts out-of-window media —
  // clamped to the stale part of a MERGED range (adjacent appends
  // surface as one TimeRange in Chromium) — then retries the append.
  // A second quota hit on a different unit recovers again (retry state
  // is per-append, not per-session).
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
    // Enough appends that the journal anchor clears the keep-behind
    // window (10s of media per append in this fake).
    feedData(port, webmFixture(), 0);
    for (let i = 1; i < 8; i++) {
      feedData(port, webmFixture(), i * 63);
    }
    const source = await (await attach).ready;
    await settle(); // the emitted queue finishes appending
    const sb = media.sourceBuffer;
    assert(sb !== null);
    const anchorS = sb.appends.length * 10;
    assert(anchorS > 120, 'anchor past the keep-behind window');
    // Chromium merges adjacent buffered media into one range.
    sb.buffered.list = [[0, anchorS]];
    sb.failNext = true;
    feedData(port, webmFixture(), 8 * 63);
    await settle();
    assertDeepEqual(
      sb.removes,
      [[0, anchorS - 120]],
      'merged range evicted only its out-of-window prefix',
    );
    const afterFirst = sb.appends.length;
    // Second quota hit on a NEW unit — must evict again, not fail.
    sb.failNext = true;
    feedData(port, webmFixture(), 9 * 63);
    await settle();
    assert(
      sb.appends.length > afterFirst,
      'second quota recovery kept appending',
    );
    assert(!port.closed, 'session survived a second quota recovery');
    void source;
  }

  // Credit keeps flowing while a unit is open: bytes past the last
  // boundary sit in ingest, and a grant that only replenished on
  // append-completion would starve a segment larger than the window.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4a',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    const grantsAtOpen = port.grants();
    // Feed only through mid-cluster1 — no second boundary exists yet,
    // so the open unit's bytes sit in ingest.
    feedData(port, webmFixture().subarray(0, 35), 0);
    await settle();
    assert(
      port.grants() > grantsAtOpen,
      'credit topped up while the open unit was incomplete',
    );
    void attach;
  }

  // Outstanding credit bounds the window: granted-but-undelivered
  // bytes count against HIGH_WATER, so total grants can never exceed
  // the window plus what the pump already delivered (otherwise every
  // flush would re-send nearly the whole window — grants are additive
  // on the pump side and memory would grow unbounded).
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4b0',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    feedData(port, webmFixture(), 0);
    feedData(port, webmFixture(), 63);
    feedData(port, webmFixture(), 126);
    await settle();
    const HIGH_WATER = 8 * 1024 * 1024;
    assert(
      port.grantedBytes() <= HIGH_WATER + 3 * 63,
      `grants stayed inside the window: ${port.grantedBytes()}`,
    );
    void attach;
  }

  // A media segment bigger than the credit window still completes:
  // the open unit doesn't count against grant accounting (its
  // terminating boundary is upstream), so the pump keeps pulling
  // credit until it closes — bounded only by MAX_UNIT_BYTES.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4c0',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    // EBML head + Segment header (reused from the fixture) + one
    // ~10MiB Cluster + a closing Cluster. Had credit counted the open
    // unit, the pump would stall at the 8MiB window with the second
    // boundary never arriving.
    const payload = 10 * 1024 * 1024;
    const big = new Uint8Array(17 + 8 + payload + 9);
    big.set(webmFixture().subarray(0, 17), 0);
    big.set([0x1f, 0x43, 0xb6, 0x75, 0x10, 0xa0, 0x00, 0x00], 17);
    big.set(
      [0x1f, 0x43, 0xb6, 0x75, 0x85, 0, 0, 0, 0],
      17 + 8 + payload,
    );
    feedData(port, big, 0, 0, 1024 * 1024);
    await settle();
    assert(
      port.grantedBytes() > 8 * 1024 * 1024,
      'credit flowed past the window while the unit was open',
    );
    const sb = media.sourceBuffer;
    assert(sb !== null && sb.appends.length >= 2, 'the big unit appended');
    void attach;
  }

  // A segment past the 64MiB cap is refused — the open unit is exempt
  // from the credit window but not unbounded.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const mse = factories(media);
    const attach = attachMseSource({
      handle: 'h-4c1',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse,
    });
    await settle();
    media.fireSourceopen();
    const payload = 65 * 1024 * 1024;
    const big = new Uint8Array(17 + 8 + payload);
    big.set(webmFixture().subarray(0, 17), 0);
    big.set([0x1f, 0x43, 0xb6, 0x75, 0x14, 0x01, 0x00, 0x00], 17);
    feedData(port, big, 0, 0, 2 * 1024 * 1024);
    await settle();
    assert(port.closed, 'oversized segment killed the session');
    assertDeepEqual(mse.revoked, ['blob:fake'], 'session revoked its url');
    void attach;
  }

  // The seek estimate reads non-overlapping coverage: with merged
  // ranges (Chromium coalesces adjacent appends into one TimeRange),
  // each append journals only the media it added — crediting the whole
  // merged range per append would double-count durations and push the
  // estimate's byte too early.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4c2',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    const sb = media.sourceBuffer;
    assert(sb !== null);
    sb.mergeAppends = true;
    // Bytes 0..47 — two units, no Cues tail (a cue hit would route the
    // seek before the estimate ever runs).
    feedData(port, webmFixture().subarray(0, 48), 0);
    const source = await (await attach).ready;
    // Coverage: 29B→10s + 10B→10s = 39B/20s. An estimate at 40s must
    // land 78; the double-counted journal (30s/39B) would land 52.
    source.seekTo(40_000);
    const seek = port.sent.find(
      (m) => (m as { kind?: string }).kind === 'seek',
    ) as { position: number } | undefined;
    assert(seek !== undefined, 'estimated seek sent');
    assertEqual(seek.position, 78, 'estimate from delta coverage');
  }

  // A journal-covered seek whose media is still buffered does no pump
  // work — and past EOF it must not re-anchor a fetch into the ended
  // source. Only an UNCOVERED post-EOF seek re-anchors, and its next
  // append re-opens the source per the MSE spec (sourceopen refires
  // with the existing SourceBuffer — not a second addSourceBuffer).
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4d0',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    // No Cues tail — all coverage lands in the journal.
    feedData(port, webmFixture().subarray(0, 48), 0);
    port.feed({ kind: 'eof', epoch: 0 });
    const source = await (await attach).ready;
    await settle();
    assert(media.ended, 'eof ended the source');
    assertEqual(media.readyState, 'ended');
    const coveredSeeks = port.sent.filter(
      (m) => (m as { kind?: string }).kind === 'seek',
    ).length;
    // Covered + still buffered: element-only rewind, no pump traffic.
    source.seekTo(5_000);
    assert(
      port.sent.filter((m) => (m as { kind?: string }).kind === 'seek')
        .length === coveredSeeks,
      'covered seek sent no pump frame',
    );
    // Uncovered: re-anchor at the estimate — the next append on the
    // ended source re-opens it instead of failing playback.
    source.seekTo(40_000);
    const seek = port.sent.find(
      (m) => (m as { kind?: string }).kind === 'seek',
    ) as { position: number; epoch: number } | undefined;
    assert(seek !== undefined, 'uncovered seek re-anchored');
    const appendsBefore = media.sourceBuffer?.appends.length ?? 0;
    feedData(
      port,
      webmFixture().subarray(29, 48),
      seek.position,
      seek.epoch,
    );
    port.feed({ kind: 'eof', epoch: seek.epoch });
    await settle();
    const sb = media.sourceBuffer;
    assert(sb !== null && sb.appends.length > appendsBefore);
    assert(
      media.ended && media.readyState === 'ended',
      'the reopened source re-ended on the post-seek eof',
    );
  }

  // Quota eviction anchors at the reported playhead — a download far
  // ahead of playback must not evict the media about to play.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4d1',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    feedData(port, webmFixture(), 0);
    const source = await (await attach).ready;
    await settle();
    const sb = media.sourceBuffer;
    assert(sb !== null);
    // One merged 500s range with the playhead at 300s: eviction keeps
    // [anchor−120s, anchor+300s] = [180, 600] — only [0,180) is stale.
    // Anchored on the append frontier (~40s) it would have evicted the
    // playhead's own media below ~340s instead.
    source.notePosition(300_000);
    sb.buffered.list = [[0, 500]];
    sb.failNext = true;
    feedData(port, webmFixture(), webmFixture().length);
    await settle();
    assertDeepEqual(sb.removes, [[0, 180]], 'eviction kept the playhead window');
  }

  // abort() settles `ready` with MseAborted — a killed attach must
  // not leave a caller suspended on first.settle forever.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = await attachMseSource({
      handle: 'h-4e',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    attach.abort();
    const outcome = await attach.ready.then(
      () => 'resolved',
      (thrown: unknown) => thrown,
    );
    assert(outcome instanceof MseAborted, 'abort rejects ready');
    assert(port.closed, 'abort closed the pump port');
  }

  // Post-attach failure reaches the player: a pump error frame after
  // resolution fires the source's onFail listeners (the element's own
  // error event never fires for a dead MSE feed).
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4b1',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    feedData(port, webmFixture(), 0);
    const source = await (await attach).ready;
    let failed: unknown = null;
    source.onFail((error) => {
      failed = error;
    });
    port.feed({ kind: 'error', epoch: 0, code: 'io-error', message: 'dead' });
    await settle();
    assert(failed instanceof Error, 'onFail fired on pump death');
    assert(
      String(failed).includes('io-error'),
      'failure carried the pump error',
    );
    assert(port.closed, 'dead session closed its port');
  }

  // A pump error frame from before a seek is stale — its epoch no
  // longer names the live session, so it must not fail the re-anchored
  // source the way a current-epoch error does.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4b2',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    feedData(port, webmFixture(), 0);
    const source = await (await attach).ready;
    const sb = media.sourceBuffer;
    assert(sb !== null);
    let failed: unknown = null;
    source.onFail((error) => {
      failed = error;
    });
    // Bump the epoch exactly like the h-2 seek case: evicted media
    // under journaled coverage routes seekTo into a pump seek frame.
    sb.buffered.list = [[30, 40]];
    source.seekTo(5_000);
    const seek = port.sent.find(
      (m) => (m as { kind?: string }).kind === 'seek',
    ) as { epoch: number } | undefined;
    assertEqual(seek?.epoch, 1, 'seek re-anchored the session at epoch 1');
    port.feed({ kind: 'error', epoch: 0, code: 'io-error', message: 'stale' });
    await settle();
    assertEqual(failed, null, 'stale-epoch error ignored');
    assert(!port.closed, 'stale error did not close the port');
    // 'closed' is the bridge's transport-death signal, not an
    // epoch-scoped read error — it must fail even at a stale epoch.
    port.feed({ kind: 'error', epoch: 0, code: 'closed', message: 'gone' });
    await settle();
    assert(failed instanceof Error, 'transport closure fails at any epoch');
    assert(port.closed, 'dead session closed its port');
  }

  // The attach resolves only once media lands — an init-segment append
  // produces no `buffered` range, so a head-only stream stays pending
  // and can still fall back; the first media-bearing append resolves.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const attach = attachMseSource({
      handle: 'h-4b',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse: factories(media),
    });
    await settle();
    media.fireSourceopen();
    let settled = false;
    void (await attach).ready.then(() => {
      settled = true;
    });
    const sb = media.sourceBuffer;
    assert(sb !== null);
    // Feed through mid-cluster1 — the boundary at 29 becomes visible,
    // so the init unit [17,29) appends (marked range-less, like a real
    // init segment) while the open cluster keeps the rest in ingest.
    sb.rangelessAppends.add(0);
    feedData(port, webmFixture().subarray(0, 35), 0);
    await settle();
    assert(sb.appends.length === 1, 'init unit appended');
    assert(!settled, 'attach pending until a media range lands');
    feedData(port, webmFixture().subarray(35), 35);
    await settle();
    assert(settled, 'attach resolved once media appended');
  }

  // abort() before the URL reaches an element closes the pump port and
  // revokes the object URL — no fallback leg is minted for a dead op.
  {
    const media = new FakeMediaSource();
    const port = new FakePort();
    const mse = factories(media);
    const attach = await attachMseSource({
      handle: 'h-4c',
      mime: 'audio/webm',
      channel: () => Promise.resolve(port),
      mse,
    });
    await settle();
    attach.abort();
    assert(
      port.sent.some((m) => (m as { kind?: string }).kind === 'close'),
      'abort sent the close frame',
    );
    assert(port.closed, 'abort closed the port');
    assertDeepEqual(mse.revoked, ['blob:fake'], 'abort revoked the url');
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
    const source = await (await attach).ready;
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
