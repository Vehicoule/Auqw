import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Artwork,
  DownloadIconButton,
  Icon,
  IconButton,
  Pressable,
  PlayPauseIcon,
  Segment,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconButtonProps } from './primitives.tsx';
import { WaveformSeek } from './progress.tsx';
import { useOverlayDismiss, useOverlayFocus } from './stack.tsx';
import { QueueList } from './queue-list.tsx';
import { QueueScreen } from './queue-screen.tsx';
import type { QueueScreenProps } from './queue-screen.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import { scaledArtworkUrl, t } from '@auqw/ui-shared';
import type {
  DownloadChip,
  LyricsModel,
  PlayerModel,
  QueueModel,
  RadioModel,
  StageMode,
  WaveformPeak,
} from '@auqw/ui-shared';
import {
  downloadButtonView,
  lyricsHeaderView,
  lyricsPaneView,
  queueMetaLabel,
  queueOriginView,
  queueReorderButton,
  radioRowView,
  stageMetaView,
  STAGE_MODE_ORDER,
  stageModeTabs,
  useStageMode,
  useTransportView,
  type RadioRowView,
  type StageScreenHandlers,
} from '@auqw/ui-shared/controllers';

export type TransportProps = {
  readonly variant?: 'm3e' | 'ios' | undefined;
  readonly status: PlayerModel['status'];
  /**
   * The user's play/pause intent (queue mode) — the glyph and action
   * follow it even when transport is 'preparing' mid-retry, so pause
   * still wins while no handle exists.
   */
  readonly intentPlaying: PlayerModel['intentPlaying'];
  readonly liked: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  /** Shuffle toggle state — the cursor walks a dealt play order. */
  readonly shuffle?: boolean | undefined;
  readonly onToggleShuffle?: (() => void) | undefined;
  /** Current repeat mode — off / all / one from the player port. */
  readonly repeat?: 'off' | 'all' | 'one' | undefined;
  readonly onCycleRepeat?: (() => void) | undefined;
};

// Transport buttons come in two builds — 44/18 'side' flanks and
// 44/20 'main' prev/next — over the shared IconButton. The box size
// lives on the classes (not the size prop) so the narrow-stage
// container query in styles.css can shrink them below the floor.
function TBtn({
  main = false,
  ...props
}: Omit<IconButtonProps, 'size' | 'iconSize' | 'className'> & {
  readonly main?: boolean | undefined;
}) {
  return (
    <IconButton
      {...props}
      iconSize={main ? 20 : 18}
      className={`uw-transport__${main ? 'main' : 'side'}`}
    />
  );
}

// The desktop transport keeps the m3e layout (raised main pill,
// accent play slab) — the ios glass variant exists for parity. The
// row is pure transport `like · shuffle · prev · play · next ·
// repeat` on both platforms; ownership actions (download, add) live
// on the metadata line above it.
export function TransportControls({
  variant = 'm3e',
  ...input
}: TransportProps) {
  const view = useTransportView(input);
  const playColor =
    variant === 'm3e' ? 'var(--canvas)' : 'var(--text-bright)';
  return (
    <div className={`uw-transport uw-transport--${variant}`} role="group" aria-label={view.a11yLabel}>
      <TBtn
        icon={view.like.icon}
        color={view.like.liked ? 'var(--liked)' : 'var(--text-secondary)'}
        ariaLabel={view.like.a11yLabel}
        active={view.like.active}
        onPress={view.like.onPress}
      />
      <TBtn
        main
        icon={view.previous.icon}
        color="var(--text-primary)"
        ariaLabel={view.previous.a11yLabel}
        disabled={view.previous.disabled}
        onPress={view.previous.onPress}
      />
      <Pressable
        onPress={view.play.onPress}
        ariaLabel={view.play.a11yLabel}
        ariaPressed={view.play.pressed}
        className="uw-transport__play"
      >
        {view.busy ? (
          <Spinner size={24} color={playColor} />
        ) : (
          <PlayPauseIcon playing={view.playing} size={24} color={playColor} />
        )}
      </Pressable>
      <TBtn
        main
        icon={view.next.icon}
        color="var(--text-primary)"
        ariaLabel={view.next.a11yLabel}
        disabled={view.next.disabled}
        onPress={view.next.onPress}
      />
      <TBtn
        icon={view.repeat.icon}
        color={view.repeat.active ? 'var(--accent)' : 'var(--text-secondary)'}
        ariaLabel={view.repeat.a11yLabel}
        disabled={view.repeat.disabled}
        active={view.repeat.active}
        onPress={view.repeat.onPress}
      />
    </div>
  );
}

