import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ThemeName } from '@auqw/design-tokens';
import { ThemeProvider } from './theme.tsx';
import {
  Artwork,
  EqBars,
  Icon,
  IconButton,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { ArtworkRing, LinearScrubber, WaveformSeek } from './progress.tsx';
import { TrackRow } from './track-row.tsx';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
} from './states.tsx';
import { MiniPlayer } from './mini-player.tsx';
import { DesktopChrome, DesktopSidebar } from './chrome.tsx';
import { NowPlayingScreen, StageSheet, TransportControls } from './now-playing-screen.tsx';
import { QueueScreen } from './queue-screen.tsx';
import { SearchScreen } from './search-screen.tsx';
import { LibraryScreen } from './library-screen.tsx';
import { CollectionScreen } from './collection-screen.tsx';
import { PlaylistScreen } from './playlist-screen.tsx';
import { EntityScreen } from './entity-screen.tsx';
import {
  AddToPlaylistSheet,
  ProviderPickerSheet,
  RowActionsSheet,
  Sheet,
} from './sheets.tsx';
import { SettingsScreen } from './settings-screen.tsx';
import { CorrectionsScreen } from './corrections-screen.tsx';
import { TransferScreen } from './transfer-screen.tsx';
import { HomeScreen } from './home-screen.tsx';
import {
  fixtureCollectionModels,
  fixtureCorrectionsModel,
  fixtureCorrectionsModelEmpty,
  fixtureCorrectionsModelError,
  fixtureCorrectionsModelLoading,
  fixtureCorrectionsModelPending,
  fixtureEntityModel,
  fixtureEntityModelError,
  fixtureEntityModelPartial,
  fixtureHomeModel,
  fixtureLibraryModel,
  fixtureLibraryModelEmpty,
  fixtureLyrics,
  fixtureLyricsError,
  fixtureLyricsInstrumental,
  fixtureLyricsPlain,
  fixtureLyricsUnavailable,
  fixtureNavItems,
  fixturePlayerBuffering,
  fixturePlayerFailed,
  fixturePlayerPaused,
  fixturePlayerPlaying,
  fixturePlaylistModel,
  fixturePlaylistModelEmpty,
  fixtureQueueModel,
  fixtureQueueModelPaused,
  fixtureRadioModels,
  fixtureRowStates,
  fixtureSchemeNames,
  fixtureSearchStates,
  fixtureSettingsModel,
  fixtureSettingsModelDegraded,
  fixtureTransferModelDone,
  fixtureTransferModelError,
  fixtureTransferModelPreview,
} from '@auqw/ui-shared/fixtures';
import type { PlayerModel } from '@auqw/ui-shared';

function noop() {}

