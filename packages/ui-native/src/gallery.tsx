import { useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, ThemeProvider } from './theme.tsx';
import {
  Artwork,
  EqBars,
  Icon,
  Pressable,
  Spinner,
  Text,
} from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import {
  ArtworkRing,
  LinearScrubber,
  WaveformSeek,
} from './progress.tsx';
import { TrackRow } from './track-row.tsx';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnavailableState,
} from './states.tsx';
import { AndroidNavbar, AppNavbar, IosGlassNavbar } from './navbar.tsx';
import { MiniPlayer } from './mini-player.tsx';
import { StageSheet, TransportControls } from './stage-sheet.tsx';
import { SearchScreen } from './search-screen.tsx';
import { LibraryScreen } from './library-screen.tsx';
import { CollectionScreen } from './collection-screen.tsx';
import { PlaylistScreen } from './playlist-screen.tsx';
import { EntityScreen } from './entity-screen.tsx';
import {
  AddToPlaylistSheet,
  ProviderPickerSheet,
  RowActionsSheet,
} from './sheets.tsx';
import { QueueScreen } from './queue-screen.tsx';
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
  fixtureLyricsError,
  fixtureLyricsInstrumental,
  fixtureLyricsPlain,
  fixtureLyricsUnavailable,
  fixturePlaylistModel,
  fixturePlaylistModelEmpty,
  fixtureLyrics,
  fixtureNavItems,
  fixtureRadioModels,
  fixtureTransferModelDone,
  fixtureTransferModelError,
  fixtureTransferModelPreview,
  fixturePlayerBuffering,
  fixturePlayerFailed,
  fixturePlayerPaused,
  fixturePlayerPlaying,
  fixtureQueueModel,
  fixtureQueueModelPaused,
  fixtureRowStates,
  fixtureSchemeNames,
  fixtureSearchStates,
  fixtureSettingsModel,
  fixtureSettingsModelDegraded,
} from './fixtures.ts';
import type { ThemeName } from '@auqw/design-tokens';

function noop() { }

function Chip({
  label,
  active,
  onPress,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={{
        paddingHorizontal: 12,
        minHeight: 28,
        justifyContent: 'center',
        borderRadius: 20,
        backgroundColor: active ? theme.colors.accentSoft : theme.colors.fg08,
      }}
    >
      <Text
        variant="metadata"
        color={active ? 'accent' : 'secondary'}
        style={active ? { fontFamily: theme.fontFamilies.bold } : undefined}
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
  const theme = useTheme();
  return (
    <View style={{ marginTop: theme.spacing.xxl }}>
      <Text
        variant="label"
        color="secondary"
        uppercase
        style={{ marginBottom: theme.spacing.sm }}
      >
        {title}
        {note === undefined ? '' : `  ${note}`}
      </Text>
      {children}
    </View>
  );
}

function Frame({
  height = 560,
  children,
}: {
  readonly height?: number | undefined;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: height * theme.textScale,
        borderWidth: theme.strokes.hairline,
        borderColor: theme.colors.divider,
        borderRadius: theme.radius.float,
        overflow: 'hidden',
        backgroundColor: theme.colors.canvas,
        position: 'relative',
      }}
    >
      {children}
    </View>
  );
}

