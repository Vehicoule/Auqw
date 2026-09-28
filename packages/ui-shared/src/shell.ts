/**
 * Shell-composition logic shared verbatim by the desktop and mobile
 * app shells: option tables, provider-slot routing tables, small
 * model helpers, the overlay screen-stack reducer, the serialized
 * settings write chain, and the lyrics-highlight position clock.
 * Per-platform pieces (camera scanner vs QR display, safe-area
 * insets, adaptive-theme source, the Overlay route union) stay as
 * injected seams in each shell — only platform-identical logic lives
 * here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppError,
  AttemptTrace,
  EntityPage,
  EntityRef,
  LyricsSheet,
  MatchReview,
  ProviderCapability,
  ProviderPort,
  Result,
  SearchState,
  Settings,
  SourceRef,
  TrackMetadata,
} from '@auqw/application';
import { t, type MessageId } from './i18n.ts';
import { errorText } from './error-text.ts';
import { formatClock, toSearchRowModel } from './view-models.ts';
import type {
  NavItemModel,
  SearchStateModel,
  TransferModel,
} from './view-models.ts';

// `performance.now()` is monotonic across system-clock adjustments.
// Consumers compile this source under their own tsconfig — some
// without DOM lib or node types — so the global is declared here.
declare const performance: { now(): number };

export const SEARCH_LIMIT = 25;
export const DIAGNOSTICS_LIMIT = 20;

export function navItems(): readonly NavItemModel[] {
  return [
    { key: 'home', label: t('nav.home') },
    { key: 'explore', label: t('nav.explore') },
    { key: 'library', label: t('nav.library') },
    { key: 'settings', label: t('nav.settings') },
  ];
}

export const THEME_ORDER = [
  'system',
  'adaptive',
  'dark',
  'light',
  'oled',
] as const;

export type ProviderPickerOption = {
  /** The settings value — a provider id, or 'auto' for auto-routing. */
  readonly key: string;
  readonly label: string;
  readonly detail?: string | null | undefined;
};

// Stream-quality tiers, kbps — inside the domain's 1–512 qualityKbps
// bound; 128 is the spec default (providers.md).
export function qualityOptions(): readonly ProviderPickerOption[] {
  return [
    { key: '64', label: '64 kbps' },
    { key: '96', label: '96 kbps' },
    { key: '128', label: '128 kbps', detail: t('optionDetail.default') },
    { key: '192', label: '192 kbps' },
    { key: '256', label: '256 kbps' },
    { key: '320', label: '320 kbps', detail: t('optionDetail.maximum') },
  ];
}

export function themeOptions(): readonly ProviderPickerOption[] {
  return [
    {
      key: 'system',
      label: t('settings.themeValue.system'),
      detail: t('optionDetail.themeSystem'),
    },
    {
      key: 'adaptive',
      label: t('settings.themeValue.adaptive'),
      detail: t('optionDetail.themeAdaptive'),
    },
    // 'tokyo night' is the color scheme's name, not UI copy.
    {
      key: 'dark',
      label: t('settings.themeValue.dark'),
      detail: 'tokyo night',
    },
    {
      key: 'light',
      label: t('settings.themeValue.light'),
      detail: t('optionDetail.themeLight'),
    },
    {
      key: 'oled',
      label: t('settings.themeValue.oled'),
      detail: t('optionDetail.themeOled'),
    },
  ];
}

export type Boot<TController> =
  | { readonly type: 'loading' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'ready'; readonly controller: TController };

export function toSearchModel(
  state: SearchState,
  playingRef: SourceRef | null = null,
): SearchStateModel {
  switch (state.type) {
    case 'idle':
      return {
        phase: 'idle',
        query: '',
        results: [],
        providerId: null,
        message: null,
        retryable: false,
      };
    case 'loading':
      return {
        phase: 'loading',
        query: state.query,
        results: [],
        providerId: null,
        message: null,
        retryable: false,
      };
    case 'empty':
      return {
        phase: 'empty',
        query: state.query,
        results: [],
        providerId: null,
        message: null,
        retryable: false,
      };
    case 'content':
      return {
        phase: state.page.items.length === 0 ? 'empty' : 'ready',
        query: state.query,
        results: state.page.items.map((meta, index) =>
          toSearchRowModel(meta, index, playingRef),
        ),
        providerId: null,
        message: errorText(state.refreshError),
        retryable: false,
      };
    case 'error': {
      const unavailable =
        state.error.kind === 'unavailable' ||
        state.error.kind === 'auth-required';
      return {
        phase: unavailable ? 'unavailable' : 'error',
        query: state.query,
        results: [],
        providerId: null,
        message: errorText(state.error),
        retryable: true,
      };
    }
  }
}