export function ModeSegment({
  mode,
  onSelect,
}: {
  readonly mode: StageMode;
  readonly onSelect?: ((mode: StageMode) => void) | undefined;
}) {
  const tabs = stageModeTabs(STAGE_MODE_ORDER, mode, onSelect);
  // The floating segment is always dark-scoped — it overlays artwork
  // or a flat stage in every mode, and the pane scheme's fg08 pill
  // would wash out grey-on-grey on light stages.
  return (
    <Segment
      variant="float"
      className="t-dark"
      ariaLabel={t('stage.modeTabsA11y')}
      tabs={tabs}
      iconSize={12}
    />
  );
}

export type NowPlayingScreenProps = StageScreenHandlers & {
  readonly player: PlayerModel;
  readonly mode?: StageMode | undefined;
  readonly queue?: QueueModel | undefined;
  readonly lyrics?: LyricsModel | undefined;
  readonly radio?: RadioModel | undefined;
  /** Provider the radio seed would arm with — sizes the chip's ghost
      slot before the tail exists. */
  readonly radioSeedProvider?: string | null | undefined;
  readonly queueReordering?: boolean | undefined;
  readonly queueScrollEnabled?: boolean | undefined;
  readonly shuffle?: boolean | undefined;
  readonly repeat?: 'off' | 'all' | 'one' | undefined;
  readonly download?: DownloadChip | null | undefined;
  /** Real measured peaks for the playing recording; null/undefined
   * renders the flat placeholder (pending state and failure
   * fallback). */
  readonly peaks?: readonly WaveformPeak[] | null | undefined;
};

// Immersive player backdrop (the native StageSheet's treatment ported
// to DOM): full-bleed artwork, a statically blurred copy revealed by an
// alpha-gradient mask so the frost fades in under the bottom cluster
// only — one CSS blur pass, no hard edge — and a dark scrim gradient
// over the top for text contrast. The `t-dark` class on the stage
// re-scopes every token for this subtree, matching the sheet's nested
// dark ThemeProvider.
function StageBackdrop({
  url,
  onError,
}: {
  readonly url: string;
  readonly onError: () => void;
}) {
  // The backdrop blurs and dims behind the cluster — 1024px covers a
  // retina-width stage; provider full-res would decode 10–35 MB here
  // for zero visible gain. A rewrite that fails loads falls back to
  // the original URL before reporting the error outward.
  const [src, setSrc] = useState(() => scaledArtworkUrl(url, 1024));
  useEffect(() => {
    setSrc(scaledArtworkUrl(url, 1024));
  }, [url]);
  return (
    <div className="uw-stage__backdrop" aria-hidden="true">
      {['art', 'frost'].map((layer) => (
        <img
          key={layer}
          className={`uw-stage__backdrop-${layer}`}
          src={src}
          alt=""
          onError={src !== url ? () => setSrc(url) : onError}
        />
      ))}
      <div className="uw-stage__backdrop-scrim" />
    </div>
  );
}

// The radio pill's inline action — 'stop' when armed, 'start' otherwise.
function RadioAction({
  action,
  color,
  hidden = false,
}: {
  readonly action: RadioRowView['start'];
  readonly color: 'primary' | 'accent';
  readonly hidden?: boolean | undefined;
}) {
  return (
    <Pressable
      onPress={hidden ? undefined : action.onPress}
      ariaLabel={action.a11yLabel}
      className={`uw-stage__radio-action${hidden ? ' uw-stage__radio-action--hidden' : ''}`}
    >
      <Text variant="metadata" color={color}>
        {action.label}
      </Text>
    </Pressable>
  );
}

