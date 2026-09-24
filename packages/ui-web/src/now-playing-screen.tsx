import { useCallback, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
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
import type {
  DownloadChip,
  LyricsModel,
  PlayerModel,
  QueueModel,
  RadioModel,
  StageMode,
} from '@auqw/ui-shared';

export type { LyricsModel, StageMode } from '@auqw/ui-shared';

export type TransportVariant = 'm3e' | 'ios' | 'stage';

export type TransportProps = {
  readonly variant?: TransportVariant | undefined;
  readonly status: PlayerModel['status'];
  readonly liked: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  /**
   * Repeat-mode cycle — the 'stage' layout always renders the control;
   * with no handler it stays honestly disabled (no repeat backend
   * exists yet).
   */
  readonly onRepeat?: (() => void) | undefined;
  readonly repeatActive?: boolean | undefined;
  /** Owned-bytes state of the current track; null hides the button. */
  readonly download?: DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
};

export function TransportControls({
  variant = 'm3e',
  status,
  liked,
  canPrevious,
  canNext,
  onPlayPause,
  onPrevious,
  onNext,
  onToggleLike,
  onRepeat,
  repeatActive = false,
  download = null,
  onDownload,
}: TransportProps) {
  const busy = status === 'preparing' || status === 'buffering';
  const playing = status === 'playing';
  const playColor =
    variant === 'ios' ? 'var(--text-bright)' : 'var(--canvas)';
  return (
    <div className={`uw-transport uw-transport--${variant}`} role="group" aria-label="transport">
      <IconButton
        icon={liked ? 'heart-filled' : 'heart'}
        size={32}
        iconSize={14}
        color={liked ? 'var(--liked)' : 'var(--text-secondary)'}
        ariaLabel={liked ? 'unlike' : 'like'}
        active={liked}
        onPress={onToggleLike}
        className="uw-transport__side"
      />
      <IconButton
        icon="previous"
        size={36}
        iconSize={15}
        color="var(--text-primary)"
        ariaLabel="previous"
        disabled={!canPrevious}
        onPress={onPrevious}
        className="uw-transport__main"
      />
      <Pressable
        onPress={onPlayPause}
        ariaLabel={playing ? 'pause' : 'play'}
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
        ariaLabel="next"
        disabled={!canNext}
        onPress={onNext}
        className="uw-transport__main"
      />
      {variant === 'stage' && (
        <IconButton
          icon="repeat"
          size={32}
          iconSize={14}
          color={repeatActive ? 'var(--accent)' : 'var(--text-secondary)'}
          ariaLabel={
            onRepeat === undefined ? 'repeat — not wired yet' : 'repeat'
          }
          active={repeatActive}
          onPress={onRepeat}
          className="uw-transport__side"
        />
      )}
      {variant !== 'stage' && download !== null && (
        <IconButton
          icon={
            download === 'stored'
              ? 'check'
              : download === 'failed'
                ? 'warn'
                : 'download'
          }
          size={32}
          iconSize={14}
          color={
            download === 'failed'
              ? 'var(--warn)'
              : download === 'stored'
                ? 'var(--accent)'
                : 'var(--text-secondary)'
          }
          ariaLabel={
            download === 'stored'
              ? 'downloaded — remove'
              : download === 'failed'
                ? 'download failed — retry'
                : download === 'queued' || download === 'downloading'
                  ? 'downloading — cancel'
                  : 'download'
          }
          active={download === 'stored'}
          onPress={onDownload}
          className="uw-transport__side"
        />
      )}
    </div>
  );
}

const MODES: readonly { key: StageMode; label: string; icon: IconName }[] = [
  { key: 'player', label: 'player', icon: 'note' },
  { key: 'lyrics', label: 'lyrics', icon: 'lyrics' },
  { key: 'queue', label: 'queue', icon: 'queue' },
];

export function ModeSegment({
  mode,
  onSelect,
}: {
  readonly mode: StageMode;
  readonly onSelect?: ((mode: StageMode) => void) | undefined;
}) {
  return (
    <div className="uw-segment" role="tablist" aria-label="now playing panes">
      {MODES.map((m) => {
        const active = m.key === mode;
        return (
          <Pressable
            key={m.key}
            onPress={onSelect === undefined ? undefined : () => onSelect(m.key)}
            ariaLabel={m.label}
            ariaSelected={active}
            className={`uw-segment__item${active ? ' uw-segment__item--on' : ''}`}
          >
            <Icon
              name={m.icon}
              size={12}
              color={active ? 'var(--text-bright)' : 'var(--text-secondary)'}
            />
            <Text
              variant="metadata"
              color={active ? 'bright' : 'secondary'}
              className={active ? 'uw-text--bold' : undefined}
            >
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </div>
  );
}

function DownloadButton({
  download,
  onDownload,
  size = 28,
  iconSize = 14,
}: {
  readonly download: DownloadChip | null;
  readonly onDownload?: (() => void) | undefined;
  readonly size?: number | undefined;
  readonly iconSize?: number | undefined;
}) {
  if (download === null) {
    // Surfaces without a download ledger show the affordance honestly
    // disabled rather than hiding it (IconButton off when no onPress).
    return (
      <IconButton
        icon="download"
        size={size}
        iconSize={iconSize}
        color="var(--text-secondary)"
        ariaLabel="download — not available yet"
      />
    );
  }
  return (
    <IconButton
      icon={
        download === 'stored'
          ? 'check'
          : download === 'failed'
            ? 'warn'
            : 'download'
      }
      size={size}
      iconSize={iconSize}
      color={
        download === 'failed'
          ? 'var(--warn)'
          : download === 'stored'
            ? 'var(--accent)'
            : 'var(--text-secondary)'
      }
      ariaLabel={
        download === 'stored'
          ? 'downloaded — remove'
          : download === 'failed'
            ? 'download failed — retry'
            : download === 'queued' || download === 'downloading'
              ? 'downloading — cancel'
              : 'download'
      }
      active={download === 'stored'}
      onPress={onDownload}
    />
  );
}

/** The queue mode body — tools row + the list. Shared by the live stage
 *  and the idle stage so the reorder affordance is reachable in both. */
function QueuePane({
  queue,
  queueReordering = false,
  queueScrollEnabled = true,
  onPressQueueItem,
  onRemoveQueueItem,
  onToggleQueueReorder,
  onMoveQueueItem,
  onMoveQueueItemTo,
}: Pick<
  NowPlayingScreenProps,
  | 'queue'
  | 'queueReordering'
  | 'queueScrollEnabled'
  | 'onPressQueueItem'
  | 'onRemoveQueueItem'
  | 'onToggleQueueReorder'
  | 'onMoveQueueItem'
  | 'onMoveQueueItemTo'
>) {
  if (queue === undefined) {
    return <EmptyState title="queue is empty" icon="queue" />;
  }
  return (
    <>
      {onToggleQueueReorder !== undefined && (
        <div className="uw-stage__queue-tools">
          <IconButton
            icon="drag-handle"
            size={32}
            iconSize={14}
            color={
              queueReordering ? 'var(--accent)' : 'var(--text-secondary)'
            }
            ariaLabel={queueReordering ? 'done reordering' : 'reorder queue'}
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
  readonly onRepeat?: (() => void) | undefined;
  readonly repeatActive?: boolean | undefined;
  readonly download?: DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
  readonly onAddToPlaylist?: (() => void) | undefined;
  readonly onSeek?: ((ms: number) => void) | undefined;
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

export type StageModesProps = NowPlayingScreenProps & {
  /** The resolved pane — controlled or the caller's internal state. */
  readonly mode: StageMode;
  readonly transportVariant?: TransportVariant | undefined;
  /**
   * Extra control rows appended under the transport in player mode —
   * the column's volume row lives here.
   */
  readonly afterTransport?: ReactNode | undefined;
};

/**
 * The three stage-mode bodies, unrooted — shared by the overlay
 * (NowPlayingScreen/StageSheet wraps it in `.uw-stage`) and the
 * persistent StageColumn.
 */
export function StageModes({
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
  onRepeat,
  repeatActive = false,
  download = null,
  onDownload,
  onAddToPlaylist,
  onSeek,
  onRetryLyrics,
  onStartRadio,
  onStopRadio,
  onPressQueueItem,
  onRemoveQueueItem,
  onToggleQueueReorder,
  onMoveQueueItem,
  onMoveQueueItemTo,
  transportVariant = 'm3e',
  afterTransport,
}: StageModesProps) {
  return (
    <>
      {mode === 'player' && (
        <>
          <div className="uw-stage__art">
            <Artwork url={player.artworkUrl} fill />
          </div>
          <div className="uw-stage__meta">
            <div className="uw-stage__meta-text">
              <Text variant="title" color="bright" numberOfLines={1}>
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
            {(download !== null || onDownload !== undefined || onAddToPlaylist !== undefined) && (
              <div className="uw-stage__meta-actions">
                <DownloadButton
                  download={download}
                  onDownload={onDownload}
                />
                <IconButton
                  icon="list-plus"
                  size={28}
                  iconSize={13}
                  color="var(--text-secondary)"
                  ariaLabel="add to playlist"
                  onPress={onAddToPlaylist}
                />
              </div>
            )}
          </div>
          <WaveformSeek
            positionMs={player.positionMs}
            durationMs={player.durationMs}
            onSeek={onSeek}
          />
          <TransportControls
            variant={transportVariant}
            status={player.status}
            liked={player.liked}
            canPrevious={player.canPrevious}
            canNext={player.canNext}
            onPlayPause={onPlayPause}
            onPrevious={onPrevious}
            onNext={onNext}
            onToggleLike={onToggleLike}
            onRepeat={onRepeat}
            repeatActive={repeatActive}
            download={download}
            onDownload={onDownload}
          />
          {afterTransport}
          {/*
           * The live radio element: a seed affordance when no tail is
           * armed, the tail's honest status when one is — 'failed'
           * carries the typed message, and stop always clears.
           */}
          {radio !== undefined && (radio.armed || onStartRadio !== undefined) && (
            <div className="uw-stage__radio">
              <Icon
                name="radio"
                size={13}
                color={
                  radio.armed && radio.status !== 'failed'
                    ? 'var(--accent)'
                    : 'var(--text-secondary)'
                }
              />
              {radio.armed ? (
                <>
                  <Text
                    variant="metadata"
                    color={radio.status === 'failed' ? 'warn' : 'secondary'}
                  >
                    {radio.label}
                    {radio.fetching ? ' · fetching' : ''}
                    {radio.detail === null ? '' : ` · ${radio.detail}`}
                  </Text>
                  <Pressable
                    onPress={onStopRadio}
                    ariaLabel="stop radio"
                    className="uw-stage__radio-action"
                  >
                    <Text variant="metadata" color="primary">
                      stop
                    </Text>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  onPress={onStartRadio}
                  ariaLabel="start radio"
                  className="uw-stage__radio-action"
                >
                  <Text variant="metadata" color="secondary">
                    start radio
                  </Text>
                </Pressable>
              )}
            </div>
          )}
        </>
      )}
      {mode === 'lyrics' && (
        <>
          <div className="uw-stage__meta uw-stage__meta--lyrics">
            <div className="uw-stage__meta-text">
              <Text variant="body" color="bright" numberOfLines={1}>
                {player.title}
              </Text>
              <Text variant="metadata" color="secondary" numberOfLines={1}>
                {player.artist ?? '—'}
                {lyrics?.syncLabel != null ? ` · ${lyrics.syncLabel}` : ''}
              </Text>
            </div>
            <div className="uw-stage__meta-actions">
              <IconButton
                icon="pin"
                size={28}
                iconSize={13}
                color="var(--text-secondary)"
                ariaLabel="pin lyrics — not wired yet"
              />
            </div>
          </div>
          {/*
           * Honest lyrics: only `state === 'synced'` highlights the
           * active line — plain text never gets synced treatment,
           * instrumental/unavailable/error are explicit states, and
           * loading is bounded by the session's own op deadline.
           */}
          {lyrics === undefined ? (
            <EmptyState title="no lyrics" icon="lyrics" />
          ) : lyrics.state === 'loading' ? (
            <LoadingState title="loading lyrics" />
          ) : lyrics.state === 'error' ? (
            <ErrorState
              title="couldn't load lyrics"
              hint={lyrics.message}
              onRetry={onRetryLyrics}
            />
          ) : lyrics.state === 'instrumental' ? (
            <EmptyState
              title="instrumental"
              hint={lyrics.message}
              icon="lyrics"
            />
          ) : lyrics.state === 'unavailable' ? (
            <EmptyState
              title="no lyrics"
              hint={lyrics.message}
              icon="lyrics"
            />
          ) : lyrics.lines.length === 0 ? (
            <EmptyState title="no lyrics" icon="lyrics" />
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
      {mode === 'queue' && (
        <div className="uw-stage__queue">
          <QueuePane
            queue={queue}
            queueReordering={queueReordering}
            queueScrollEnabled={queueScrollEnabled}
            onPressQueueItem={onPressQueueItem}
            onRemoveQueueItem={onRemoveQueueItem}
            onToggleQueueReorder={onToggleQueueReorder}
            onMoveQueueItem={onMoveQueueItem}
            onMoveQueueItemTo={onMoveQueueItemTo}
          />
        </div>
      )}
    </>
  );
}

function useStageMode(
  mode: StageMode | undefined,
  onModeChange: ((mode: StageMode) => void) | undefined,
): readonly [StageMode, (next: StageMode) => void] {
  const [internalMode, setInternalMode] = useState<StageMode>('player');
  const activeMode = mode ?? internalMode;
  const select = useCallback(
    (next: StageMode) => {
      setInternalMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );
  return [activeMode, select];
}

export function NowPlayingScreen(props: NowPlayingScreenProps) {
  const [activeMode, selectMode] = useStageMode(props.mode, props.onModeChange);
  return (
    <div className="uw-stage" data-mode={activeMode}>
      <StageModes {...props} mode={activeMode} transportVariant="m3e" />
      <ModeSegment mode={activeMode} onSelect={selectMode} />
    </div>
  );
}

export type StageColumnProps = Omit<NowPlayingScreenProps, 'player'> & {
  /**
   * The playing track — null is an honest idle stage ("nothing
   * playing"), not a missing player.
   */
  readonly player: PlayerModel | null;
  /**
   * The output-device readout — the contract's audio-output affordance
   * has no backend surface on this build, so the pill is a read-only
   * label with a caret, not a picker trigger.
   */
  readonly outputLabel?: string | undefined;
  /** Collapse the column — the world takes the full window then. */
  readonly onCollapse?: (() => void) | undefined;
  /** Playback volume 0–1; without a setter the row renders disabled. */
  readonly volume?: number | undefined;
  readonly onVolumeChange?: ((volume: number) => void) | undefined;
};

/**
 * The desktop stage as a persistent column — the same mode bodies the
 * StageSheet hosts, framed by the stage-top strip (output readout +
 * collapse) and the pinned mode segment.
 */
export function StageColumn({
  outputLabel = 'default output',
  onCollapse,
  volume,
  onVolumeChange,
  player,
  queue,
  queueReordering = false,
  queueScrollEnabled = true,
  onPressQueueItem,
  onRemoveQueueItem,
  onToggleQueueReorder,
  onMoveQueueItem,
  onMoveQueueItemTo,
  ...rest
}: StageColumnProps) {
  const [activeMode, selectMode] = useStageMode(rest.mode, rest.onModeChange);
  return (
    <div className="uw-stage-col" data-mode={activeMode}>
      <div className="uw-stage-top">
        <div
          className="uw-stage-pill"
          title={`audio output · ${outputLabel}`}
        >
          <Icon name="monitor" size={12} color="var(--text-secondary)" />
          <Text variant="metadata" color="secondary">
            {outputLabel}
          </Text>
          <span className="uw-stage-pill__caret" aria-hidden="true" />
        </div>
        <IconButton
          icon="sidebar"
          size={28}
          iconSize={13}
          color="var(--text-secondary)"
          ariaLabel="hide stage"
          onPress={onCollapse}
          className="uw-stage-top__side"
        />
      </div>
      {player === null ? (
        <>
          {activeMode === 'player' && (
            <EmptyState title="nothing playing" icon="note" />
          )}
          {activeMode === 'lyrics' && (
            <EmptyState title="no lyrics" icon="lyrics" />
          )}
          {activeMode === 'queue' && (
            <div className="uw-stage__queue">
              <QueuePane
                queue={queue}
                queueReordering={queueReordering}
                queueScrollEnabled={queueScrollEnabled}
                onPressQueueItem={onPressQueueItem}
                onRemoveQueueItem={onRemoveQueueItem}
                onToggleQueueReorder={onToggleQueueReorder}
                onMoveQueueItem={onMoveQueueItem}
                onMoveQueueItemTo={onMoveQueueItemTo}
              />
            </div>
          )}
        </>
      ) : (
        <StageModes
          {...rest}
          player={player}
          queue={queue}
          queueReordering={queueReordering}
          queueScrollEnabled={queueScrollEnabled}
          onPressQueueItem={onPressQueueItem}
          onRemoveQueueItem={onRemoveQueueItem}
          onToggleQueueReorder={onToggleQueueReorder}
          onMoveQueueItem={onMoveQueueItem}
          onMoveQueueItemTo={onMoveQueueItemTo}
          mode={activeMode}
          transportVariant="stage"
          afterTransport={
            <div className="uw-vol" role="group" aria-label="volume">
              <Icon
                name="volume"
                size={14}
                color="var(--text-secondary)"
              />
              <input
                type="range"
                className={`uw-vol__input${onVolumeChange === undefined ? ' uw-off' : ''}`}
                aria-label="volume"
                aria-valuetext={`${Math.round((volume ?? 1) * 100)}%`}
                min={0}
                max={1}
                step="any"
                value={volume ?? 1}
                disabled={onVolumeChange === undefined}
                onChange={
                  onVolumeChange === undefined
                    ? undefined
                    : (event) =>
                        onVolumeChange(Number(event.currentTarget.value))
                }
                style={
                  {
                    '--uw-fill': `${(volume ?? 1) * 100}%`,
                  } as CSSProperties
                }
              />
            </div>
          }
        />
      )}
      <ModeSegment mode={activeMode} onSelect={selectMode} />
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
      aria-label="now playing"
      data-sheet="stage"
    >
      <NowPlayingScreen {...rest} />
    </div>
  );
}
