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
  PlaylistEntry,
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

const NAV_KEYS = ['home', 'explore', 'library', 'settings'] as const;

export function navItems(): readonly NavItemModel[] {
  return NAV_KEYS.map((key) => ({ key, label: t(`nav.${key}`) }));
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
const QUALITY_TIERS: readonly (readonly [number, MessageId?])[] = [
  [64],
  [96],
  [128, 'optionDetail.default'],
  [192],
  [256],
  [320, 'optionDetail.maximum'],
];

export function qualityOptions(): readonly ProviderPickerOption[] {
  return QUALITY_TIERS.map(([kbps, detail]) => ({
    key: `${kbps}`,
    label: `${kbps} kbps`,
    ...(detail === undefined ? {} : { detail: t(detail) }),
  }));
}

const THEME_DETAIL: Record<
  Exclude<(typeof THEME_ORDER)[number], 'dark'>,
  MessageId
> = {
  system: 'optionDetail.themeSystem',
  adaptive: 'optionDetail.themeAdaptive',
  light: 'optionDetail.themeLight',
  oled: 'optionDetail.themeOled',
};

export function themeOptions(): readonly ProviderPickerOption[] {
  return THEME_ORDER.map((key) => ({
    key,
    label: t(`settings.themeValue.${key}`),
    // 'tokyo night' is the color scheme's name, not UI copy.
    detail: key === 'dark' ? 'tokyo night' : t(THEME_DETAIL[key]),
  }));
}

export type Boot<TController> =
  | { readonly type: 'loading' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'ready'; readonly controller: TController };

export function toSearchModel(
  state: SearchState,
  playingRef: SourceRef | null = null,
  playlistEntries: readonly PlaylistEntry[] = [],
): SearchStateModel {
  const inPlaylist = new Set(
    playlistEntries
      .map((entry) =>
        entry.selectedRef === null
          ? null
          : `${entry.selectedRef.provider}:${entry.selectedRef.kind}:${entry.selectedRef.id}`,
      )
      .filter((key): key is string => key !== null),
  );
  const base = {
    query: state.type === 'idle' ? '' : state.query,
    results: [],
    providerId: null,
    message: null,
    retryable: false,
  };
  switch (state.type) {
    case 'idle':
    case 'loading':
    case 'empty':
      return { ...base, phase: state.type };
    case 'content':
      return {
        ...base,
        phase: state.page.items.length === 0 ? 'empty' : 'ready',
        results: state.page.items.map((meta, index) =>
          toSearchRowModel(
            meta,
            index,
            playingRef,
            inPlaylist.has(
              `${meta.sourceRef.provider}:${meta.sourceRef.kind}:${meta.sourceRef.id}`,
            ),
          ),
        ),
        message: errorText(state.refreshError),
      };
    case 'error': {
      const unavailable =
        state.error.kind === 'unavailable' ||
        state.error.kind === 'auth-required';
      return {
        ...base,
        phase: unavailable ? 'unavailable' : 'error',
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
// Lyrics and radio are nullable overrides — 'auto' returns routing
// to capability declaration; the required slots never offer it.
export type ProviderSlot =
  | 'catalogProvider'
  | 'playbackProvider'
  | 'lyricsProvider'
  | 'radioProvider';

export const SLOT_META: Record<
  ProviderSlot,
  {
    readonly label: MessageId;
    readonly capabilities: readonly ProviderCapability[];
    readonly optional: boolean;
  }
> = {
  catalogProvider: {
    label: 'settings.catalogProvider',
    capabilities: ['catalog.search'],
    optional: false,
  },
  playbackProvider: {
    label: 'settings.playbackProvider',
    capabilities: ['playback.resolve'],
    optional: false,
  },
  lyricsProvider: {
    label: 'settings.lyricsProvider',
    capabilities: ['lyrics.synced', 'lyrics.plain'],
    optional: true,
  },
  radioProvider: {
    label: 'settings.radioProvider',
    capabilities: ['radio.seed'],
    optional: true,
  },
};

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
  const meta = SLOT_META[slot];
  const options = providers
    .filter((provider) =>
      meta.capabilities.some((capability) =>
        provider.capabilities.includes(capability),
      ),
    )
    .map((provider) => ({
      key: provider.id,
      label: provider.id,
      detail: provider.capabilities.join(' · '),
    }));
  return {
    title: t(meta.label),
    options: meta.optional
      ? [
          {
            key: 'auto',
            label: t('settings.value.auto'),
            detail: t('optionDetail.autoRoute'),
          },
          ...options,
        ]
      : options,
    selectedKey: settings[slot] ?? 'auto',
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
// Notices can fire before the shell installs its sink (a post-
// install "updated" receipt lands during Main's first render,
// before the effect that sets the sink) — a pre-sink line queues
// instead of vanishing, flushed the moment a sink attaches.
let queuedNotices: string[] = [];
const NOTICE_QUEUE_MAX = 8;

export function setToastSink(
  sink: ((text: string) => void) | null,
): void {
  toastSink = sink;
  if (sink !== null && queuedNotices.length > 0) {
    const pending = queuedNotices;
    queuedNotices = [];
    for (const text of pending) {
      sink(text);
    }
  }
}

/** A non-error line through the same toast sink — sparingly used
    (post-install "updated" receipt), errors still go reportResult. */
export function notify(text: string): void {
  if (toastSink !== null) {
    toastSink(text);
    return;
  }
  if (queuedNotices.length < NOTICE_QUEUE_MAX) {
    queuedNotices.push(text);
  }
}

export function reportResult(
  action: MessageId,
  result: Result<unknown>,
): void {
  if (result.ok) {
    return;
  }
  // Log the typed kind only — an error message crossing a bridge can
  // embed a signed URL or token that has no business in renderer logs.
  console.warn(`[ui] ${action} failed: ${result.error.kind}`);
  // Teardown suppression lives at this ops-level funnel — 'cancelled'
  // can also be a provider's real verdict, so surfaces don't silence
  // it, but an op torn down by a newer intent never toasts.
  if (result.error.kind === 'cancelled' || result.error.kind === 'superseded') {
    return;
  }
  // The toast carries the humanized reason, never the raw kind or
  // message; silent (disposal) outcomes don't toast at all.
  const detail = errorText(result.error);
  if (detail !== null) {
    toastSink?.(t('toast.failed', { action: t(action), detail }));
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
  const mintKey = (): string => `ov-${(counter.current += 1)}`;
  const run = useCallback(
    (command: OverlayCommand<O>) =>
      setStack((s) => overlayReducer(s, command)),
    [],
  );
  const push = useCallback(
    (next: O) => run({ type: 'push', key: mintKey(), overlay: next }),
    [],
  );
  const reset = useCallback(
    (next: O) => run({ type: 'reset', key: mintKey(), overlay: next }),
    [],
  );
  const close = useCallback(() => run({ type: 'close' }), []);
  const dismiss = useCallback((key: string) => run({ type: 'dismiss', key }), []);
  const clear = useCallback(() => run({ type: 'clear' }), []);
  const top = stack[stack.length - 1]?.overlay ?? null;
  return { stack, top, push, reset, close, dismiss, clear };
}
