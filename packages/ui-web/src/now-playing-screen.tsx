import { useCallback, useState } from 'react';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  PlayPauseIcon,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { WaveformSeek } from './progress.tsx';
import { useOverlayDismiss } from './stack.tsx';
import { QueueList } from './queue-list.tsx';
import { EmptyState, ErrorState, LoadingState } from './states.tsx';
import { t } from '@auqw/ui-shared';
import type {
  DownloadChip,
  LyricsModel,
  MessageId,
  PlayerModel,
  QueueModel,
  RadioModel,
  StageMode,
  WaveformPeak,
} from '@auqw/ui-shared';

export type { LyricsModel, StageMode } from '@auqw/ui-shared';

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
  const busy = status === 'preparing' || status === 'buffering';
  const playing = intentPlaying;
  const playColor = variant === 'm3e' ? 'var(--canvas)' : 'var(--text-bright)';
  return (
    <div className={`uw-transport uw-transport--${variant}`} role="group" aria-label={t('player.a11y.transport')}>
      <IconButton
        icon={liked ? 'heart-filled' : 'heart'}
        size={32}
        iconSize={14}
        color={liked ? 'var(--liked)' : 'var(--text-secondary)'}
        ariaLabel={liked ? t('common.unlike') : t('common.like')}
        active={liked}
        onPress={onToggleLike}
        className="uw-transport__side"
      />
      <IconButton
        icon="shuffle"
        size={32}
        iconSize={14}
        color={shuffle ? 'var(--accent)' : 'var(--text-secondary)'}
        ariaLabel={t('common.shuffle')}
        disabled={onToggleShuffle === undefined}
        active={shuffle}
        onPress={onToggleShuffle}
        className="uw-transport__side"
      />
      <IconButton
        icon="previous"
        size={36}
        iconSize={15}
        color="var(--text-primary)"
        ariaLabel={t('common.previous')}
        disabled={!canPrevious}
        onPress={onPrevious}
        className="uw-transport__main"
      />
      <Pressable
        onPress={onPlayPause}
        ariaLabel={playing ? t('common.pause') : t('common.play')}
        ariaPressed={playing}
        className="uw-transport__play"
      >
        {busy ? (
          <Spinner size={18} color={playColor} />
        ) : (
          <PlayPauseIcon playing={playing} size={18} color={playColor} />
        )}
      </Pressable>
      <IconButton
        icon="next"
        size={36}
        iconSize={15}
        color="var(--text-primary)"
        ariaLabel={t('common.next')}
        disabled={!canNext}
        onPress={onNext}
        className="uw-transport__main"
      />
      <IconButton
        icon={repeat === 'one' ? 'repeat-one' : 'repeat'}
        size={32}
        iconSize={14}
        color={repeat === 'off' ? 'var(--text-secondary)' : 'var(--accent)'}
        ariaLabel={
          repeat === 'one'
            ? t('common.repeatOne')
            : repeat === 'all'
              ? t('common.repeatAll')
              : t('common.repeat')
        }
        disabled={onCycleRepeat === undefined}
        active={repeat !== 'off'}
        onPress={onCycleRepeat}
        className="uw-transport__side"
      />
    </div>
  );
}

// Labels resolve at render (never cached in the module constant) so a
// locale switch re-translates every tab.
const MODES: readonly { key: StageMode; label: MessageId; icon: IconName }[] = [
  { key: 'player', label: 'stage.mode.player', icon: 'note' },
  { key: 'lyrics', label: 'stage.mode.lyrics', icon: 'lyrics' },
  { key: 'queue', label: 'stage.mode.queue', icon: 'queue' },
];

export function ModeSegment({
  mode,
  onSelect,
}: {
  readonly mode: StageMode;
  readonly onSelect?: ((mode: StageMode) => void) | undefined;
}) {
  return (
    <div className="uw-segment" role="tablist" aria-label={t('stage.modeTabsA11y')}>
      {MODES.map((m) => {
        const active = m.key === mode;
        return (
          <Pressable
            key={m.key}
            onPress={onSelect === undefined ? undefined : () => onSelect(m.key)}
            ariaLabel={t(m.label)}
            ariaSelected={active}
            className={`uw-segment__item${active ? ' uw-segment__item--on' : ''}`}
          >
            {/* Tonal pill — same construction as the native segment's
                m3e fill: accentSoft chip, accent icon + label. */}
            <Icon
              name={m.icon}
              size={12}
              color={active ? 'var(--accent)' : 'var(--text-secondary)'}
            />
            <Text
              variant="metadata"
              color={active ? 'accent' : 'secondary'}
              className={active ? 'uw-text--bold' : undefined}
            >
              {t(m.label)}
            </Text>
          </Pressable>
        );
      })}
    </div>
  );
}