export function NowPlayingScreen({
  player,
  mode,
  queue,
  lyrics,
  radio,
  queueReordering = false,
  queueScrollEnabled = true,
  download = null,
  onDownload,
  onAddToPlaylist,
  onTrackMenu,
  onStopPlayback,
  onRecovery,
  onSeek,
  peaks,
  onRetryLyrics,
  onStartRadio,
  radioSeedProvider,
  onStopRadio,
  onModeChange,
  onPressQueueItem,
  onQueueRowIntent,
  onRemoveQueueItem,
  onClearUpcoming,
  onOpenQueueContext,
  onToggleQueueReorder,
  onMoveQueueItem,
  onMoveQueueItemTo,
  ...transport
}: NowPlayingScreenProps) {
  const { activeMode, select } = useStageMode(mode, onModeChange);
  // All three panes stay mounted — display:none preserves scroll and
  // fetched state, so a mode switch never remounts a list.
  const paneHidden = (m: StageMode) => ({
    display: m === activeMode ? 'contents' : 'none',
  });
  const meta = stageMetaView(player);
  const lyricsHeader = lyricsHeaderView(player, lyrics);
  const lyricsPane = useMemo(
    () => lyricsPaneView(lyrics, onRetryLyrics),
    [lyrics, onRetryLyrics],
  );
  const radioRow = radioRowView(
    radio,
    onStartRadio,
    onStopRadio,
    radioSeedProvider,
  );
  const reorder = queueReorderButton(queueReordering, onToggleQueueReorder);
  const queueOrigin = queueOriginView(
    queue?.origin ?? null,
    onOpenQueueContext,
  );
  const queueMeta = queue === undefined ? null : queueMetaLabel(queue);
  const downloadBtn =
    download === null ? null : downloadButtonView(download, onDownload);
  // Player mode is artwork-led — full-bleed art under the bottom
  // cluster; missing art keeps the flat stage. The backdrop stays
  // mounted across mode switches (the image resolves once per
  // artworkUrl — no remount flicker); lyrics/queue modes hide it under
  // their flat surface — see `.uw-stage__backdrop` in styles.css.
  // A failed request drops to that same flat treatment — the
  // missing-art glyph stands in instead of two broken imgs — but
  // the failure is remembered only for the occurrence that saw it:
  // the next track (or a return to this one as a fresh occurrence)
  // retries the image rather than hiding it behind the glyph.
  const [failedArtwork, setFailedArtwork] = useState<{
    readonly occurrence: string | null;
    readonly url: string;
  } | null>(null);
  const liveArtwork =
    player.artworkUrl !== null &&
    (failedArtwork === null ||
      failedArtwork.url !== player.artworkUrl ||
      failedArtwork.occurrence !== player.occurrenceId)
      ? player.artworkUrl
      : null;
  const immersive = activeMode === 'player' && liveArtwork !== null;
  // Lyrics auto-scroll — the synced active line stays in view. A
  // scroll lands on an activeIndex or occurrence change (a swap
  // inheriting the previous song's scroll would leave the new active
  // line offscreen); between those, a manual scroll is never yanked
  // back.
  const lyricsRef = useRef<HTMLDivElement>(null);
  const lyricActiveIndex =
    lyricsPane.kind === 'lines' ? lyricsPane.activeIndex : null;
  useEffect(() => {
    if (activeMode !== 'lyrics' || lyricActiveIndex === null) {
      return;
    }
    lyricsRef.current
      ?.querySelector('.uw-lyrics__line--active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeMode, lyricActiveIndex, player.occurrenceId]);

  // The two heavy subtrees get element-level memoization: an identical
  // element bails out of reconciliation, so a mode switch or a
  // position tick leaves the kept-alive rows/lines untouched.
  const queueListEl = useMemo(
    () =>
      queue === undefined ? null : (
        <QueueList
          queue={queue}
          reordering={queueReordering}
          scrollEnabled={queueScrollEnabled}
          onPressItem={onPressQueueItem}
          onRowIntent={onQueueRowIntent}
          onRemoveItem={onRemoveQueueItem}
          onMoveItem={onMoveQueueItem}
          onMoveItemTo={onMoveQueueItemTo}
          onClearUpcoming={onClearUpcoming}
        />
      ),
    [
      queue,
      queueReordering,
      queueScrollEnabled,
      onPressQueueItem,
      onQueueRowIntent,
      onRemoveQueueItem,
      onMoveQueueItem,
      onMoveQueueItemTo,
      onClearUpcoming,
    ],
  );

  const lyricLineEls = useMemo(
    () =>
      lyricsPane.kind === 'lines'
        ? lyricsPane.lines.map((line, i) => (
            <Text
              key={i}
              variant="body"
              color={line.color}
              className={`uw-lyrics__line${line.active ? ' uw-lyrics__line--active' : ''}`}
            >
              {line.text}
            </Text>
          ))
        : null,
    [lyricsPane],
  );

  return (
    <div
      className={`uw-stage${immersive ? ' uw-stage--immersive t-dark' : ''}`}
      data-mode={activeMode}
    >
      {liveArtwork !== null && (
        <StageBackdrop
          url={liveArtwork}
          onError={() =>
            setFailedArtwork({
              occurrence: player.occurrenceId,
              url: liveArtwork,
            })
          }
        />
      )}
      <div className="uw-stage__body">
        <div style={paneHidden('player')}>
            {/*
             * The live radio element: a seed affordance when no tail is
             * armed, the tail's honest status when one is — 'failed'
             * carries the typed message, and stop always clears. Same
             * top-center accent pill the sheet pins under its handle.
             */}
            {radioRow !== null && (
              <div className="uw-stage__radio">
                <div className="uw-stage__radio-pill">
                  <Icon
                    name="radio"
                    size={13}
                    color={radioRow.failed ? 'var(--warn)' : 'var(--accent)'}
                  />
                  {/* Fixed footprint across arm/disarm (the header-bar
                      rule): stacked ghosts keep the widest candidate's
                      width, and stop keeps its slot hidden while
                      unarmed. */}
                  <span className="uw-stage__radio-labels">
                    <span
                      className="uw-text uw-text--metadata uw-stage__radio-ghost"
                      aria-hidden="true"
                    >
                      {radioRow.ghostText}
                    </span>
                    {radioRow.armed ? (
                      <Text
                        variant="metadata"
                        color={radioRow.failed ? 'warn' : 'accent'}
                        className="uw-stage__radio-live"
                      >
                        {radioRow.statusText}
                      </Text>
                    ) : (
                      <RadioAction action={radioRow.start} color="accent" />
                    )}
                  </span>
                  <RadioAction
                    action={radioRow.stop}
                    color="primary"
                    hidden={!radioRow.armed}
                  />
                </div>
              </div>
            )}
            {/* Bottom-anchored meta in the frost zone — the column's
                dead space lives above it; a long title scrolls. */}
            <div className="uw-stage__scroll">
              {liveArtwork === null && (
                <div className="uw-stage__art">
                  <Artwork url={null} fill />
                </div>
              )}
              <div className="uw-stage__meta-row">
                <div className="uw-stage__meta">
                  <Text variant="display" color="bright" numberOfLines={1}>
                    {meta.title}
                  </Text>
                  <Text variant="body" color="primary" numberOfLines={1}>
                    {meta.artistLabel}
                  </Text>
                  {meta.albumLabel !== null && (
                    <Text variant="metadata" color="secondary" numberOfLines={1}>
                      {meta.albumLabel}
                    </Text>
                  )}
                  {meta.errorMessage !== null && (
                    <Text variant="metadata" color="warn" numberOfLines={2}>
                      {meta.errorMessage}
                    </Text>
                  )}
                  {meta.recovery === 'sign-in' &&
                    onRecovery !== undefined && (
                      <Pressable
                        className="uw-stage__recovery"
                        ariaLabel={t('auth.wall.ctaA11y')}
                        onPress={onRecovery}
                      >
                        <Text variant="label" color="accent">
                          {t('auth.wall.cta')}
                        </Text>
                      </Pressable>
                    )}
                </div>
                {/* Ownership actions hug the right edge of the meta
                    line — download state icon first, then the
                    playlist-picker affordance (native parity). */}
                {(downloadBtn !== null || onAddToPlaylist !== undefined) && (
                  <div className="uw-stage__actions">
                    {downloadBtn !== null && (
                      <DownloadIconButton
                        view={downloadBtn}
                        size={36}
                        iconSize={15}
                      />
                    )}
                    {onAddToPlaylist !== undefined && (
                      <IconButton
                        icon="list-plus"
                        active={player.inPlaylist}
                        filled={player.inPlaylist}
                        size={36}
                        iconSize={15}
                        color="var(--text-secondary)"
                        ariaLabel={t('sheets.addToPlaylist')}
                        onPress={onAddToPlaylist}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
            <WaveformSeek
              positionMs={player.positionMs}
              durationMs={player.durationMs}
              onSeek={onSeek}
              trackKey={meta.trackKey}
              peaks={peaks}
              loading={meta.waveformLoading}
            />
            <TransportControls
              variant="m3e"
              status={player.status}
              intentPlaying={player.intentPlaying}
              liked={player.liked}
              canPrevious={player.canPrevious}
              canNext={player.canNext}
              {...transport}
            />
        </div>
        <div style={paneHidden('lyrics')}>
            <div className="uw-stage__meta uw-stage__meta--lyrics">
              <Text variant="body" color="bright" numberOfLines={1}>
                {lyricsHeader.title}
              </Text>
              <Text variant="metadata" color="secondary" numberOfLines={1}>
                {lyricsHeader.subtitle}
              </Text>
            </div>
            {/*
             * Honest lyrics: only `state === 'synced'` highlights the
             * active line — plain text never gets synced treatment,
             * instrumental/unavailable/error are explicit states, and
             * loading is bounded by the session's own op deadline.
             */}
            {lyricsPane.kind === 'empty' ? (
              <EmptyState
                title={lyricsPane.title}
                hint={lyricsPane.hint}
                icon={lyricsPane.icon}
              />
            ) : lyricsPane.kind === 'loading' ? (
              <LoadingState title={lyricsPane.title} />
            ) : lyricsPane.kind === 'error' ? (
              <ErrorState
                title={lyricsPane.title}
                hint={lyricsPane.hint}
                onRetry={lyricsPane.onRetry}
              />
            ) : (
              <div
                className="uw-lyrics"
                data-state={lyricsPane.state}
                ref={lyricsRef}
              >
                {lyricLineEls}
              </div>
            )}
        </div>
        <div style={paneHidden('queue')}>
          <div className="uw-stage__queue">
            {queue === undefined ? (
              <EmptyState
                title={t('queue.empty')}
                hint={t('queue.emptyHint')}
                icon="queue"
              />
            ) : (
              <>
                {(queueOrigin !== null ||
                  queueMeta !== null ||
                  reorder !== null) && (
                  <div className="uw-stage__queue-tools">
                    <span className="uw-stage__queue-meta">
                      {queueOrigin !== null && (
                        <button
                          className="uw-stage__queue-origin"
                          onClick={queueOrigin.onPress}
                          disabled={queueOrigin.onPress === undefined}
                        >
                          <Text
                            variant="metadata"
                            color="secondary"
                            numberOfLines={1}
                          >
                            {queueOrigin.label}
                          </Text>
                        </button>
                      )}
                      {queueMeta !== null && (
                        <Text
                          variant="metadata"
                          color="secondary"
                          numberOfLines={1}
                        >
                          {queueMeta}
                        </Text>
                      )}
                    </span>
                    {reorder !== null && (
                      <IconButton
                        icon={reorder.icon}
                        size={32}
                        iconSize={14}
                        color={
                          reorder.active ? 'var(--accent)' : 'var(--text-secondary)'
                        }
                        ariaLabel={reorder.a11yLabel}
                        active={reorder.active}
                        onPress={reorder.onPress}
                      />
                    )}
                  </div>
                )}
                {queueListEl}
              </>
            )}
          </div>
        </div>
      </div>
      {/* Stop/dismiss floats over the stage's top-right — out of the
          body flow, reachable in every mode (the old column-level
          close's home; the stage toggle only hides the column). */}
      {onTrackMenu !== undefined && (
        <IconButton
          icon="ellipsis"
          size={32}
          iconSize={14}
          color="var(--text-secondary)"
          ariaLabel={t('track.a11y.rowActions')}
          onPress={onTrackMenu}
          className="uw-stage__menu"
        />
      )}
      {onStopPlayback !== undefined && (
        <IconButton
          icon="close"
          size={32}
          iconSize={14}
          color="var(--text-secondary)"
          ariaLabel={t('player.a11y.stopDismiss')}
          onPress={onStopPlayback}
          className="uw-stage__stop"
        />
      )}
      {/* The mode segment floats over the stage's bottom safe zone —
          it takes no layout space, so lyrics/queue rows and the
          transport never reflow around it or hide beneath it. */}
      <div className="uw-stage__segment">
        <ModeSegment mode={activeMode} onSelect={select} />
      </div>
    </div>
  );
}

export type StageSheetProps = NowPlayingScreenProps & {
  readonly expanded: boolean;
  readonly onExpandChange: ((expanded: boolean) => void) | undefined;
};

/**
 * The stage as an overlay — the native StageSheet's desktop form.
 * Escape collapses; the sheet mounts/unmounts on `expanded` (the
 * slide animation lives in styles.css as a transform transition
 * while it stays mounted during exit — kept simple: unmount on
 * collapse like every other sheet).
 */
export function StageSheet({ expanded, onExpandChange, ...rest }: StageSheetProps) {
  const dismiss = useCallback(
    () => onExpandChange?.(false),
    [onExpandChange],
  );
  useOverlayDismiss(expanded && onExpandChange !== undefined ? dismiss : undefined);
  if (!expanded) {
    return null;
  }
  return (
    <StageSheetDialog>
      <NowPlayingScreen {...rest} />
    </StageSheetDialog>
  );
}

// Separate component so focus entry/restore tracks the expanded
// mount boundary exactly (StageSheet itself stays mounted while
// collapsed) — the Sheet/SheetDialog split.
function StageSheetDialog({ children }: { readonly children: ReactNode }) {
  const dialogRef = useOverlayFocus<HTMLDivElement>();
  return (
    <div
      ref={dialogRef}
      className="uw-sheet-host"
      role="dialog"
      aria-modal="true"
      aria-label={t('stage.sheetA11y')}
      data-sheet="stage"
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

export type StageIdlePaneProps = {
  readonly mode: StageMode;
  readonly onModeChange?: ((mode: StageMode) => void) | undefined;
  /**
   * The ended queue — rendered while the mode is 'queue'. Undefined
   * (nothing ever queued, or a non-queue mode selected) falls back to
   * the stage's empty pane.
   */
  readonly queue?: QueueModel | undefined;
  readonly queueReordering?: QueueScreenProps['reordering'];
  readonly onToggleQueueReorder?: QueueScreenProps['onToggleReorder'];
  readonly onClearUpcoming?: QueueScreenProps['onClearUpcoming'];
  readonly onOpenQueueContext?: QueueScreenProps['onOpenContext'];
  readonly onPressQueueItem?: QueueScreenProps['onPressItem'];
  readonly onQueueRowIntent?: QueueScreenProps['onRowIntent'];
  readonly onRemoveQueueItem?: QueueScreenProps['onRemoveItem'];
  readonly onMoveQueueItem?: QueueScreenProps['onMoveItem'];
  readonly onMoveQueueItemTo?: QueueScreenProps['onMoveItemTo'];
};

/**
 * The stage column while nothing is loaded — the ended queue or the
 * empty pane under the same chrome as the loaded stage: the floating
 * mode segment stays put, so the column never reads as a bare list.
 */
export function StageIdlePane({
  mode,
  onModeChange,
  queue,
  queueReordering,
  onToggleQueueReorder,
  onClearUpcoming,
  onOpenQueueContext,
  onPressQueueItem,
  onQueueRowIntent,
  onRemoveQueueItem,
  onMoveQueueItem,
  onMoveQueueItemTo,
}: StageIdlePaneProps) {
  return (
    <div className="uw-stage" data-mode={mode}>
      {mode === 'queue' && queue !== undefined ? (
        <QueueScreen
          queue={queue}
          reordering={queueReordering}
          onToggleReorder={onToggleQueueReorder}
          onClearUpcoming={onClearUpcoming}
          onOpenContext={onOpenQueueContext}
          onPressItem={onPressQueueItem}
          onRowIntent={onQueueRowIntent}
          onRemoveItem={onRemoveQueueItem}
          onMoveItem={onMoveQueueItem}
          onMoveItemTo={onMoveQueueItemTo}
        />
      ) : (
        <EmptyState
          title={t('stage.empty')}
          hint={t('stage.emptyHint')}
          icon="note"
        />
      )}
      <div className="uw-stage__segment">
        <ModeSegment mode={mode} onSelect={onModeChange} />
      </div>
    </div>
  );
}
