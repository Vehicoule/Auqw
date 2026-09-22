import {
  assert,
  assertDeepEqual,
  assertEqual,
} from '@auqw/application/testing';
import {
  boundaryScan,
  carve,
  resyncScan,
  sniff,
} from './containers.ts';

// ---- fixture builders ---------------------------------------------------
//
// webmFixture layout (byte offsets):
//   0..11   EBML header el          (4 id + 1 size + 7 payload)
//  12..16   Segment id + size       (4 + 1; segDataStart = 17)
//  17..28   Info{TimecodeScale=1e6} (4+1+7 = 12)
//  29..38   Cluster #1              (4+1+5 = 10)  ← boundary 29
//  39..47   Cluster #2              (4+1+4 = 9)   ← boundary 39
//  48..62   Cues{CuePoint{t=64,clusterpos=22}}    (4+1+10 = 15)
//
// fmp4Fixture:
//   0..11 ftyp(4)  12..20 moov(1)  21..30 moof(2)  31..39 mdat(1)
//  40..48 moof(1)  49..58 mdat(2)                  boundaries 21, 40
//
// stypFmp4Fixture (segment-type-headed fmp4):
//   0..11 ftyp(4)  12..20 moov(1)  21..28 styp(0)  29..38 moof(2)
//  39..47 mdat(1) 48..55 styp(0) 56..64 moof(1)  65..74 mdat(2)
//                                                  boundaries 21, 48

function bytes(...parts: number[]): number[] {
  return parts;
}

/** EBML element: id bytes + 1-byte vint size + payload. */
function ebmlEl(id: number[], payload: number[]): number[] {
  assert(payload.length < 127, 'fixture sizes stay under the 1-byte vint');
  return [...id, 0x80 + payload.length, ...payload];
}

const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT = [0x18, 0x53, 0x80, 0x67];
const INFO = [0x15, 0x49, 0xa9, 0x66];
const TIMECODE_SCALE = [0x2a, 0xd7, 0xb1];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const CUES = [0x1c, 0x53, 0xbb, 0x6b];
const CUE_POINT = [0xbb];
const CUE_TIME = [0xb3];
const CUE_TRACK_POSITIONS = [0xb7];
const CUE_CLUSTER_POSITION = [0xf1];

function webmFixture(): Uint8Array {
  const head = ebmlEl(
    EBML_ID,
    bytes(0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d),
  );
  const info = ebmlEl(
    INFO,
    ebmlEl(TIMECODE_SCALE, bytes(0x0f, 0x42, 0x40)), // 1_000_000 ns = 1ms
  );
  const cluster1 = ebmlEl(CLUSTER, bytes(0xe7, 0x81, 0x00, 0xaa, 0xbb));
  const cluster2 = ebmlEl(CLUSTER, bytes(0xe7, 0x81, 0x01, 0xcc));
  // CueClusterPosition is segment-relative: 12 (info) + 10 (cluster1) = 22
  const cuePoint = ebmlEl(CUE_POINT, [
    ...ebmlEl(CUE_TIME, [0x40]), // timecode 64 ticks = 64ms at scale 1
    ...ebmlEl(CUE_TRACK_POSITIONS, ebmlEl(CUE_CLUSTER_POSITION, [22])),
  ]);
  const cues = ebmlEl(CUES, cuePoint);
  const body = [...info, ...cluster1, ...cluster2, ...cues];
  const segment = [...SEGMENT, 0x80 + body.length, ...body];
  return new Uint8Array([...head, ...segment]);
}

/** Live-mux style: unknown-size Segment + unknown-size Cluster whose
 * terminator is the next cluster's start. */
function webmLiveFixture(): Uint8Array {
  const head = ebmlEl(EBML_ID, [0x42, 0x82, 0x84, 0x77]);
  const openSegment = [...SEGMENT, 0xff]; // 1-byte unknown-size vint
  const openCluster = [...CLUSTER, 0xff, ...bytes(0xe7, 0x81, 0x00, 0xdd)];
  const cluster2 = ebmlEl(CLUSTER, bytes(0xe7, 0x81, 0x05));
  return new Uint8Array([...head, ...openSegment, ...openCluster, ...cluster2]);
}

function mp4Box(type: string, payload: number[]): number[] {
  return [
    ((8 + payload.length) >>> 24) & 0xff,
    ((8 + payload.length) >>> 16) & 0xff,
    ((8 + payload.length) >>> 8) & 0xff,
    (8 + payload.length) & 0xff,
    ...Array.from(type, (c) => c.charCodeAt(0)),
    ...payload,
  ];
}

function fmp4Fixture(): Uint8Array {
  return new Uint8Array([
    ...mp4Box('ftyp', bytes(0x69, 0x73, 0x6f, 0x36)),
    ...mp4Box('moov', bytes(0x00)),
    ...mp4Box('moof', bytes(0x01, 0x02)),
    ...mp4Box('mdat', bytes(0x33)),
    ...mp4Box('moof', bytes(0x04)),
    ...mp4Box('mdat', bytes(0x44, 0x55)),
  ]);
}

