/**
 * Container sniffing + segment boundary walking for the MSE append
 * loop. SourceBuffer requires every append to start at a media-segment
 * boundary — a Cluster element for webm, a `moof`-headed segment for
 * fragmented mp4 — so the ingest buffer is carved on container
 * structure, never on read-chunk boundaries.
 *
 * A non-fragmented mp4 (`moov` + `mdat` with no `moof`) has no media
 * segments to align on and Chromium rejects it outright — the sniffer
 * reports it so the caller can take the `server.rs` fallback.
 */

export type ContainerKind = 'webm' | 'mp4' | 'unsupported';

export type SniffResult =
  | { readonly kind: 'need-more' }
  | { readonly kind: 'ok'; readonly container: 'webm' | 'mp4' }
  | { readonly kind: 'unsupported' };

/** EBML / WebM magic. */
const EBML_ID = 0x1a45dfa3;
/** Top-level Cluster element id inside a Segment. */
const WEBM_CLUSTER = 0x1f43b675;
const WEBM_SEGMENT = 0x18538067;
const WEBM_INFO = 0x1549a966;
const WEBM_TIMECODE_SCALE = 0x2ad7b1;
const WEBM_CUES = 0x1c53bb6b;
const WEBM_CUE_POINT = 0xbb;
const WEBM_CUE_TIME = 0xb3;
const WEBM_CUE_TRACK_POSITIONS = 0xb7;
const WEBM_CUE_CLUSTER_POSITION = 0xf1;

function u32be(buf: Uint8Array, off: number): number {
  return (
    ((buf[off] ?? 0) << 24) |
    ((buf[off + 1] ?? 0) << 16) |
    ((buf[off + 2] ?? 0) << 8) |
    (buf[off + 3] ?? 0)
  ) >>> 0;
}

/** EBML variable-width integer: leading-set-bit position = byte count. */
function readVint(
  buf: Uint8Array,
  off: number,
): { value: number; length: number; unknown: boolean } | null {
  if (off >= buf.length) {
    return null;
  }
  const first = buf[off] ?? 0;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || off + length > buf.length) {
    return null;
  }
  let value = first & (mask - 1);
  for (let i = 1; i < length; i++) {
    value = value * 256 + (buf[off + i] ?? 0);
  }
  // All data bits 1 = "unknown size" — webm live-muxes use it.
  const allOnes = length === 1 ? 0x7f : Number.POSITIVE_INFINITY;
  const unknown =
    length === 1
      ? value === allOnes
      : value === Math.pow(2, 7 * length) - 1;
  return { value, length, unknown };
}

/** Element id is a vint read without masking the leading bit. */
function readElementId(
  buf: Uint8Array,
  off: number,
): { id: number; length: number } | null {
  if (off >= buf.length) {
    return null;
  }
  const first = buf[off] ?? 0;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 4 || off + length > buf.length) {
    return null;
  }
  let id = 0;
  for (let i = 0; i < length; i++) {
    id = id * 256 + (buf[off + i] ?? 0);
  }
  return { id, length };
}

export function sniff(buf: Uint8Array): SniffResult {
  if (buf.byteLength < 4) {
    return { kind: 'need-more' };
  }
  if (u32be(buf, 0) === EBML_ID) {
    return { kind: 'ok', container: 'webm' };
  }
  if (buf.byteLength < 12) {
    return { kind: 'need-more' };
  }
  // ISO BMFF: first box is `ftyp`/`styp` — size(4) then 4cc at +4.
  const type = asciiType(buf, 4);
  if (type === 'ftyp' || type === 'styp') {
    return { kind: 'ok', container: 'mp4' };
  }
  return { kind: 'unsupported' };
}

function asciiType(buf: Uint8Array, off: number): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += String.fromCharCode(buf[off + i] ?? 0);
  }
  return out;
}

// ---- webm segment walker ------------------------------------------------

/**
 * A Cues entry: media timecode (ms, scale applied) → absolute byte
 * offset of the Cluster holding it.
 */
export type WebmCue = { readonly mediaMs: number; readonly byte: number };

export type WebmWalk = {
  /** Cluster start offsets — media-segment boundaries, ascending. */
  readonly boundaries: number[];
  /** Absolute offset of the Segment's payload — cue positions hang off it. */
  readonly segDataStart: number;
  /** Segment timecode scale in ms (Info; default 1ms). */
  readonly scaleMs: number;
  /** Parsed Cues entries, if the Cues element has been ingested. */
  readonly cues: readonly WebmCue[];
};

