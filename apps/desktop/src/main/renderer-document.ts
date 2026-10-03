import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * "Is this file: load the renderer document" is decided by resolved
 * identity, not spelling — `file:////…` produces a leading `//`,
 * interior `//` and `.` segments survive fileURLToPath verbatim, and
 * case variants name the same file on case-insensitive filesystems.
 * Every spelling must be served under the rewritten CSP: a raw string
 * compare would let a respelled path fall through to the on-disk
 * bytes' loose static CSP (index.ts).
 */
export function isRendererDocument(
  filePath: string,
  renderer: string,
  platform: string = process.platform,
): boolean {
  const canonical = (p: string): string => {
    let resolved: string;
    try {
      resolved = realpathSync(p);
    } catch {
      // A path that cannot be resolved still compares by normalized
      // spelling — it can only match the renderer if the renderer is
      // missing too, which the serve branch refuses anyway.
      resolved = resolve(p);
    }
    // darwin/win32 filesystems resolve case-insensitively.
    return platform === 'darwin' || platform === 'win32'
      ? resolved.toLowerCase()
      : resolved;
  };
  return canonical(filePath) === canonical(renderer);
}
