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
} from '@auqw/ui-shared';

export type { LyricsModel, StageMode } from '@auqw/ui-shared';

export type TransportProps = {
  readonly variant?: 'm3e' | 'ios' | undefined;
  readonly status: PlayerModel['status'];
  readonly liked: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPlayPause?: (() => void) | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onToggleLike?: (() => void) | undefined;
  /** Owned-bytes state of the current track; null hides the button. */
  readonly download?: DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
};

// The desktop transport keeps the m3e layout (raised main pill,
// accent play slab) — the ios glass variant exists for parity.
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
  download = null,
  onDownload,
}: TransportProps) {
  const busy = status === 'preparing' || status === 'buffering';
  const playing = status === 'playing';
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
      {download !== null && (
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
              ? t('stage.download.storedA11y')
              : download === 'failed'
                ? t('stage.download.failedA11y')
                : download === 'queued' || download === 'downloading'
                  ? t('stage.download.busyA11y')
                  : t('stage.download.idleA11y')
          }
          active={download === 'stored'}
          onPress={onDownload}
          className="uw-transport__side"
        />
      )}
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
  readonly download?: DownloadChip | null | undefined;
  readonly onDownload?: (() => void) | undefined;
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
  download = null,
  onDownload,
  onSeek,
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
  return (
    <div className="uw-stage" data-mode={activeMode}>
      {activeMode === 'player' && (
        <>
          <div className="uw-stage__art">
            <Artwork url={player.artworkUrl} fill />
          </div>
          <div className="uw-stage__meta">
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
          <WaveformSeek
            positionMs={player.positionMs}
            durationMs={player.durationMs}
            onSeek={onSeek}
          />
          <TransportControls
            variant="m3e"
            status={player.status}
            liked={player.liked}
            canPrevious={player.canPrevious}
            canNext={player.canNext}
            onPlayPause={onPlayPause}
            onPrevious={onPrevious}
            onNext={onNext}
            onToggleLike={onToggleLike}
            download={download}
            onDownload={onDownload}
          />
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
                  <Text variant="metadata" color="secondary">
                    {t('stage.radio.start')}
                  </Text>
                </Pressable>
              )}
            </div>
          )}
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