export type NowPlayingScreenProps = {
  readonly player: PlayerModel;
  readonly mode?: StageMode | undefined;
  readonly queue?: QueueModel | undefined;
  readonly lyrics?: LyricsModel | undefined;
  readonly radio?: RadioModel | undefined;
  readonly queueReordering?: boolean | undefined;
  readonly queueScrollEnabled?: boolean | undefined;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  readonly shuffle?: boolean | undefined;
  readonly onToggleShuffle?: (() => void) | undefined;
  readonly repeat?: 'off' | 'all' | 'one' | undefined;
  readonly onCycleRepeat?: (() => void) | undefined;
  readonly download?: DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
  /** Add-to-playlist affordance on the meta row (same as native). */
  readonly onAddToPlaylist?: (() => void) | undefined;
  /**
   * Stops playback and clears the stage's track (the queue keeps its
   * items — the native mini-player's swipe-down dismiss). Overlays the
   * stage's top-right in every mode; omitted hides the control.
   */
  readonly onStopPlayback?: (() => void) | undefined;
  readonly onSeek?: ((ms: number) => void) | undefined;
  /** Real measured peaks for the playing recording; null/undefined
   * keeps the seeded pattern (pending state and failure fallback). */
  readonly peaks?: readonly WaveformPeak[] | null | undefined;
  readonly onRetryLyrics?: (() => void) | undefined;
  readonly onStartRadio?: (() => void) | undefined;
  readonly onStopRadio?: (() => void) | undefined;
  readonly onModeChange?: ((mode: StageMode) => void) | undefined;
  readonly onPressQueueItem?: ((occurrenceId: string) => void) | undefined;
  readonly onRemoveQueueItem?: ((occurrenceId: string) => void) | undefined;
  readonly onToggleQueueReorder?: (() => void) | undefined;
  readonly onMoveQueueItem?:
    | ((occurrenceId: string, direction: -1 | 1) => void)
    | undefined;
  readonly onMoveQueueItemTo?:
    | ((occurrenceId: string, toIndex: number) => void)
    | undefined;
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
  const [internalMode, setInternalMode] = useState<StageMode>('player');
  const activeMode = mode ?? internalMode;
  // Player mode is artwork-led — full-bleed art under the bottom
  // cluster; missing art (and lyrics/queue) keeps the flat stage.
  // A failed request drops to that same flat treatment: the failed
  // url is recorded so a track change re-arms the immersive stage,
  // and the missing-art glyph stands in instead of two broken imgs.
  const [failedArtworkUrl, setFailedArtworkUrl] = useState<string | null>(
    null,
  );
  const artworkUrl = activeMode === 'player' ? player.artworkUrl : null;
  const liveArtwork = artworkUrl !== failedArtworkUrl ? artworkUrl : null;
  return (
    <div
      className={`uw-stage${liveArtwork !== null ? ' uw-stage--immersive t-dark' : ''}`}
      data-mode={activeMode}
    >
      {liveArtwork !== null && (
        <StageBackdrop
          url={liveArtwork}
          onError={() => setFailedArtworkUrl(liveArtwork)}
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
            {radio !== undefined && (radio.armed || onStartRadio !== undefined) && (
              <div className="uw-stage__radio">
                <div className="uw-stage__radio-pill">
                  <Icon
                    name="radio"
                    size={13}
                    color={
                      radio.status === 'failed'
                        ? 'var(--warn)'
                        : 'var(--accent)'
                    }
                  />
                  {radio.armed ? (
                    <>
                      <Text
                        variant="metadata"
                        color={radio.status === 'failed' ? 'warn' : 'accent'}
                      >
                        {radio.label}
                        {radio.fetching ? t('stage.radio.fetchingSuffix') : ''}
                        {radio.detail === null ? '' : ` · ${radio.detail}`}
                      </Text>
                      <Pressable
                        onPress={onStopRadio}
                        ariaLabel={t('stage.radio.stopA11y')}
                        className="uw-stage__radio-action"
                      >
                        <Text variant="metadata" color="primary">
                          {t('stage.radio.stop')}
                        </Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      onPress={onStartRadio}
                      ariaLabel={t('stage.radio.start')}
                      className="uw-stage__radio-action"
                    >
                      <Text variant="metadata" color="accent">
                        {t('stage.radio.start')}
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
              {player.title}
            </Text>
            <Text variant="body" color="primary" numberOfLines={1}>
              {player.artist ?? '—'}
            </Text>
            {player.albumLabel !== null && (
              <Text
                variant="metadata"
                color="secondary"
                numberOfLines={1}
              >
                {player.albumLabel}
              </Text>
            )}
            {player.errorMessage !== null && (
              <Text variant="metadata" color="warn" numberOfLines={2}>
                {player.errorMessage}
              </Text>
            )}
          </div>
                {/* Ownership actions hug the right edge of the meta
                      line — download state icon first, then the
                      playlist-picker affordance (native parity). */}
                {(download !== null || onAddToPlaylist !== undefined) && (
                  <div className="uw-stage__actions">
                    {download !== null && (
                      <IconButton
                        icon={
                          download === 'stored'
                            ? 'check'
                            : download === 'failed'
                              ? 'warn'
                              : 'download'
                        }
                        size={36}
                        iconSize={15}
                        color={
                          download === 'failed'
                            ? 'var(--warn)'
                            : download === 'stored'
                              ? 'var(--accent)'
                              : 'var(--text-secondary)'
                        }
                        ariaLabel={
                          download === 'stored'
                            ? t('stage.download.storedA11y')
                            : download === 'failed'
                              ? t('stage.download.failedA11y')
                              : download === 'queued' || download === 'downloading'
                                ? t('stage.download.busyA11y')
                                : t('stage.download.idleA11y')
                        }
                        active={download === 'stored'}
                        onPress={onDownload}
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
            trackKey={player.occurrenceId}
            seed={`${player.title}|${player.artist ?? ''}`}
            peaks={peaks}
            loading={player.status === 'preparing' || player.durationMs === null}
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
              {player.title}
            </Text>
            <Text variant="metadata" color="secondary" numberOfLines={1}>
              {player.artist ?? '—'}
              {lyrics?.syncLabel != null ? ` · ${lyrics.syncLabel}` : ''}
            </Text>
          </div>
          {/*
           * Honest lyrics: only `state === 'synced'` highlights the
           * active line — plain text never gets synced treatment,
           * instrumental/unavailable/error are explicit states, and
           * loading is bounded by the session's own op deadline.
           */}
          {lyrics === undefined ? (
            <EmptyState title={t('lyrics.empty')} icon="lyrics" />
          ) : lyrics.state === 'loading' ? (
            <LoadingState title={t('lyrics.loading')} />
          ) : lyrics.state === 'error' ? (
            <ErrorState
              title={t('lyrics.errorTitle')}
              hint={lyrics.message}
              onRetry={onRetryLyrics}
            />
          ) : lyrics.state === 'instrumental' ? (
            <EmptyState
              title={t('lyrics.instrumental')}
              hint={lyrics.message}
              icon="lyrics"
            />
          ) : lyrics.state === 'unavailable' ? (
            <EmptyState
              title={t('lyrics.empty')}
              hint={lyrics.message}
              icon="lyrics"
            />
          ) : lyrics.lines.length === 0 ? (
            <EmptyState title={t('lyrics.empty')} icon="lyrics" />
          ) : (
            <div className="uw-lyrics" data-state={lyrics.state}>
              {lyrics.lines.map((line, i) => (
                <Text
                  key={i}
                  variant="body"
                  color={
                    i === lyrics.activeIndex
                      ? 'accent'
                      : lyrics.state === 'plain'
                        ? 'primary'
                        : 'secondary'
                  }
                  className={`uw-lyrics__line${i === lyrics.activeIndex ? ' uw-lyrics__line--active' : ''}`}
                >
                  {line}
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
              {onToggleQueueReorder !== undefined && (
                <div className="uw-stage__queue-tools">
                  <IconButton
                    icon="drag-handle"
                    size={32}
                    iconSize={14}
                    color={
                      queueReordering
                        ? 'var(--accent)'
                        : 'var(--text-secondary)'
                    }
                    ariaLabel={
                      queueReordering ? t('queue.reorderDone') : t('queue.reorder')
                    }
                    active={queueReordering}
                    onPress={onToggleQueueReorder}
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
      <ModeSegment
        mode={activeMode}
        onSelect={(m) => {
          setInternalMode(m);
          if (onModeChange !== undefined) {
            onModeChange(m);
          }
        }}
      />
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