function readUint(buf: Uint8Array, off: number, len: number): number {
  let value = 0;
  // The declared length comes from untrusted bytes — cap at the EBML
  // uint maximum (8) and the buffer end, or a crafted size field loops
  // for 2^56 iterations on `?? 0` reads.
  const n = Math.min(len, 8, buf.length - off);
  for (let i = 0; i < n; i++) {
    value = value * 256 + (buf[off + i] ?? 0);
  }
  return value;
}

/**
 * Child-element walk inside a container element's payload — used for
 * Info (timecode scale), Cues → CuePoint → CueTrackPositions. Every
 * child here has a known size by construction.
 */
function eachChild(
  buf: Uint8Array,
  start: number,
  end: number,
  visit: (id: number, dataStart: number, dataLen: number) => void,
): void {
  let pos = start;
  while (pos < end && pos < buf.length) {
    const element = readElementId(buf, pos);
    if (element === null) {
      return;
    }
    const size = readVint(buf, pos + element.length);
    if (size === null) {
      return;
    }
    const dataStart = pos + element.length + size.length;
    visit(element.id, dataStart, size.value);
    pos = dataStart + size.value;
  }
}

function parseCues(
  buf: Uint8Array,
  dataStart: number,
  dataLen: number,
  segDataStart: number,
): WebmCue[] {
  const cues: WebmCue[] = [];
  eachChild(buf, dataStart, dataStart + dataLen, (id, cStart, cLen) => {
    if (id !== WEBM_CUE_POINT) {
      return;
    }
    let time = 0;
    let offset = -1;
    eachChild(buf, cStart, cStart + cLen, (pid, pStart, pLen) => {
      if (pid === WEBM_CUE_TIME) {
        time = readUint(buf, pStart, pLen);
      }
      if (pid === WEBM_CUE_TRACK_POSITIONS) {
        eachChild(buf, pStart, pStart + pLen, (tid, tStart, tLen) => {
          if (tid === WEBM_CUE_CLUSTER_POSITION) {
            offset = readUint(buf, tStart, tLen);
          }
        });
      }
    });
    if (offset >= 0) {
      cues.push({ mediaMs: time, byte: segDataStart + offset });
    }
  });
  return cues;
}

/**
 * Cluster-id signature check used by every raw scan. Encoded media
 * payload can legitimately contain the four magic bytes (unknown-size
 * masters store arbitrary bytes), so a candidate must also parse as an
 * element header: a valid size vint AND a parseable element id right
 * after it (a real Cluster's first child — Timecode, SimpleBlock, ...).
 */
function isClusterAt(buf: Uint8Array, off: number): boolean {
  if (u32be(buf, off) !== WEBM_CLUSTER) {
    return false;
  }
  const size = readVint(buf, off + 4);
  if (size === null) {
    return false;
  }
  return readElementId(buf, off + 4 + size.length) !== null;
}

/**
 * Top-level EBML walk inside the Segment: each element is
 * `id(vint) + size(vint) + payload`. A Cluster's start offsets are
 * media-segment boundaries; a Cues element is parsed for the seek index.
 * `null` = the init region isn't complete yet — `carve` commits the
 * returned `segDataStart`/`scaleMs` for the life of the session, so the
 * walk must not resolve until either Info was fully parsed (the scale
 * is final) or the first Cluster boundary was walked (everything
 * before it, Info included or provably absent, was consumed).
 */
