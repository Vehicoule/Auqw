/**
 * UTF-8 without TextEncoder/TextDecoder (lib: ES2023 — no DOM types).
 * Real UTF-8, not a mask: payloads and hashed ids may carry non-ASCII
 * characters and two strings that differ only above U+007F must map
 * differently. Lone surrogates encode as their own code point —
 * callers need determinism, not validity.
 */
export function utf8Encode(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const cp = input.codePointAt(i) ?? 0;
    if (cp > 0xffff) {
      i += 1; // low surrogate consumed with the pair
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 byte count without encoding — for size budgets. */
export function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const cp = input.codePointAt(i) ?? 0;
    if (cp > 0xffff) {
      i += 1;
    }
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Replacement-char decode — malformed bytes never throw. */
export function utf8Decode(bytes: Uint8Array): string {
  const cps: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let cp: number;
    let len: number;
    if (b0 < 0x80) {
      cp = b0;
      len = 1;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      cp = b0 & 0x1f;
      len = 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      cp = b0 & 0x0f;
      len = 3;
    } else if (b0 >= 0xf0 && b0 < 0xf8) {
      cp = b0 & 0x07;
      len = 4;
    } else {
      cps.push(0xfffd);
      i += 1;
      continue;
    }
    let valid = i + len <= bytes.length;
    if (valid) {
      for (let j = 1; j < len; j += 1) {
        const cont = bytes[i + j] ?? 0;
        if ((cont & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (cont & 0x3f);
      }
    }
    if (!valid) {
      cps.push(0xfffd);
      i += 1;
      continue;
    }
    cps.push(cp > 0x10ffff ? 0xfffd : cp);
    i += len;
  }
  let out = '';
  for (const cp of cps) {
    out += String.fromCodePoint(cp);
  }
  return out;
}
