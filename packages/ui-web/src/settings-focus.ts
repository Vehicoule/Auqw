/**
 * Keyboard focus recovery for destructive settings rows. A confirmed
 * removal deletes (or disables) the row that held focus, and the
 * browser drops focus back to the document. Pick the row that should
 * receive focus instead: the next still-focusable key after the
 * removed one, else the previous, else null — the caller falls back to
 * a stable container.
 */
export function focusTargetAfterRemoval(
  before: readonly string[],
  focusable: ReadonlySet<string>,
  removed: string,
): string | null {
  const at = before.indexOf(removed);
  if (at < 0) {
    return null;
  }
  return (
    before.slice(at + 1).find((key) => focusable.has(key)) ??
    before.slice(0, at).findLast((key) => focusable.has(key)) ??
    null
  );
}