export function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return t('home.greeting.night');
  if (h < 12) return t('home.greeting.morning');
  if (h < 18) return t('home.greeting.afternoon');
  return t('home.greeting.evening');
}

export function attemptLabel(trace: AttemptTrace): string {
  return t('settings.diag.attemptLabel', {
    requestId: trace.requestId,
    steps: trace.steps,
    httpCalls: trace.httpCalls,
    elapsed: formatClock(trace.elapsedMs),
  });
}

/** A pushed route on the shell's screen stack. */
export type OverlayEntry<O> = {
  readonly key: string;
  readonly overlay: O;
};

export const entityRefKey = (ref: EntityRef): string =>
  `${ref.provider}:${ref.kind}:${ref.id}`;

export type EntityFetch = {
  readonly ref: EntityRef;
  readonly page: EntityPage | null;
  readonly error: AppError | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
};

export type LyricsFetch = {
  readonly recordingId: string;
  readonly sheet: LyricsSheet | null;
  readonly error: AppError | null;
  readonly loading: boolean;
};

export type ReviewFetch = {
  readonly reviews: readonly MatchReview[] | null;
  readonly error: AppError | null;
};

export type ActionTarget =
  | { readonly kind: 'recording'; readonly recordingId: string }
  | { readonly kind: 'metadata'; readonly meta: TrackMetadata };

// The settings provider slots and the capabilities each one routes
// by — a picker only ever lists providers that declared the slot's
// capability (manifest-derived, via ProviderPort.capabilities).
export type ProviderSlot =
  | 'catalogProvider'
  | 'playbackProvider'
  | 'lyricsProvider'
  | 'radioProvider';

export const SLOT_CAPABILITIES: Record<
  ProviderSlot,
  readonly ProviderCapability[]
> = {
  catalogProvider: ['catalog.search'],
  playbackProvider: ['playback.resolve'],
  lyricsProvider: ['lyrics.synced', 'lyrics.plain'],
  radioProvider: ['radio.seed'],
};

export const SLOT_LABEL_IDS: Record<ProviderSlot, MessageId> = {
  catalogProvider: 'settings.catalogProvider',
  playbackProvider: 'settings.playbackProvider',
  lyricsProvider: 'settings.lyricsProvider',
  radioProvider: 'settings.radioProvider',
};

// Lyrics and radio are nullable overrides — 'auto' returns routing
// to capability declaration; the required slots never offer it.
export const OPTIONAL_SLOTS: ReadonlySet<ProviderSlot> = new Set([
  'lyricsProvider',
  'radioProvider',
]);

export type ProviderPickerModel = {
  readonly title: string;
  readonly options: readonly ProviderPickerOption[];
  readonly selectedKey: string;
};

/**
 * The capability-gated provider options for one settings slot — only
 * providers that declared the slot's capability reach `options`, and
 * nullable slots lead with the 'auto' auto-routing option.
 */
export function providerPickerModel(
  slot: ProviderSlot | null,
  providers: readonly ProviderPort[],
  settings: Settings,
): ProviderPickerModel | null {
  if (slot === null) {
    return null;
  }
  const required = SLOT_CAPABILITIES[slot];
  const options = providers
    .filter((provider) =>
      required.some((capability) =>
        provider.capabilities.includes(capability),
      ),
    )
    .map((provider) => ({
      key: provider.id,
      label: provider.id,
      detail: provider.capabilities.join(' · '),
    }));
  const selected = settings[slot];
  return {
    title: t(SLOT_LABEL_IDS[slot]),
    options: OPTIONAL_SLOTS.has(slot)
      ? [
          {
            key: 'auto',
            label: t('settings.value.auto'),
            detail: t('optionDetail.autoRoute'),
          },
          ...options,
        ]
      : options,
    selectedKey: selected ?? 'auto',
  };
}