function plainMp4Fixture(): Uint8Array {
  return new Uint8Array([
    ...mp4Box('ftyp', bytes(0x69, 0x73, 0x6f, 0x36)),
    ...mp4Box('moov', bytes(0x00)),
    ...mp4Box('mdat', bytes(0x33)),
  ]);
}

/** Fragmented mp4 whose segments open with `styp` — the boundary
 * must anchor the styp, not the following moof, or the segment type
 * lands inside the previous append. */
function stypFmp4Fixture(): Uint8Array {
  return new Uint8Array([
    ...mp4Box('ftyp', bytes(0x69, 0x73, 0x6f, 0x36)),
    ...mp4Box('moov', bytes(0x00)),
    ...mp4Box('styp', bytes()),
    ...mp4Box('moof', bytes(0x01, 0x02)),
    ...mp4Box('mdat', bytes(0x33)),
    ...mp4Box('styp', bytes()),
    ...mp4Box('moof', bytes(0x04)),
    ...mp4Box('mdat', bytes(0x44, 0x55)),
  ]);
}

export function run(): void {
  // sniff
  assertDeepEqual(sniff(webmFixture()), { kind: 'ok', container: 'webm' });
  assertDeepEqual(sniff(fmp4Fixture()), { kind: 'ok', container: 'mp4' });
  assertDeepEqual(sniff(new Uint8Array(2)), { kind: 'need-more' });
  assertDeepEqual(
    sniff(new Uint8Array(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))),
    { kind: 'unsupported' },
  );

  // carve: webm — boundaries on each cluster, cues + scale parsed.
  {
    const result = carve(webmFixture());
    assert(result.kind === 'ok', 'webm carves');
    if (result.kind !== 'ok') return;
    assertEqual(result.container, 'webm');
    assertDeepEqual(result.boundaries, [29, 39]);
    assertEqual(result.segDataStart, 17);
    assertEqual(result.scaleMs, 1, '1ms timecode scale');
    assertEqual(result.cues.length, 1);
    assertEqual(result.cues[0]?.mediaMs, 64, 'cue time scaled to ms');
    assertEqual(
      result.cues[0]?.byte,
      39,
      'cue byte = segDataStart + cluster offset',
    );
  }

  // carve: unknown-size segment+cluster resyncs onto the next cluster.
  {
    const result = carve(webmLiveFixture());
    assert(result.kind === 'ok', 'live webm carves');
    if (result.kind !== 'ok') return;
    assertDeepEqual(result.boundaries, [14, 23]);
  }

  // carve: fmp4 boundaries land on each moof.
  {
    const result = carve(fmp4Fixture());
    assert(result.kind === 'ok', 'fmp4 carves');
    if (result.kind !== 'ok') return;
    assertDeepEqual(result.boundaries, [21, 40]);
    assertEqual(result.container, 'mp4');
  }

  // carve: styp-headed fmp4 — each boundary anchors the styp that
  // opens the segment, not the moof after it. Segment-level boxes
  // (sidx) may sit between styp and moof — the anchor persists.
  {
    const result = carve(stypFmp4Fixture());
    assert(result.kind === 'ok', 'styp fmp4 carves');
    if (result.kind !== 'ok') return;
    assertDeepEqual(result.boundaries, [21, 48], 'styp-anchored bounds');
  }

  // carve: styp + sidx + moof — the boundary still anchors the styp,
  // or sidx would be absorbed into the previous fragment.
  {
    const fix = new Uint8Array([
      ...mp4Box('ftyp', bytes(0x69, 0x73, 0x6f, 0x36)),
      ...mp4Box('moov', bytes(0x00)),
      ...mp4Box('styp', bytes()),
      ...mp4Box('sidx', bytes(0x11, 0x22)),
      ...mp4Box('moof', bytes(0x01)),
      ...mp4Box('mdat', bytes(0x33)),
      ...mp4Box('styp', bytes()),
      ...mp4Box('sidx', bytes(0x44)),
      ...mp4Box('moof', bytes(0x04)),
      ...mp4Box('mdat', bytes(0x44)),
    ]);
    // ftyp 0..11, moov 12..20, styp 21..28, sidx 29..38, moof 39..47,
    // mdat 48..56, styp 57..64, sidx 65..73, moof 74..81, mdat 82..
    const result = carve(fix);
    assert(result.kind === 'ok', 'sidx fmp4 carves');
    if (result.kind !== 'ok') return;
    assertDeepEqual(result.boundaries, [21, 57], 'styp anchors past sidx');
    // boundaryScan steady-state must anchor the same way.
    const mid = boundaryScan(fix.subarray(57), 'mp4', 0, 1);
    assertDeepEqual(mid.boundaries, [0], 'mid-stream styp+sidx anchored');
  }

  // carve: plain mp4 is refused — the caller falls back to serve-url.
  assertDeepEqual(carve(plainMp4Fixture()), { kind: 'unsupported' });
  assertDeepEqual(carve(new Uint8Array([0x1a])), { kind: 'need-more' });

  // Property-ish: every truncation of the fixtures yields a verdict —
  // never a throw, never a hang — and emitted boundaries stay
  // strictly ascending and inside the buffer.
  {
    for (const fix of [
      webmFixture(),
      fmp4Fixture(),
      stypFmp4Fixture(),
      plainMp4Fixture(),
    ]) {
      for (let cut = 0; cut <= fix.length; cut++) {
        const r = carve(fix.subarray(0, cut));
        assert(
          r.kind === 'ok' ||
            r.kind === 'need-more' ||
            r.kind === 'unsupported',
          'carve verdict on truncation',
        );
        if (r.kind === 'ok') {
          for (let i = 1; i < r.boundaries.length; i++) {
            const prev = r.boundaries[i - 1];
            const next = r.boundaries[i];
            assert(
              next !== undefined &&
                prev !== undefined &&
                next > prev &&
                next < cut,
              'boundaries strictly ascending + in-range',
            );
          }
        }
      }
    }
    // Malformed size fields — the walker still terminates in a
    // verdict rather than running off the buffer or looping.
    const wild = stypFmp4Fixture();
    wild[4] = 0xff;
    wild[5] = 0xff;
    const w = carve(wild);
    assert(
      w.kind === 'ok' || w.kind === 'need-more' || w.kind === 'unsupported',
      'malformed sizes still reach a verdict',
    );
    // boundaryScan steady-state: any truncation keeps emitted
    // boundaries ascending and in-range on both containers.
    for (const fix of [webmFixture(), stypFmp4Fixture()]) {
      for (let cut = 0; cut <= fix.length; cut += 3) {
        const s = boundaryScan(
          fix.subarray(0, cut),
          fix === webmFixture() ? 'webm' : 'mp4',
          0,
          1,
        );
        for (let i = 1; i < s.boundaries.length; i++) {
          const prev = s.boundaries[i - 1];
          const next = s.boundaries[i];
          assert(
            next !== undefined &&
              prev !== undefined &&
              next > prev &&
              next < cut,
            'scan boundaries ascending + in-range',
          );
        }
      }
    }
  }

  // carve: an mp4 head that stops after ftyp/moov stays need-more —
  // only a moof (fragmented) or a bare mdat (non-fragmented) decides,
  // so a plain mp4 whose mdat hasn't arrived yet isn't locked into
  // the fragmented path.
  {
    const headOnly = fmp4Fixture().subarray(0, 21); // ftyp + moov
    assertDeepEqual(carve(headOnly), { kind: 'need-more' });
    const throughMdat = plainMp4Fixture().subarray(0, 29); // + mdat header
    assertDeepEqual(carve(throughMdat), { kind: 'unsupported' });
  }

  // boundaryScan on a mid-stream head (the fixture's second cluster):
  // sibling walk sees the cluster, then the trailing Cues element.
  {
    const fix = webmFixture();
    const mid = fix.subarray(39);
    const scan = boundaryScan(mid, 'webm', 17, 1);
    assertDeepEqual(scan.boundaries, [0], 'mid-stream head is a boundary');
    assertEqual(scan.cues.length, 1, 'trailing cues re-parsed');
    assertEqual(scan.cues[0]?.byte, 39);
  }

  // boundaryScan with a known-size Segment: descends into children —
  // opaque-sibling handling would skip every cluster.
  {
    const fix = webmFixture();
    const scan = boundaryScan(fix, 'webm', 17, 1);
    assertDeepEqual(scan.boundaries, [29, 39]);
  }

  // boundaryScan mid-stream on styp: the head is already a boundary
  // (styp opens a segment), and the next styp anchors the next.
  {
    const fix = stypFmp4Fixture();
    const scan = boundaryScan(fix.subarray(48), 'mp4', 0, 0);
    assertDeepEqual(scan.boundaries, [0], 'mid-stream styp is a boundary');
  }

  // resyncScan lands on the first boundary signature after junk bytes.
  {
    const fix = webmFixture();
    const found = resyncScan(
      new Uint8Array([0x00, 0xde, 0xad, ...fix.subarray(29)]),
      'webm',
    );
    assertEqual(found, 3, 'junk prefix skipped to the cluster head');
    const mp4 = fmp4Fixture();
    const mp4Found = resyncScan(
      new Uint8Array([0x00, 0x00, 0x00, ...mp4.subarray(21)]),
      'mp4',
    );
    assertEqual(mp4Found, 3, 'moof found after junk');
    const styp = stypFmp4Fixture();
    const stypFound = resyncScan(
      new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, ...styp.subarray(48)]),
      'mp4',
    );
    assertEqual(stypFound, 4, 'styp found after junk');
    assertEqual(resyncScan(new Uint8Array([1, 2, 3]), 'mp4'), -1);
  }
}
