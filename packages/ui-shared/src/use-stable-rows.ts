import { useRef } from 'react';

/**
 * Referential stability for list `data`: controllers re-map their
 * model rows every render (fresh bound callbacks), so a ticking
 * parent hands the list a new array per pass — VirtualizedList is a
 * PureComponent, and each `componentDidUpdate` re-arms a batched
 * cell-update setState; under playback-rate ticking one of those
 * landing inside a publish flush chains nested updates past React's
 * 'Maximum update depth exceeded' cap.
 *
 * While every row's picked content ref is identical the previous
 * array is served instead — the wrapper rows' own callbacks only go
 * stale when a picked model changes, which is exactly when a fresh
 * array is built. Pick the wrapped model (`.row`, `.card`), never the
 * wrapper itself: a pick that misses content drift serves stale rows.
 */
export function useStableRows<T, C>(
  rows: readonly T[],
  pick: (row: T) => C,
): readonly T[] {
  const ref = useRef(rows);
  const prev = ref.current;
  if (
    prev.length !== rows.length ||
    rows.some((row, i) => pick(row) !== pick(prev[i] as T))
  ) {
    ref.current = rows;
  }
  return ref.current;
}