function Chip({
  label,
  active,
  onPress,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      ariaLabel={label}
      ariaPressed={active}
      className={`uw-chip${active ? ' uw-chip--active' : ''}`}
    >
      <Text
        variant="metadata"
        color={active ? 'accent' : 'secondary'}
        className={active ? 'uw-text--bold' : undefined}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Section({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="uw-gallery__section">
      <Text
        variant="label"
        color="secondary"
        uppercase
        className="uw-gallery__label"
      >
        {title}
        {note === undefined ? '' : `  ${note}`}
      </Text>
      {children}
    </section>
  );
}

function Frame({
  height = 560,
  children,
}: {
  readonly height?: number | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="uw-frame" style={{ height }}>
      {children}
    </div>
  );
}

function IconSwatch({ name }: { readonly name: IconName }) {
  return (
    <div className="uw-icon-swatch">
      <Icon name={name} size={16} />
      <Text variant="metadata" color="secondary">
        {name}
      </Text>
    </div>
  );
}

const ICON_SET: readonly IconName[] = [
  'play',
  'pause',
  'next',
  'previous',
  'search',
  'heart',
  'heart-filled',
  'queue',
  'settings',
  'close',
  'drag-handle',
  'spinner',
  'warn',
  'download',
  'list-plus',
  'home',
  'compass',
  'library',
  'note',
  'repeat',
  'shuffle',
  'clock',
  'lyrics',
  'chevron-left',
  'chevron-right',
  'chevron-up',
  'chevron-down',
  'radio',
  'check',
  'menu',
  'monitor',
];

export function GalleryScreen() {
  const [scheme, setScheme] = useState<ThemeName>('dark');
  const [reduced, setReduced] = useState(false);
  const [nav, setNav] = useState('home');
  const [expanded, setExpanded] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [searchPhase, setSearchPhase] = useState(2);
  const [textScale, setTextScale] = useState(1);
  const [artworkCondition, setArtworkCondition] = useState('missing');
  return (
    <ThemeProvider theme={scheme} reducedMotion={reduced} textScale={textScale}>
      <div className="uw-gallery">
        <Text variant="display" color="bright">
          auqw ui-web
        </Text>
        <Text variant="metadata" color="secondary" className="uw-gallery__sub">
          fixture gallery · desktop renderer
        </Text>
        <div className="uw-gallery__chips">
          {fixtureSchemeNames.map((name) => (
            <Chip
              key={name}
              label={name}
              active={scheme === name}
              onPress={() => setScheme(name)}
            />
          ))}
          <Chip
            label="system"
            active={scheme === 'system'}
            onPress={() => setScheme('system')}
          />
          <Chip
            label={reduced ? 'reduced motion ✓' : 'reduced motion'}
            active={reduced}
            onPress={() => setReduced(!reduced)}
          />
          {[1, 2].map((scale) => (
            <Chip
              key={scale}
              label={`text ${scale}×`}
              active={textScale === scale}
              onPress={() => setTextScale(scale)}
            />
          ))}
        </div>

        <Section title="icons" note="custom svg · stroke from tokens">
          <div className="uw-gallery__icon-grid">
            {ICON_SET.map((name) => (
              <IconSwatch key={name} name={name} />
            ))}
          </div>
        </Section>

        <Section title="artwork stress" note="missing · slow · extreme">
          <div className="uw-gallery__chips">
            {['missing', 'slow', 'extreme'].map((condition) => (
              <Chip
                key={condition}
                label={condition}
                active={artworkCondition === condition}
                onPress={() => setArtworkCondition(condition)}
              />
            ))}
          </div>
          <div className="uw-gallery__row">
            <Artwork
              url={artworkCondition === 'missing' ? null : fixturePlayerPlaying.artworkUrl}
              size={112}
              loading={artworkCondition === 'slow'}
            />
            {artworkCondition === 'extreme' && (
              <>
                <Artwork url={fixtureRowStates[0]?.artworkUrl ?? null} size={112} />
                <Artwork url={fixtureRowStates[2]?.artworkUrl ?? null} size={112} />
                <Artwork url={fixtureRowStates[3]?.artworkUrl ?? null} size={112} />
              </>
            )}
          </div>
        </Section>

        <Section title="track rows" note="all states">
          {fixtureRowStates.map((row) => (
            <TrackRow
              key={row.key}
              row={row}
              onPress={noop}
              onToggleLike={noop}
              onContext={noop}
            />
          ))}
          <TrackRow
            row={fixtureRowStates[1] ?? {
              key: 'fallback',
              title: 'Fallback',
              versionLabel: null,
              artist: null,
              durationMs: null,
              artworkUrl: null,
              liked: false,
              playing: false,
              state: 'available',
              note: null,
              download: null,
            }}
            reorderControls="buttons"
            onMoveUp={noop}
            onMoveDown={noop}
            onRemove={noop}
          />
        </Section>

        <Section title="progress" note="ring · scrubber · waveform">
          <div className="uw-gallery__row">
            <ArtworkRing
              artworkUrl={fixturePlayerPlaying.artworkUrl}
              progress={0.54}
            />
            <ArtworkRing artworkUrl={null} progress={0.2} />
            <EqBars size={14} />
            <Spinner size={16} />
            <Artwork url={null} size={40} monogram="TC" />
          </div>
          <LinearScrubber positionMs={61_000} durationMs={180_000} onSeek={noop} />
          <WaveformSeek positionMs={90_000} durationMs={180_000} onSeek={noop} />
        </Section>

        <Section title="states" note="loading · empty · error · unavailable">
          <div className="uw-gallery__state-grid">
            <div className="uw-gallery__state-cell">
              <LoadingState title="searching" hint="roads portishead" />
            </div>
            <div className="uw-gallery__state-cell">
              <EmptyState title="queue is empty" hint="add tracks to hear them" icon="queue" />
            </div>
            <div className="uw-gallery__state-cell">
              <ErrorState title="search failed" hint="rate limited by provider" onRetry={noop} />
            </div>
            <div className="uw-gallery__state-cell">
              <UnavailableState title="search unavailable" hint="provider unavailable" />
            </div>
          </div>
        </Section>

        <Section title="mini player" note="playing · paused · buffering">
          {(
            [
              ['playing', fixturePlayerPlaying],
              ['paused', fixturePlayerPaused],
              ['buffering', fixturePlayerBuffering],
            ] as readonly [string, PlayerModel][]
          ).map(([label, player]) => (
            <div key={label} className="uw-gallery__stack">
              <Text variant="metadata" color="secondary">
                {label}
              </Text>
              <MiniPlayer
                player={player}
                onPress={noop}
                onPlayPause={noop}
                onNext={noop}
                onPrevious={noop}
                onToggleLike={noop}
                onDismiss={noop}
              />
            </div>
          ))}
        </Section>

        <Section title="desktop chrome" note="sidebar · header · mini player">
          <Frame height={420}>
            <DesktopChrome
              items={fixtureNavItems}
              activeKey={nav}
              onSelect={setNav}
              miniPlayer={
                <MiniPlayer
                  player={fixturePlayerPlaying}
                  onPress={noop}
                  onPlayPause={noop}
                  onNext={noop}
                  onToggleLike={noop}
                />
              }
            >
              <div className="uw-gallery__frame-list">
                {fixtureRowStates.slice(0, 6).map((row) => (
                  <TrackRow
                    key={row.key}
                    row={row}
                    onPress={noop}
                    onToggleLike={noop}
                    onContext={noop}
                  />
                ))}
              </div>
            </DesktopChrome>
          </Frame>
        </Section>

        <Section title="transport" note="m3e squircle · ios glass">
          {(['m3e', 'ios'] as const).map((variant) => (
            <div key={variant} className="uw-gallery__stack">
              <Text variant="metadata" color="secondary">
                {variant}
              </Text>
              <TransportControls
                variant={variant}
                status={fixturePlayerPlaying.status}
                liked={fixturePlayerPlaying.liked}
                canPrevious
                canNext
                onPlayPause={noop}
                onPrevious={noop}
                onNext={noop}
                onToggleLike={noop}
              />
            </div>
          ))}
        </Section>

        <Section title="now playing" note="screen · sheet · lyrics states">
          <div className="uw-gallery__chips">
            <Chip
              label={expanded ? 'sheet expanded' : 'sheet collapsed'}
              active={expanded}
              onPress={() => setExpanded(!expanded)}
            />
            <Chip
              label={sheetOpen ? 'open' : 'closed'}
              active={sheetOpen}
              onPress={() => setSheetOpen(true)}
            />
          </div>
          <Frame height={620}>
            <NowPlayingScreen
              player={fixturePlayerPlaying}
              queue={fixtureQueueModel}
              lyrics={fixtureLyrics}
              radio={fixtureRadioModels[1]}
              onPlayPause={noop}
              onNext={noop}
              onPrevious={noop}
              onToggleLike={noop}
              onSeek={noop}
              onStopRadio={noop}
            />
          </Frame>
          <Text variant="metadata" color="secondary">
            failed playback · honest error · failed radio tail
          </Text>
          <Frame height={620}>
            <NowPlayingScreen
              player={fixturePlayerFailed}
              radio={fixtureRadioModels[4]}
              onStopRadio={noop}
            />
          </Frame>
          <Text variant="metadata" color="secondary">
            lyrics · plain / instrumental / unavailable / error — never
            synced-treated
          </Text>
          {(
            [
              ['plain', fixtureLyricsPlain],
              ['instrumental', fixtureLyricsInstrumental],
              ['unavailable', fixtureLyricsUnavailable],
              ['error', fixtureLyricsError],
            ] as const
          ).map(([label, lyrics]) => (
            <div key={label} className="uw-gallery__stack">
              <Text variant="metadata" color="secondary">
                {label}
              </Text>
              <Frame height={420}>
                <NowPlayingScreen
                  player={fixturePlayerPlaying}
                  mode="lyrics"
                  lyrics={lyrics}
                  onRetryLyrics={noop}
                />
              </Frame>
            </div>
          ))}
          <Frame height={620}>
            <div className="uw-gallery__sheet-demo">
              <Sheet
                open={sheetOpen}
                label="now playing"
                onDismiss={() => setSheetOpen(false)}
              >
                <NowPlayingScreen
                  player={fixturePlayerPlaying}
                  queue={fixtureQueueModel}
                  lyrics={fixtureLyrics}
                  onPlayPause={noop}
                  onNext={noop}
                  onPrevious={noop}
                  onToggleLike={noop}
                  onSeek={noop}
                />
              </Sheet>
              <div className="uw-gallery__sheet-base">
                <Text variant="metadata" color="secondary">
                  sheet mounts over the base screen — Escape closes
                </Text>
              </div>
            </div>
          </Frame>
        </Section>

        <Section title="queue" note="duplicates · unavailable · reorder">
          <Frame height={480}>
            <QueueScreen
              queue={fixtureQueueModel}
              player={fixturePlayerPlaying}
              scrollEnabled={false}
              onPressItem={noop}
              onRemoveItem={noop}
            />
          </Frame>
          <Frame height={480}>
            <QueueScreen
              queue={fixtureQueueModelPaused}
              player={fixturePlayerPaused}
              reordering
              scrollEnabled={false}
              onToggleReorder={noop}
              onPressItem={noop}
              onRemoveItem={noop}
              onMoveItem={noop}
            />
          </Frame>
        </Section>

        <Section title="search" note="every phase">
          <div className="uw-gallery__chips">
            {fixtureSearchStates.map((s, i) => (
              <Chip
                key={s.phase}
                label={s.phase}
                active={searchPhase === i}
                onPress={() => setSearchPhase(i)}
              />
            ))}
          </div>
          {fixtureSearchStates[searchPhase] !== undefined && (
            <Frame height={520}>
              <SearchScreen
                state={fixtureSearchStates[searchPhase]}
                onQueryChange={noop}
                onCancel={noop}
                onRetry={noop}
                onResultPress={noop}
                onContext={noop}
                recents={['radiohead ok computer', 'boards of canada']}
                onRecentPress={noop}
                scrollEnabled={false}
              />
            </Frame>
          )}
        </Section>

        <Section title="library" note="collections · ownable grid · artists">
          <Frame height={560}>
            <LibraryScreen
              model={fixtureLibraryModel}
              onPressItem={noop}
              onToggleLike={noop}
              onContext={noop}
              onOpenCollection={noop}
              onPlayCollection={noop}
              onOpenCard={noop}
              onOpenArtist={noop}
              onCreatePlaylist={noop}
              scrollEnabled={false}
            />
          </Frame>
          <Text variant="metadata" color="secondary">
            empty library · honest empties
          </Text>
          <Frame height={560}>
            <LibraryScreen
              model={fixtureLibraryModelEmpty}
              onPressItem={noop}
              onToggleLike={noop}
              onContext={noop}
              onOpenCollection={noop}
              onPlayCollection={noop}
              onOpenCard={noop}
              onOpenArtist={noop}
              onCreatePlaylist={noop}
              scrollEnabled={false}
            />
          </Frame>
        </Section>

        <Section title="collection" note="top 50 · history ordering">
          {fixtureCollectionModels.map((collection) => (
            <div key={collection.key} className="uw-gallery__stack">
              <Text variant="metadata" color="secondary">
                {collection.title} · {collection.rows.length} rows
              </Text>
              <Frame height={380}>
                <CollectionScreen
                  model={collection}
                  onBack={noop}
                  onPlayAll={noop}
                  onPressItem={noop}
                  onToggleLike={noop}
                  onContext={noop}
                  scrollEnabled={false}
                />
              </Frame>
            </div>
          ))}
        </Section>

        <Section title="playlist" note="duplicates · reorder · empty">
          <Frame height={480}>
            <PlaylistScreen
              model={fixturePlaylistModel}
              onBack={noop}
              onPlayAll={noop}
              onRename={noop}
              onDelete={noop}
              onPressEntry={noop}
              onToggleLike={noop}
              onRemoveEntry={noop}
              onMoveEntry={noop}
              scrollEnabled={false}
            />
          </Frame>
          <Frame height={480}>
            <PlaylistScreen
              model={fixturePlaylistModelEmpty}
              onBack={noop}
              onPlayAll={noop}
              onRename={noop}
              onDelete={noop}
              scrollEnabled={false}
            />
          </Frame>
        </Section>

        <Section title="entity" note="complete · partial+continuation · error">
          <Frame height={480}>
            <EntityScreen
              model={fixtureEntityModel}
              onBack={noop}
              onToggleLike={noop}
              onPressItem={noop}
              onContext={noop}
              scrollEnabled={false}
            />
          </Frame>
          <Frame height={480}>
            <EntityScreen
              model={fixtureEntityModelPartial}
              onBack={noop}
              onToggleLike={noop}
              onPressItem={noop}
              onContext={noop}
              onLoadMore={noop}
              scrollEnabled={false}
            />
          </Frame>
          <Frame height={480}>
            <EntityScreen
              model={fixtureEntityModelError}
              onBack={noop}
              onRetry={noop}
              scrollEnabled={false}
            />
          </Frame>
        </Section>

        <Section title="sheets" note="row actions · add to playlist">
          <Frame height={420}>
            <div className="uw-gallery__panel">
              <RowActionsSheet
                title="Dracula"
                actions={[
                  { key: 'add', label: 'add to playlist', icon: 'list-plus' },
                  { key: 'album', label: 'open album', icon: 'note' },
                  { key: 'artist', label: 'open artist', icon: 'library' },
                ]}
                onAction={noop}
                onDismiss={noop}
              />
            </div>
          </Frame>
          <Frame height={460}>
            <div className="uw-gallery__panel">
              <AddToPlaylistSheet
                playlists={fixtureLibraryModel.cards
                  .filter((c) => c.kind === 'playlist' && c.playlistId !== null)
                  .map((c) => ({
                    playlistId: c.playlistId ?? '',
                    name: c.title,
                    count: c.count ?? 0,
                    artworkUrl: c.artworkUrl,
                  }))}
                onPick={noop}
                onCreate={noop}
                onDismiss={noop}
              />
            </div>
          </Frame>
          <Frame height={360}>
            <div className="uw-gallery__panel">
              <ProviderPickerSheet
                title="lyrics provider"
                options={[
                  { key: 'auto', label: 'auto', detail: 'route by capability' },
                  { key: 'lyrics-lrclib', label: 'lrclib', detail: 'lyrics.plain · lyrics.synced' },
                  { key: 'deezer', label: 'deezer', detail: 'lyrics.plain' },
                ]}
                selectedKey="lyrics-lrclib"
                onPick={noop}
                onDismiss={noop}
              />
            </div>
          </Frame>
        </Section>

        <Section title="settings" note="rows + diagnostics">
          <Frame height={620}>
            <SettingsScreen
              model={fixtureSettingsModel}
              onSelectRow={noop}
              onToggleRow={noop}
              onOpenCorrections={noop}
              scrollEnabled={false}
            />
          </Frame>
          <Frame height={620}>
            <SettingsScreen
              model={fixtureSettingsModelDegraded}
              onSelectRow={noop}
              onToggleRow={noop}
              onOpenCorrections={noop}
              scrollEnabled={false}
            />
          </Frame>
        </Section>

        <Section
          title="corrections"
          note="pending · resolved · empty · loading · error"
        >
          {(
            [
              ['all reviews', fixtureCorrectionsModel],
              ['pending only', fixtureCorrectionsModelPending],
              ['empty queue', fixtureCorrectionsModelEmpty],
              ['loading', fixtureCorrectionsModelLoading],
              ['error', fixtureCorrectionsModelError],
            ] as const
          ).map(([label, model]) => (
            <div key={label} className="uw-gallery__stack">
              <Text variant="metadata" color="secondary">
                {label}
              </Text>
              <Frame height={480}>
                <CorrectionsScreen
                  model={model}
                  onBack={noop}
                  onFilter={noop}
                  onConfirm={noop}
                  onReject={noop}
                  onUndo={noop}
                />
              </Frame>
            </div>
          ))}
        </Section>

        <Section
          title="transfer"
          note="preview → confirm → apply · typed errors"
        >
          {(
            [
              ['preview', fixtureTransferModelPreview],
              ['applied', fixtureTransferModelDone],
              ['error', fixtureTransferModelError],
            ] as const
          ).map(([label, model]) => (
            <div key={label} className="uw-gallery__stack">
              <Text variant="metadata" color="secondary">
                {label}
              </Text>
              <Frame height={520}>
                <TransferScreen
                  model={model}
                  onBack={noop}
                  onExport={noop}
                  onPickImportFile={noop}
                  onApplyImport={noop}
                  onResetImport={noop}
                />
              </Frame>
            </div>
          ))}
        </Section>

        <Section title="home" note="recents + suggestions">
          <Frame height={600}>
            <HomeScreen
              model={fixtureHomeModel}
              onPressCard={noop}
              onPressSeeAll={noop}
              scrollEnabled={false}
            />
          </Frame>
        </Section>
      </div>
    </ThemeProvider>
  );
}
