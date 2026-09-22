// Keyboard interaction logic for the desktop chrome — pure functions,
// unit-tested directly; components wire them to DOM key events.
//
// Conventions (the design doc's desktop pass):
//   ArrowUp/ArrowDown (+ Home/End) move the roving row selection
//   Enter or Space activates the focused row (the tap's equivalent —
//   on a track row that is the play toggle)
//   Escape dismisses the topmost sheet
//   '/' focuses the search field, unless an editable element holds it

export type RowKeyAction =
  | { readonly type: 'move'; readonly index: number }
  | { readonly type: 'activate' }
  | { readonly type: 'context' }
  | null;

function clampIndex(index: number, count: number): number {
  if (count <= 0) {
    return -1;
  }
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * Map a key on a track-list row to an action. The index is clamped,
 * never wrapped — a list that wraps focus reads as a bug on desktop.
 * Returns null for keys the row doesn't own so the event can bubble
 * (e.g. Escape reaching the sheet above the list).
 */
export function rowKeyAction(
  key: string,
  index: number,
  count: number,
): RowKeyAction {
  switch (key) {
    case 'ArrowUp':
      return { type: 'move', index: clampIndex(index - 1, count) };
    case 'ArrowDown':
      return { type: 'move', index: clampIndex(index + 1, count) };
    case 'Home':
      return { type: 'move', index: count > 0 ? 0 : -1 };
    case 'End':
      return { type: 'move', index: count > 0 ? count - 1 : -1 };
    case 'Enter':
    case ' ':
      return index >= 0 && index < count ? { type: 'activate' } : null;
    case 'ContextMenu':
      return index >= 0 && index < count ? { type: 'context' } : null;
    default:
      return null;
  }
}

/** Initial index for a list about to take roving focus. */
export function initialRovingIndex(currentIndex: number, count: number): number {
  if (count <= 0) {
    return -1;
  }
  return clampIndex(currentIndex < 0 ? 0 : currentIndex, count);
}

/** Escape is the only key a sheet owns; everything else falls through. */
export function sheetKeyAction(key: string): 'close' | null {
  return key === 'Escape' ? 'close' : null;
}

/** The ±10s seek step on Left/Right, clamped to the track bounds. */
export function seekStepMs(
  key: string,
  positionMs: number,
  durationMs: number | null,
): number | null {
  if (durationMs === null || durationMs <= 0) {
    return null;
  }
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, positionMs - 10_000);
    case 'ArrowRight':
      return Math.min(durationMs, positionMs + 10_000);
    default:
      return null;
  }
}

/** True for elements that accept text — '/' must not steal their keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined') {
    return false;
  }
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export type GlobalKeyAction = 'focus-search' | null;

/** '/' opens search from anywhere outside an editable element. */
export function globalKeyAction(
  key: string,
  target: EventTarget | null,
): GlobalKeyAction {
  if (key === '/' && !isEditableTarget(target)) {
    return 'focus-search';
  }
  return null;
}
