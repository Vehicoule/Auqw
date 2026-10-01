import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Whether the pane containing the consumer is the visible one. Context
 * — not a prop — because a hidden pane's element stays frozen on its
 * last build: only a context change reaches inside it. True outside a
 * keep-alive host (gallery, tests).
 */
const PaneVisibleContext = createContext(true);

export function usePaneVisible(): boolean {
  return useContext(PaneVisibleContext);
}

export type WorldPanesProps = {
  readonly keys: readonly string[];
  readonly activeKey: string;
  readonly renderPane: (key: string, active: boolean) => ReactNode;
};

/**
 * Keep-alive world panes: every visited tab stays mounted — the switch
 * flips `display` instead of unmounting/remounting the screen (the
 * cold-mount-per-switch was the tab-latency complaint). Hidden panes
 * get `inert` + `aria-hidden` so they can't take focus or pollute the
 * a11y tree while display:none.
 *
 * Panes mount lazily: on first paint only the active pane is built,
 * then a post-commit effect warms the rest — so a pane mounts off the
 * user's gesture, not on the switch. Elements are cached per key and
 * frozen while hidden; on reveal the pane re-renders through renderPane
 * so props that honestly changed (e.g. `active`) still propagate.
 *
 * DOM `autofocus` can't fire for a kept-alive pane (it mounted hidden),
 * so on each reveal the host focuses the pane's `[data-autofocus]`
 * element itself — the screen marks its input with that attribute when
 * it wants focus-on-show.
 */
export function WorldPanes({ keys, activeKey, renderPane }: WorldPanesProps) {
  const [warm, setWarm] = useState(false);
  useEffect(() => setWarm(true), []);
  const built = useRef(new Map<string, ReactNode>());
  const paneEls = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    const pane = paneEls.current.get(activeKey);
    pane
      ?.querySelector<HTMLElement>('[data-autofocus]')
      ?.focus({ preventScroll: true });
  }, [activeKey]);
  return (
    <>
      {keys.map((key) => {
        const active = key === activeKey;
        const prev = built.current.get(key);
        let element = prev;
        if (active || (warm && prev === undefined)) {
          element = renderPane(key, active);
          built.current.set(key, element);
        }
        return (
          <PaneVisibleContext.Provider key={key} value={active}>
            <div
              ref={(node) => {
                if (node === null) {
                  paneEls.current.delete(key);
                } else {
                  paneEls.current.set(key, node);
                }
              }}
              style={active ? { display: 'contents' } : { display: 'none' }}
              inert={!active}
              aria-hidden={active ? undefined : 'true'}
            >
              {element}
            </div>
          </PaneVisibleContext.Provider>
        );
      })}
      {/* A tab outside the pane keys still renders (never cached) so an
          unknown key can't blank the column. */}
      {keys.includes(activeKey) ? null : renderPane(activeKey, true)}
    </>
  );
}
