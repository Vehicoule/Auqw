import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  PlayPauseIcon,
  Spinner,
  Text,
} from './primitives.tsx';
import { WaveformSeek } from './progress.tsx';
import { useOverlayDismiss } from './stack.tsx';
import { QueueList } from './queue-list.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import { t } from '@auqw/ui-shared';
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
  queueReorderButton,
  radioRowView,
  stageMetaView,
  STAGE_MODE_ORDER,
  stageModeTabs,
  useStageMode,
  useTransportView,
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

// The desktop transport keeps the m3e layout (raised main pill,
// accent play slab) — the ios glass variant exists for parity. The
// row is pure transport `like · shuffle · prev · play · next ·
// repeat` on both platforms; ownership actions (download, add) live
// on the metadata line above it.
export function TransportControls({
  variant = 'm3e',
  status,
  intentPlaying,
  liked,
  canPrevious,
  canNext,
  onPlayPause,
  onPrevious,
  onNext,
  onToggleLike,
  shuffle = false,
  onToggleShuffle,
  repeat = 'off',
  onCycleRepeat,
}: TransportProps) {
  const view = useTransportView({
    status,
    intentPlaying,
    liked,
    canPrevious,
    canNext,
    shuffle,
    repeat,
    onPlayPause,
    onPrevious,
    onNext,
    onToggleLike,
    onToggleShuffle,
    onCycleRepeat,
  });
  const playColor =
    variant === 'm3e' ? 'var(--canvas)' : 'var(--text-bright)';
  return (
    <div className={`uw-transport uw-transport--${variant}`} role="group" aria-label={view.a11yLabel}>
      <IconButton
        icon={view.like.icon}
        size={32}
        iconSize={14}
        color={view.like.liked ? 'var(--liked)' : 'var(--text-secondary)'}
        ariaLabel={view.like.a11yLabel}
        active={view.like.active}
        onPress={view.like.onPress}
        className="uw-transport__side"
      />
      <IconButton
        icon={view.shuffle.icon}
        size={32}
        iconSize={14}
        color={view.shuffle.active ? 'var(--accent)' : 'var(--text-secondary)'}
        ariaLabel={view.shuffle.a11yLabel}
        disabled={view.shuffle.disabled}
        active={view.shuffle.active}
        onPress={view.shuffle.onPress}
        className="uw-transport__side"
      />
      <IconButton
        icon={view.previous.icon}
        size={36}
        iconSize={15}
        color="var(--text-primary)"
        ariaLabel={view.previous.a11yLabel}
        disabled={view.previous.disabled}
        onPress={view.previous.onPress}
        className="uw-transport__main"
      />
      <Pressable
        onPress={view.play.onPress}
        ariaLabel={view.play.a11yLabel}
        ariaPressed={view.play.pressed}
        className="uw-transport__play"
      >
        {view.busy ? (
          <Spinner size={18} color={playColor} />
        ) : (
          <PlayPauseIcon playing={view.playing} size={18} color={playColor} />
        )}
      </Pressable>
      <IconButton
        icon={view.next.icon}
        size={36}
        iconSize={15}
        color="var(--text-primary)"
        ariaLabel={view.next.a11yLabel}
        disabled={view.next.disabled}
        onPress={view.next.onPress}
        className="uw-transport__main"
      />
      <IconButton
        icon={view.repeat.icon}
        size={32}
        iconSize={14}
        color={view.repeat.active ? 'var(--accent)' : 'var(--text-secondary)'}
        ariaLabel={view.repeat.a11yLabel}
        disabled={view.repeat.disabled}
        active={view.repeat.active}
        onPress={view.repeat.onPress}
        className="uw-transport__side"
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
    <div
      className="uw-segment uw-segment--float t-dark"
      role="tablist"
      aria-label={t('stage.modeTabsA11y')}
    >
      {tabs.map((tab) => (
        <Pressable
          key={tab.key}
          onPress={tab.onPress}
          ariaLabel={tab.label}
          ariaSelected={tab.active}
          className={`uw-segment__item${tab.active ? ' uw-segment__item--on' : ''}`}
        >
          {/* Tonal pill — same construction as the native segment's
              m3e fill: accentSoft chip, accent icon + label. */}
          <Icon
            name={tab.icon}
            size={12}
            color={tab.active ? 'var(--accent)' : 'var(--text-secondary)'}
          />
          <Text
            variant="metadata"
            color={tab.active ? 'accent' : 'secondary'}
            className={tab.active ? 'uw-text--bold' : undefined}
          >
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </div>
  );
}

export type NowPlayingScreenProps = StageScreenHandlers & {
  readonly player: PlayerModel;
  readonly mode?: StageMode | undefined;
  readonly queue?: QueueModel | undefined;
  readonly lyrics?: LyricsModel | undefined;
  readonly radio?: RadioModel | undefined;
  readonly queueReordering?: boolean | undefined;
  readonly queueScrollEnabled?: boolean | undefined;
  readonly shuffle?: boolean | undefined;
  readonly repeat?: 'off' | 'all' | 'one' | undefined;
  readonly download?: DownloadChip | null | undefined;
  /** Real measured peaks for the playing recording; null/undefined
   * keeps the seeded pattern (pending state and failure fallback). */
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
  return (
    <div className="uw-stage__backdrop" aria-hidden="true">
      <img
        className="uw-stage__backdrop-art"
        src={url}
        alt=""
        onError={onError}
      />
      <img
        className="uw-stage__backdrop-frost"
        src={url}
        alt=""
        onError={onError}
      />
      <div className="uw-stage__backdrop-scrim" />
    </div>
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
  onPlayPause,
  onNext,
  onPrevious,
  onToggleLike,
  shuffle = false,
  onToggleShuffle,
  repeat = 'off',
  onCycleRepeat,
  download = null,
  onDownload,
  onAddToPlaylist,
  onStopPlayback,
  onSeek,
  peaks,
  onRetryLyrics,
  onStartRadio,
  onStopRadio,
  onModeChange,
  onPressQueueItem,
  onRemoveQueueItem,
  onToggleQueueReorder,
  onMoveQueueItem,
  onMoveQueueItemTo,
}: NowPlayingScreenProps) {
  const { activeMode, select } = useStageMode(mode, onModeChange);
  const meta = stageMetaView(player);
  const lyricsHeader = lyricsHeaderView(player, lyrics);
  const lyricsPane = lyricsPaneView(lyrics, onRetryLyrics);
  const radioRow = radioRowView(radio, onStartRadio, onStopRadio);
  const reorder = queueReorderButton(queueReordering, onToggleQueueReorder);
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
  // Lyrics auto-scroll — the synced active line stays in view; the
  // scroll lands only on an activeIndex change so a manual scroll
  // between line flips is never yanked back.
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
  }, [activeMode, lyricActiveIndex]);
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
      {activeMode === 'player' && (
        <>
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
                  {radioRow.armed ? (
                    <>
                      <Text
                        variant="metadata"
                        color={radioRow.failed ? 'warn' : 'accent'}
                      >
                        {radioRow.statusText}
                      </Text>
                      <Pressable
                        onPress={radioRow.stop.onPress}
                        ariaLabel={radioRow.stop.a11yLabel}
                        className="uw-stage__radio-action"
                      >
                        <Text variant="metadata" color="primary">
                          {radioRow.stop.label}
                        </Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      onPress={radioRow.start.onPress}
                      ariaLabel={radioRow.start.a11yLabel}
                      className="uw-stage__radio-action"
                    >
                      <Text variant="metadata" color="accent">
                        {radioRow.start.label}
                      </Text>
                    </Pressable>
                  )}
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
                  <Text variant="display" color="bright" numberOfLines={2}>
              {meta.title}
            </Text>
            <Text variant="body" color="primary" numberOfLines={1}>
              {meta.artistLabel}
            </Text>
            {meta.albumLabel !== null && (
              <Text
                variant="metadata"
                color="secondary"
                numberOfLines={1}
              >
                {meta.albumLabel}
              </Text>
            )}
            {meta.errorMessage !== null && (
              <Text variant="metadata" color="warn" numberOfLines={2}>
                {meta.errorMessage}
              </Text>
            )}
          </div>
                {/* Ownership actions hug the right edge of the meta
                      line — download state icon first, then the
                      playlist-picker affordance (native parity). */}
                {(downloadBtn !== null || onAddToPlaylist !== undefined) && (
                  <div className="uw-stage__actions">
                    {downloadBtn !== null && (
                      <IconButton
                        icon={downloadBtn.icon}
                        size={36}
                        iconSize={15}
                        color={
                          downloadBtn.failed
                            ? 'var(--warn)'
                            : downloadBtn.stored
                              ? 'var(--accent)'
                              : 'var(--text-secondary)'
                        }
                        ariaLabel={downloadBtn.a11yLabel}
                        active={downloadBtn.stored}
                        onPress={downloadBtn.onPress}
                      />
                    )}
                    {onAddToPlaylist !== undefined && (
                      <IconButton
                        icon="list-plus"
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
            seed={meta.waveformSeed}
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
            onPlayPause={onPlayPause}
            onPrevious={onPrevious}
            onNext={onNext}
            onToggleLike={onToggleLike}
            shuffle={shuffle}
            onToggleShuffle={onToggleShuffle}
            repeat={repeat}
            onCycleRepeat={onCycleRepeat}
              />
        </>
      )}
      {activeMode === 'lyrics' && (
        <>
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
              {lyricsPane.lines.map((line, i) => (
                <Text
                  key={i}
                  variant="body"
                  color={line.color}
                  className={`uw-lyrics__line${line.active ? ' uw-lyrics__line--active' : ''}`}
                >
                  {line.text}
                </Text>
              ))}
            </div>
          )}
        </>
      )}
      {activeMode === 'queue' && (
        <div className="uw-stage__queue">
          {queue === undefined ? (
            <EmptyState title={t('queue.empty')} icon="queue" />
          ) : (
            <>
              {reorder !== null && (
                <div className="uw-stage__queue-tools">
                  <IconButton
                    icon={reorder.icon}
                    size={32}
                    iconSize={14}
                    color={
                      reorder.active
                        ? 'var(--accent)'
                        : 'var(--text-secondary)'
                    }
                    ariaLabel={reorder.a11yLabel}
                    active={reorder.active}
                    onPress={reorder.onPress}
                  />
                </div>
              )}
              <QueueList
                queue={queue}
                reordering={queueReordering}
                scrollEnabled={queueScrollEnabled}
                onPressItem={onPressQueueItem}
                onRemoveItem={onRemoveQueueItem}
                onMoveItem={onMoveQueueItem}
                onMoveItemTo={onMoveQueueItemTo}
              />
            </>
          )}
        </div>
      )}
      </div>
      {/* Stop/dismiss floats over the stage's top-right — out of the
          body flow, reachable in every mode (the old column-level
          close's home; the stage toggle only hides the column). */}
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
    <div
      className="uw-sheet-host"
      role="dialog"
      aria-modal="true"
      aria-label={t('stage.sheetA11y')}
      data-sheet="stage"
    >
      <NowPlayingScreen {...rest} />
    </div>
  );
}