export function formatBytes(bytes: number, free: number): string {
  const gb = (n: number) =>
    n >= 1e9
      ? `${(n / 1e9).toFixed(1)} gb`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(0)} mb`
        : n === 0
          ? '0 kb'
          : `${Math.max(1, Math.round(n / 1e3))} kb`;
  return t('storage.usage', { used: gb(bytes), free: gb(free) });
}

export const IDLE_TRANSFER: TransferModel = {
  exportPhase: 'idle',
  exportDetail: null,
  importPhase: 'idle',
  importDetail: null,
  preview: null,
};

/**
 * Session ops resolve typed errors rather than throwing — a dropped
 * Result is a silent no-op. Keep failures observable: the console
 * logs the taxonomy `kind` (messages can carry signed URLs, so they
 * stay out of logs too), and a transient toast carries the humanized
 * reason. `toastSink` is
 * installed once by Main — reportResult is called from callbacks all
 * over the shell, so a sink avoids threading the setter through
 * every dependency list.
 */
let toastSink: ((text: string) => void) | null = null;

export function setToastSink(
  sink: ((text: string) => void) | null,
): void {
  toastSink = sink;
}

export function reportResult(
  action: MessageId,
  result: Result<unknown>,
): void {
  if (!result.ok) {
    // Log the typed kind only — an error message crossing a bridge can
    // embed a signed URL or token that has no business in renderer logs.
    console.warn(`[ui] ${action} failed: ${result.error.kind}`);
    // The toast carries the humanized reason, never the raw kind or
    // message; silent (disposal) outcomes don't toast at all.
    const detail = errorText(result.error);
    if (detail !== null) {
      toastSink?.(
        t('toast.failed', {
          action: t(action),
          detail,
        }),
      );
    }
  }
}

/**
 * Lyrics-highlight position clock: engine ticks arrive ~1Hz (mobile)
 * to ~4Hz (desktop), so between ticks the raw snapshot position sits
 * stale and the active line lands visibly late. While `active`, the
 * last engine position is extrapolated forward at a fixed cadence —
 * each fresh engine position re-anchors the clock. `generation`
 * re-anchors without a position change: a seek landing on the last
 * reported tick would otherwise keep extrapolating from the pre-seek
 * anchor. The anchor clock is `performance.now()` — `Date.now()`
 * follows system-clock adjustments, which would jump the highlight.
 * Anchoring is keyed to position/generation/transport: a fresh
 * position or a seek re-anchors, and a `playing` transition re-anchors
 * too — the anchor's clock must freeze with the pause, otherwise
 * resume would count the paused wall-time as elapsed playback.
 * Re-entering the pane (`visible` flipping) must NOT re-anchor: the
 * anchor keeps the tick's real arrival time, so the elapsed fraction
 * since the last engine event is preserved instead of discarded.
 * Ticking only while the lyrics pane is live keeps the periodic
 * re-render off the idle path.
 */
export function useSmoothedPosition(
  positionMs: number,
  playing: boolean,
  visible: boolean,
  generation: number,
): number {
  const anchor = useRef({ ms: positionMs, at: performance.now() });
  const [smoothMs, setSmoothMs] = useState(positionMs);
  useEffect(() => {
    anchor.current = { ms: positionMs, at: performance.now() };
    setSmoothMs(positionMs);
  }, [positionMs, generation, playing]);
  useEffect(() => {
    if (!playing || !visible) {
      return undefined;
    }
    const tick = () => {
      const a = anchor.current;
      setSmoothMs(a.ms + (performance.now() - a.at));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [playing, visible]);
  return smoothMs;
}

export type SerializedWrite<T extends object> = (
  patch: Partial<T> | ((latest: T) => Partial<T>),
) => Promise<Result<unknown>>;

/**
 * Serialized write chain: every write lands in submission order, and
 * each MERGES ITS PATCH onto the latest committed base at execution
 * time — `write` persists a complete snapshot, so replaying a base
 * captured at call time would revert whatever landed in between.
 * `readCommitted` — not React state — supplies the merge base, so
 * writes that never entered the chain (a boot repair, a sync-applied
 * change) are covered; `readLive` is the last externally observed
 * value, the fallback when `readCommitted` has nothing yet (a
 * not-ready snapshot), and `commitLive` records each committed write.
 * A function patch reads the committed base at execution time —
 * the only safe shape for read-modify-write toggles: two quick
 * taps must flip twice, not write the same inverse twice.
 * The chain survives a failed write — the next submission still runs.
 */
export function createSerializedWrite<T extends object>(
  write: (next: T) => Promise<Result<unknown>>,
  readCommitted: () => T | null,
  readLive: () => T,
  commitLive: (next: T) => void,
): SerializedWrite<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return (patch) => {
    const run = chain.then(() => {
      const base = readCommitted() ?? readLive();
      const next = {
        ...base,
        ...(typeof patch === 'function' ? patch(base) : patch),
      };
      return write(next).then((result) => {
        if (result.ok) {
          commitLive(next);
        }
        return result;
      });
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * The shell-facing hook: owns the live-value cell and binds the chain
 * to the caller's latest write/readCommitted callbacks.
 */
export function useSerializedWrite<T extends object>(
  write: (next: T) => Promise<Result<unknown>>,
  readCommitted: () => T | null,
  live: T,
): SerializedWrite<T> {
  const latestRef = useRef(live);
  const io = useRef({ write, readCommitted });
  useEffect(() => {
    io.current = { write, readCommitted };
  });
  useEffect(() => {
    latestRef.current = live;
  }, [live]);
  const [submit] = useState(() =>
    createSerializedWrite<T>(
      (next) => io.current.write(next),
      () => io.current.readCommitted(),
      () => latestRef.current,
      (next) => {
        latestRef.current = next;
      },
    ),
  );
  return submit;
}

export type OverlayStack<O> = {
  readonly stack: readonly OverlayEntry<O>[];
  readonly top: O | null;
  readonly push: (next: O) => void;
  readonly reset: (next: O) => void;
  readonly close: () => void;
  readonly dismiss: (key: string) => void;
  readonly clear: () => void;
};

export type OverlayCommand<O> =
  | { readonly type: 'push'; readonly key: string; readonly overlay: O }
  | { readonly type: 'reset'; readonly key: string; readonly overlay: O }
  | { readonly type: 'close' }
  | { readonly type: 'dismiss'; readonly key: string }
  | { readonly type: 'clear' };

/**
 * The overlay screen-stack reducer: `push`/`reset` carry a key minted
 * by the caller (call order survives React batching), `close` pops
 * the top route — every screen's own back affordance — and `dismiss`
 * removes a screen and all above it (a no-op on a stale key).
 */
export function overlayReducer<O>(
  stack: readonly OverlayEntry<O>[],
  command: OverlayCommand<O>,
): readonly OverlayEntry<O>[] {
  switch (command.type) {
    case 'push':
      return [...stack, { key: command.key, overlay: command.overlay }];
    case 'reset':
      return [{ key: command.key, overlay: command.overlay }];
    case 'close':
      return stack.slice(0, -1);
    case 'dismiss': {
      const index = stack.findIndex((entry) => entry.key === command.key);
      return index === -1 ? stack : stack.slice(0, index);
    }
    case 'clear':
      return [];
  }
}

/**
 * Library-world overlay stack: pushed routes — collection list,
 * playlist editor, provider entity page — rendered as push screens
 * above the nav shell. `clear` empties the stack; shells that keep
 * per-route fetch state clear it alongside (entity pages keep a fetch
 * per ref so popping back to a deeper screen restores its loaded
 * content).
 */
export function useOverlayStack<O>(): OverlayStack<O> {
  const [stack, setStack] = useState<readonly OverlayEntry<O>[]>([]);
  const counter = useRef(0);
  const push = useCallback((next: O) => {
    const key = `ov-${(counter.current += 1)}`;
    setStack((stack) =>
      overlayReducer(stack, { type: 'push', key, overlay: next }),
    );
  }, []);
  const reset = useCallback((next: O) => {
    const key = `ov-${(counter.current += 1)}`;
    setStack((stack) =>
      overlayReducer(stack, { type: 'reset', key, overlay: next }),
    );
  }, []);
  /** Pop the top route — every screen's own back affordance. */
  const close = useCallback(() => {
    setStack((stack) => overlayReducer(stack, { type: 'close' }));
  }, []);
  /** Screen-stack dismissal removes a screen and all above it. */
  const dismiss = useCallback((key: string) => {
    setStack((stack) => overlayReducer(stack, { type: 'dismiss', key }));
  }, []);
  const clear = useCallback(() => {
    setStack((stack) => overlayReducer(stack, { type: 'clear' }));
  }, []);
  const top = stack[stack.length - 1]?.overlay ?? null;
  return { stack, top, push, reset, close, dismiss, clear };
}