function webmWalk(buf: Uint8Array): WebmWalk | null {
  const boundaries: number[] = [];
  const cues: WebmCue[] = [];
  // Skip the EBML header element; the Segment contains the rest.
  const head = readElementId(buf, 0);
  if (head === null || head.id !== EBML_ID) {
    return null;
  }
  const headSize = readVint(buf, head.length);
  if (headSize === null || headSize.unknown) {
    return null;
  }
  let pos = head.length + headSize.length + headSize.value;
  const seg = readElementId(buf, pos);
  if (seg === null || seg.id !== WEBM_SEGMENT) {
    return null;
  }
  pos += seg.length;
  const segSize = readVint(buf, pos);
  if (segSize === null) {
    return null;
  }
  const segDataStart = pos + segSize.length;
  const segEnd =
    segSize.unknown === true
      ? buf.length
      : segDataStart + segSize.value;
  pos = segDataStart;

  let scaleMs = 1;
  let initStable = false;
  while (pos < segEnd && pos < buf.length) {
    const element = readElementId(buf, pos);
    if (element === null) {
      break;
    }
    const size = readVint(buf, pos + element.length);
    if (size === null) {
      break;
    }
    const dataStart = pos + element.length + size.length;
    if (element.id === WEBM_CLUSTER) {
      boundaries.push(pos);
      // The sequential walk reached the first media element — every
      // preceding element (Info included or provably absent) is
      // complete, so the committed metadata is final.
      initStable = true;
    }
    if (element.id === WEBM_INFO && !size.unknown) {
      eachChild(buf, dataStart, dataStart + size.value, (cid, cs, cl) => {
        if (cid === WEBM_TIMECODE_SCALE) {
          // Scale is in nanoseconds per timecode tick.
          const ns = readUint(buf, cs, cl);
          if (ns > 0) {
            scaleMs = ns / 1_000_000;
          }
        }
      });
      // Info fully inside the buffer → the timecode scale is final
      // even if nothing after it has arrived yet.
      if (dataStart + size.value <= buf.length) {
        initStable = true;
      }
    }
    if (element.id === WEBM_CUES && !size.unknown) {
      cues.push(
        ...parseCues(buf, dataStart, size.value, segDataStart),
      );
    }
    if (size.unknown) {
      // An open-ended element runs to its parent's end — a Cluster's
      // terminator is the next sibling Cluster. Rescan forward for the
      // next header-shaped cluster signature.
      let scan = dataStart;
      let found = -1;
      while (scan + 4 <= buf.length) {
        if (isClusterAt(buf, scan)) {
          found = scan;
          break;
        }
        scan += 1;
      }
      if (found === -1) {
        break;
      }
      pos = found;
      continue;
    }
    pos = dataStart + size.value;
  }
  if (!initStable) {
    return null;
  }
  return {
    boundaries,
    segDataStart,
    scaleMs,
    cues: cues.map((c) => ({ mediaMs: c.mediaMs * scaleMs, byte: c.byte })),
  };
}

// ---- mp4 box walker ------------------------------------------------------

type Mp4Box = { readonly type: string; readonly start: number; readonly size: number };

/** One top-level ISO-BMFF box; `size` includes the 8-byte header. */
function readBox(buf: Uint8Array, off: number): Mp4Box | null {
  if (off + 8 > buf.length) {
    return null;
  }
  const size = u32be(buf, off);
  const type = asciiType(buf, off + 4);
  if (size === 1) {
    // largesize — 64-bit; files this big still report a sane lower u32.
    if (off + 16 > buf.length) {
      return null;
    }
    const hi = u32be(buf, off + 8);
    const lo = u32be(buf, off + 12);
    return { type, start: off, size: hi * 0x1_0000_0000 + lo };
  }
  if (size === 0) {
    // size-0 box runs to EOF — non-seekable tail box.
    return { type, start: off, size: buf.length - off };
  }
  if (size < 8) {
    return null;
  }
  return { type, start: off, size };
}

/**
 * MP4 boundaries: each `moof` starts a media segment; a `styp` glues to
 * the following `moof`. A `mdat` reached with `moov` seen but no `moof`
 * is a non-fragmented file — the caller falls back to the range server.
 */
export type Mp4Walk =
  | { readonly kind: 'fragmented'; readonly boundaries: number[] }
  | { readonly kind: 'non-fragmented' }
  | { readonly kind: 'need-more' };

function mp4Walk(buf: Uint8Array): Mp4Walk {
  const boundaries: number[] = [];
  let pos = 0;
  let sawMoof = false;
  // A `styp` glues to the moof that immediately follows it — the
  // segment boundary anchors on the styp, not the moof.
  let pendingStyp = -1;
  while (pos + 8 <= buf.length) {
    const box = readBox(buf, pos);
    if (box === null) {
      return { kind: 'need-more' };
    }
    if (box.type === 'moof') {
      sawMoof = true;
      boundaries.push(pendingStyp >= 0 ? pendingStyp : pos);
      pendingStyp = -1;
    }
    if (box.type === 'mdat' && !sawMoof) {
      // Every media-data box in a fragmented file is preceded by its
      // moof — an mdat reached with no moof is non-fragmented media,
      // whatever order moov arrives in.
      return { kind: 'non-fragmented' };
    }
    if (box.type === 'styp') {
      // Segment-level boxes (sidx, prft, ...) may sit between the styp
      // and its moof — the anchor persists until a moof claims it.
      pendingStyp = pos;
    }
    pos += box.size;
  }
  // `ftyp`/`moov` alone prove nothing — only a moof (fragmented) or an
  // mdat reached without one (non-fragmented, returned above) decides.
  // Committing 'fragmented' early would lock a plain mp4 into MSE when
  // its mdat simply hasn't arrived in the ingest buffer yet.
  return sawMoof
    ? { kind: 'fragmented', boundaries }
    : { kind: 'need-more' };
}

// ---- the ingest carve -----------------------------------------------------

