import type { ChunkHasher } from './transfer-policy.ts';

/**
 * Incremental SHA-256 (FIPS 180-4) in pure TS — no crypto globals
 * exist on every target (Hermes, plain node tests), so the download
 * checksum can't ride `crypto.subtle`. Streaming: `update` may be
 * called with arbitrary chunk sizes; `digest` is non-destructive so
 * callers can peek mid-stream.
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

class Sha256State {
  #h = new Uint32Array(8);
  #block = new Uint8Array(64);
  #blockLen = 0;
  #totalLen = 0;

  constructor() {
    this.#h.set([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
  }

  #compress(block: Uint8Array): void {
    const view = new DataView(block.buffer, block.byteOffset, 64);
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      // Index math keeps every read in bounds — noUncheckedIndexedAccess
      // still types them `number | undefined`.
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const w16 = w[i - 16] ?? 0;
      const w7 = w[i - 7] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w16 + s0 + w7 + s1) >>> 0;
    }
    const h = this.#h;
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i += 1) {
      const ki = K[i] ?? 0;
      const wi = w[i] ?? 0;
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + ki + wi) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) {
      h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0;
    }
  }

  update(bytes: Uint8Array): void {
    this.#totalLen += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(64 - this.#blockLen, bytes.length - offset);
      this.#block.set(bytes.subarray(offset, offset + take), this.#blockLen);
      this.#blockLen += take;
      offset += take;
      if (this.#blockLen === 64) {
        this.#compress(this.#block);
        this.#blockLen = 0;
      }
    }
  }

  /** Hex digest — does not consume state (peek is safe mid-stream). */
  digest(): string {
    const tail = new Sha256State();
    tail.#h.set(this.#h);
    tail.#block.set(this.#block);
    tail.#blockLen = this.#blockLen;
    tail.#totalLen = this.#totalLen;

    const bitLen = tail.#totalLen * 8;
    const padLen =
      tail.#blockLen < 56 ? 56 - tail.#blockLen : 120 - tail.#blockLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    // JS bit-ops are 32-bit — write the 64-bit length as two u32s.
    const view = new DataView(pad.buffer);
    view.setUint32(padLen, Math.floor(bitLen / 0x1_0000_0000), false);
    view.setUint32(padLen + 4, bitLen % 0x1_0000_0000, false);
    tail.update(pad);

    let hex = '';
    for (const word of tail.#h) {
      hex += word.toString(16).padStart(8, '0');
    }
    return hex;
  }
}

export function createSha256(): ChunkHasher {
  const state = new Sha256State();
  return {
    update: (bytes: Uint8Array): void => {
      state.update(bytes);
    },
    digest: (): string => state.digest(),
  };
}
