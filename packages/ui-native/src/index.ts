export { ThemeProvider, useTheme } from './theme.tsx';
export type { Theme, ThemeProviderProps } from './theme.tsx';

export {
    ArtworkResolverProvider,
    useArtworkResolver,
    useResolvedArtworkUri,
} from './artwork.tsx';
export type {
    ArtworkResolver,
    ArtworkResolverProviderProps,
} from './artwork.tsx';

export * from '@auqw/ui-shared';

export {
    Artwork,
    EqBars,
    Hairline,
    HeartIcon,
    Icon,
    IconButton,
    PlayPauseIcon,
    Pressable,
    Spinner,
    Text,
} from './primitives.tsx';
export type {
    ArtworkProps,
    IconButtonProps,
    IconName,
    IconProps,
    PressableProps,
    TextColor,
    TextProps,
    TextVariant,
} from './primitives.tsx';

export {
    ArtworkRing,
    LinearScrubber,
    SQUARED_RING_LENGTH,
    SQUARED_RING_PATH,
    ringVariantFor,
    WaveformSeek,
} from './progress.tsx';
export type {
    ArtworkRingProps,
    LinearScrubberProps,
    WaveformSeekProps,
} from './progress.tsx';

export { TrackRow } from './track-row.tsx';
export type { TrackRowProps } from './track-row.tsx';

export {
    EmptyState,
    ErrorState,
    LoadingState,
    UnavailableState,
} from './states.tsx';
export type { StateViewProps } from './states.tsx';

export { AndroidNavbar, AppNavbar, IosGlassNavbar } from './navbar.tsx';
export type { AppNavbarProps, NavbarProps } from './navbar.tsx';

// Extensionless specifiers for platform-split modules: an explicit
// '.tsx' resolves to the shared file literally under Metro and the
// '.native.tsx' variant is never considered.
export { PlatformTabs } from './platform-tabs';
export type { PlatformTabsProps } from './platform-tabs';
export { AppStack, PushScreen, SheetScreen, StackItem } from './stack';
export type {
  AppStackProps,
  PushScreenProps,
  SheetScreenProps,
  StackItemProps,
} from './stack';

export { MiniPlayer } from './mini-player.tsx';
export type { MiniPlayerProps } from './mini-player.tsx';

export { ModeSegment, StageSheet, TransportControls } from './stage-sheet.tsx';
export type { StageSheetProps, TransportProps } from './stage-sheet.tsx';

export { QueueList } from './queue-list';
export type { QueueListProps } from './queue-list';

export { SearchScreen } from './search-screen.tsx';
export type { SearchScreenProps } from './search-screen.tsx';

export { LibraryScreen } from './library-screen.tsx';
export type { LibraryScreenProps } from './library-screen.tsx';

export { CollectionScreen } from './collection-screen.tsx';
export type { CollectionScreenProps } from './collection-screen.tsx';

export { PlaylistScreen } from './playlist-screen.tsx';
export type { PlaylistScreenProps } from './playlist-screen.tsx';

export { EntityScreen } from './entity-screen.tsx';
export type { EntityScreenProps } from './entity-screen.tsx';

export {
    AddToPlaylistSheet,
    LanguagePickerSheet,
    NameField,
    ProviderPickerSheet,
    RowActionsSheet,
    ValueFieldSheet,
} from './sheets.tsx';
export type {
    PlaylistPickerItem,
    ProviderPickerOption,
    SheetAction,
} from './sheets.tsx';

export { QueueScreen } from './queue-screen.tsx';
export type { QueueScreenProps } from './queue-screen.tsx';

export { SettingsScreen } from './settings-screen.tsx';
export type { SettingsScreenProps } from './settings-screen.tsx';

export { CorrectionsScreen } from './corrections-screen.tsx';
export type { CorrectionsScreenProps } from './corrections-screen.tsx';

export { TransferScreen } from './transfer-screen.tsx';
export type { TransferScreenProps } from './transfer-screen.tsx';

export { SyncScreen } from './sync-screen.tsx';
export type { SyncScreenProps } from './sync-screen.tsx';

export { HomeScreen } from './home-screen.tsx';
export type { HomeScreenProps } from './home-screen.tsx';

export { GalleryScreen } from './gallery.tsx';

export * as fixtures from '@auqw/ui-shared/fixtures';