function IconSwatch({ name }: { readonly name: IconName }) {
  return (
    <View style={{ alignItems: 'center', width: 52, gap: 4 }}>
      <Icon name={name} size={16} />
      <Text variant="metadata" color="secondary">
        {name}
      </Text>
    </View>
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
];

export function GalleryScreen() {
  const [scheme, setScheme] = useState<ThemeName>('dark');
  const [reduced, setReduced] = useState(false);
  const [nav, setNav] = useState('home');
  const [expanded, setExpanded] = useState(true);
  const [searchPhase, setSearchPhase] = useState(2);
  const [textScale, setTextScale] = useState(1);
  const [artworkCondition, setArtworkCondition] = useState('missing');
  const [gestureState, setGestureState] = useState<'rest' | 'mid-drag' | 'dismissed'>('rest');
  return (
    <ThemeProvider theme={scheme} reducedMotion={reduced} textScale={textScale}>
      <GalleryBody
        scheme={scheme}
        setScheme={setScheme}
        reduced={reduced}
        setReduced={setReduced}
        nav={nav}
        setNav={setNav}
        expanded={expanded}
        setExpanded={setExpanded}
        searchPhase={searchPhase}
        setSearchPhase={setSearchPhase}
        textScale={textScale}
        setTextScale={setTextScale}
        artworkCondition={artworkCondition}
        setArtworkCondition={setArtworkCondition}
        gestureState={gestureState}
        setGestureState={setGestureState}
      />
    </ThemeProvider>
  );
}

function GalleryBody({
  scheme,
  setScheme,
  reduced,
  setReduced,
  nav,
  setNav,
  expanded,
  setExpanded,
  searchPhase,
  setSearchPhase,
  textScale,
  setTextScale,
  artworkCondition,
  setArtworkCondition,
  gestureState,
  setGestureState,
}: {
  readonly scheme: ThemeName;
  readonly setScheme: (t: ThemeName) => void;
  readonly reduced: boolean;
  readonly setReduced: (b: boolean) => void;
  readonly nav: string;
  readonly setNav: (k: string) => void;
  readonly expanded: boolean;
  readonly setExpanded: (b: boolean) => void;
  readonly searchPhase: number;
  readonly setSearchPhase: (i: number) => void;
  readonly textScale: number;
  readonly setTextScale: (value: number) => void;
  readonly artworkCondition: string;
  readonly setArtworkCondition: (value: string) => void;
  readonly gestureState: 'rest' | 'mid-drag' | 'dismissed';
  readonly setGestureState: (value: 'rest' | 'mid-drag' | 'dismissed') => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const search = fixtureSearchStates[searchPhase] ?? fixtureSearchStates[0];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.canvas }}
      contentContainerStyle={{
        padding: theme.spacing.lg,
        paddingTop: insets.top + theme.spacing.lg,
        paddingBottom: insets.bottom + theme.spacing.display,
      }}
    >
      <Text variant="display" color="bright">
        auqw ui-native
      </Text>
      <Text variant="metadata" color="secondary" style={{ marginTop: 4 }}>
        fixture gallery · omarchy shell
      </Text>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: theme.spacing.sm,
          marginTop: theme.spacing.md,
        }}
      >
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
      </View>

      <Section title="icons" note="custom svg · stroke from tokens">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {ICON_SET.map((name) => (
            <IconSwatch key={name} name={name} />
          ))}
        </View>
      </Section>

      <Section title="artwork stress" note="missing · slow · extreme">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md, marginBottom: theme.spacing.sm }}>
          {['missing', 'slow', 'extreme'].map((condition) => (
            <Chip
              key={condition}
              label={condition}
              active={artworkCondition === condition}
              onPress={() => setArtworkCondition(condition)}
            />
          ))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.lg }}>
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
        </View>
      </Section>

      <Section title="track rows" note="all states">
        <View style={{ paddingHorizontal: 6 }}>
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
        </View>
      </Section>

      <Section title="progress" note="ring · scrubber · waveform">
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.lg,
            paddingVertical: theme.spacing.sm,
          }}
        >
          <ArtworkRing
            artworkUrl={fixturePlayerPlaying.artworkUrl}
            progress={0.54}
            platform="android"
          />
          <ArtworkRing
            artworkUrl={fixturePlayerPlaying.artworkUrl}
            progress={0.54}
            platform="ios"
          />
          <ArtworkRing
            artworkUrl={null}
            progress={0.2}
            platform="android"
          />
          <EqBars size={14} />
          <Spinner size={16} />
          <Artwork url={null} size={40} monogram="TC" />
        </View>
        <LinearScrubber positionMs={61_000} durationMs={180_000} onSeek={noop} />
        <WaveformSeek positionMs={90_000} durationMs={180_000} onSeek={noop} />
      </Section>

      <Section title="states" note="loading · empty · error · unavailable">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <View style={{ width: '50%', height: 160 }}>
            <LoadingState title="searching" hint="roads portishead" onCancel={noop} />
          </View>
          <View style={{ width: '50%', height: 160 }}>
            <EmptyState title="queue is empty" hint="add tracks to hear them" icon="queue" />
          </View>
          <View style={{ width: '50%', height: 160 }}>
            <ErrorState title="search failed" hint="rate limited by provider" onRetry={noop} />
          </View>
          <View style={{ width: '50%', height: 160 }}>
            <UnavailableState title="search unavailable" hint="provider unavailable" />
          </View>
        </View>
      </Section>

      <Section title="mini player" note="android wavy ring · ios glass">
        {(['android', 'ios'] as const).map((platform) => (
          <View key={platform} style={{ marginBottom: theme.spacing.md }}>
            <Text variant="metadata" color="secondary" style={{ marginBottom: 4 }}>
              {platform} · playing
            </Text>
            <MiniPlayer
              player={fixturePlayerPlaying}
              platform={platform}
              onPress={noop}
              onPlayPause={noop}
              onNext={noop}
              onPrevious={noop}
              onToggleLike={noop}
            />
            <MiniPlayer
              player={fixturePlayerPaused}
              platform={platform}
              onPress={noop}
              onPlayPause={noop}
              onNext={noop}
            />
            <MiniPlayer
              player={fixturePlayerBuffering}
              platform={platform}
              onPress={noop}
              onPlayPause={noop}
              onNext={noop}
            />
          </View>
        ))}
      </Section>

      <Section title="navbars" note="m3e bar · liquid glass capsule">
        <AndroidNavbar items={fixtureNavItems} activeKey={nav} onSelect={setNav} gestureHandle />
        <View style={{ height: theme.spacing.md }} />
        <IosGlassNavbar items={fixtureNavItems} activeKey={nav} onSelect={setNav} gestureHandle />
      </Section>

      <Section title="transport" note="m3e squircle · ios glass">
        {(['m3e', 'ios'] as const).map((variant) => (
          <View key={variant} style={{ marginBottom: theme.spacing.md }}>
            <Text variant="metadata" color="secondary" style={{ marginBottom: 4 }}>
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
          </View>
        ))}
      </Section>

      <Section title="phone composition" note="list + mini + navbar">
        {(['android', 'ios'] as const).map((platform) => (
          <View key={platform} style={{ marginBottom: theme.spacing.lg }}>
            <Text variant="metadata" color="secondary" style={{ marginBottom: 4 }}>
              {platform}
            </Text>
            <Frame height={520}>
              <View style={{ flex: 1, paddingHorizontal: 6, paddingTop: theme.spacing.sm }}>
                {fixtureRowStates.slice(0, 6).map((row) => (
                  <TrackRow
                    key={row.key}
                    row={row}
                    onPress={noop}
                    onToggleLike={noop}
                    onContext={noop}
                  />
                ))}
              </View>
              <MiniPlayer
                player={fixturePlayerPlaying}
                platform={platform}
                onPress={noop}
                onPlayPause={noop}
                onNext={noop}
                onToggleLike={noop}
              />
              <AppNavbar
                platform={platform}
                items={fixtureNavItems}
                activeKey={nav}
                onSelect={setNav}
                gestureHandle
              />
            </Frame>
          </View>
        ))}
      </Section>

      <Section title="stage sheet" note="rest · mid-drag · dismissed">
        <View
          style={{
            flexDirection: 'row',
            gap: theme.spacing.sm,
            marginBottom: theme.spacing.sm,
          }}
        >
          {(['rest', 'mid-drag', 'dismissed'] as const).map((state) => (
            <Chip
              key={state}
              label={state}
              active={gestureState === state}
              onPress={() => {
                setGestureState(state);
                setExpanded(state !== 'dismissed');
              }}
            />
          ))}
        </View>
        {(['android', 'ios'] as const).map((platform) => (
          <View key={platform} style={{ marginBottom: theme.spacing.lg }}>
            <Text variant="metadata" color="secondary" style={{ marginBottom: 4 }}>
              {platform} · {platform === 'android' ? 'm3e controls' : 'glass controls'}
            </Text>
            <Frame height={620}>
              <StageSheet
                player={fixturePlayerPlaying}
                platform={platform}
                expanded={expanded}
                dragPreview={gestureState}
                queueScrollEnabled={false}
                onExpandChange={setExpanded}
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
          </View>
        ))}
        <Text variant="metadata" color="secondary">
          failed playback · honest error · failed radio tail
        </Text>
        <Frame height={620}>
          <StageSheet
            player={fixturePlayerFailed}
            platform="android"
            expanded
            onExpandChange={noop}
            radio={fixtureRadioModels[4]}
            onStopRadio={noop}
          />
        </Frame>
        <View style={{ height: theme.spacing.md }} />
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
          <View key={label} style={{ marginTop: theme.spacing.sm }}>
            <Text
              variant="metadata"
              color="secondary"
              style={{ marginBottom: 4 }}
            >
              {label}
            </Text>
            <Frame height={420}>
              <StageSheet
                player={fixturePlayerPlaying}
                platform="android"
                expanded
                mode="lyrics"
                lyrics={lyrics}
                onExpandChange={noop}
                onRetryLyrics={noop}
              />
            </Frame>
          </View>
        ))}
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
        <View style={{ height: theme.spacing.md }} />
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
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.sm,
            marginBottom: theme.spacing.sm,
          }}
        >
          {fixtureSearchStates.map((s, i) => (
            <Chip
              key={s.phase}
              label={s.phase}
              active={searchPhase === i}
              onPress={() => setSearchPhase(i)}
            />
          ))}
        </View>
        {search !== undefined && (
          <Frame height={520}>
            <SearchScreen
              state={search}
              onQueryChange={noop}
              onCancel={noop}
              onRetry={noop}
              onResultPress={noop}
              onContext={noop}
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
        <View style={{ height: theme.spacing.md }} />
        <Text variant="metadata" color="secondary" style={{ marginBottom: 4 }}>
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
          <View key={collection.key} style={{ marginBottom: theme.spacing.md }}>
            <Text variant="metadata" color="secondary" style={{ marginBottom: 4 }}>
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
          </View>
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
        <View style={{ height: theme.spacing.md }} />
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
        <View style={{ height: theme.spacing.md }} />
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
        <View style={{ height: theme.spacing.md }} />
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
          <View style={{ flex: 1 }}>
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
          </View>
        </Frame>
        <View style={{ height: theme.spacing.md }} />
        <Frame height={460}>
          <View style={{ flex: 1 }}>
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
          </View>
        </Frame>
        <View style={{ height: theme.spacing.md }} />
        <Frame height={360}>
          <View style={{ flex: 1 }}>
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
          </View>
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
        <View style={{ height: theme.spacing.md }} />
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
          <View key={label} style={{ marginBottom: theme.spacing.md }}>
            <Text
              variant="metadata"
              color="secondary"
              style={{ marginBottom: 4 }}
            >
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
          </View>
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
          <View key={label} style={{ marginBottom: theme.spacing.md }}>
            <Text
              variant="metadata"
              color="secondary"
              style={{ marginBottom: 4 }}
            >
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
          </View>
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
    </ScrollView>
  );
}