export type CarveResult =
  | {
      readonly kind: 'ok';
      readonly container: 'webm' | 'mp4';
      /** Byte offsets where media-segment appends may begin (ascending). */
      readonly boundaries: readonly number[];
      /** Webm Cues index — present once the Cues element was ingested. */
      readonly cues: readonly WebmCue[];
      /** Absolute offset of the Segment payload — cue anchor (webm). */
      readonly segDataStart: number;
      /** Segment timecode scale in ms (webm; 1 for mp4). */
      readonly scaleMs: number;
    }
  | { readonly kind: 'need-more' }
  | { readonly kind: 'unsupported' };

/**
 * Steady-state carving: the ingest buffer head is always a segment
 * boundary (a Cluster or moof box — the emit cursor only ever lands on
 * one). Walks sibling elements forward, collecting cluster/moof starts
 * and any Cues element it passes — used once the container is known;
 * `carve` is only for the initial file-head classification.
 */
export function boundaryScan(
  buf: Uint8Array,
  container: 'webm' | 'mp4',
  segDataStart: number,
  scaleMs: number,
): { readonly boundaries: number[]; readonly cues: WebmCue[] } {
  const boundaries: number[] = [];
  const cues: WebmCue[] = [];
  let pos = 0;
  if (container === 'webm') {
    while (pos < buf.length) {
      const element = readElementId(buf, pos);
      if (element === null) {
        break;
      }
      const size = readVint(buf, pos + element.length);
      if (size === null) {
        break;
      }
      const dataStart = pos + element.length + size.length;
      if (element.id === WEBM_CLUSTER) {
        boundaries.push(pos);
      }
      if (element.id === WEBM_SEGMENT && !size.unknown) {
        // Clusters are Segment CHILDREN — descend, never skip the box.
        pos = dataStart;
        continue;
      }
      if (element.id === WEBM_CUES && !size.unknown) {
        for (const cue of parseCues(buf, dataStart, size.value, segDataStart)) {
          cues.push({ mediaMs: cue.mediaMs * scaleMs, byte: cue.byte });
        }
      }
      if (size.unknown) {
        let scan = dataStart;
        let found = -1;
        while (scan + 4 <= buf.length) {
          if (isClusterAt(buf, scan)) {
            found = scan;
            break;
          }
          scan += 1;
        }
        if (found === -1) {
          break;
        }
        pos = found;
        continue;
      }
      pos = dataStart + size.value;
    }
    return { boundaries, cues };
  }
  let pendingStyp = -1;
  while (pos + 8 <= buf.length) {
    const box = readBox(buf, pos);
    if (box === null) {
      break;
    }
    if (box.type === 'moof') {
      boundaries.push(pendingStyp >= 0 ? pendingStyp : pos);
      pendingStyp = -1;
    }
    if (box.type === 'styp') {
      pendingStyp = pos;
    }
    pos += box.size;
  }
  return { boundaries, cues };
}

/**
 * After a byte-estimated seek the ingest starts mid-segment — scan for
 * the first segment boundary signature before carving. `-1` = none yet.
 */
export function resyncScan(
  buf: Uint8Array,
  container: 'webm' | 'mp4',
): number {
  if (container === 'webm') {
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (isClusterAt(buf, i)) {
        return i;
      }
    }
    return -1;
  }
  for (let i = 0; i + 8 <= buf.length; i++) {
    const type = asciiType(buf, i + 4);
    // A segment may start on its styp — both anchor the resync.
    if (type === 'moof' || type === 'styp') {
      const size = u32be(buf, i);
      if (size >= 8 && size <= 64 * 1024 * 1024) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Sniff + walk the ingest buffer. Returns `need-more` while the head of
 * the stream (init segment) hasn't fully arrived — the caller keeps
 * accumulating before carving.
 */
export function carve(buf: Uint8Array): CarveResult {
  const sn = sniff(buf);
  if (sn.kind === 'need-more') {
    return { kind: 'need-more' };
  }
  if (sn.kind === 'unsupported') {
    return { kind: 'unsupported' };
  }
  if (sn.container === 'webm') {
    const walk = webmWalk(buf);
    if (walk === null) {
      return { kind: 'need-more' };
    }
    return {
      kind: 'ok',
      container: 'webm',
      boundaries: walk.boundaries,
      cues: walk.cues,
      segDataStart: walk.segDataStart,
      scaleMs: walk.scaleMs,
    };
  }
  const walk = mp4Walk(buf);
  if (walk.kind === 'non-fragmented') {
    return { kind: 'unsupported' };
  }
  if (walk.kind === 'need-more') {
    return { kind: 'need-more' };
  }
  return {
    kind: 'ok',
    container: 'mp4',
    boundaries: walk.boundaries,
    cues: [],
    segDataStart: 0,
    scaleMs: 1,
  };
}
