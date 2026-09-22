export { ThemeProvider, useTheme } from './theme.tsx';
export type { Theme, ThemeProviderProps } from './theme.tsx';

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
    WaveformSeek,
} from './progress.tsx';
export type {
    ArtworkRingProps,
    LinearScrubberProps,
    WaveformSeekProps,
} from './progress.tsx';

export { TrackRow, useTrackList } from './track-row.tsx';
export type { TrackListController, TrackRowProps } from './track-row.tsx';

export {
    EmptyState,
    ErrorState,
    LoadingState,
    UnavailableState,
} from './states.tsx';
export type { StateViewProps } from './states.tsx';

export { DesktopChrome, DesktopHeader, DesktopSidebar } from './chrome.tsx';
export type {
    DesktopChromeProps,
    DesktopHeaderProps,
    DesktopSidebarProps,
} from './chrome.tsx';

export { AppStack, PushScreen, SheetScreen, StackItem } from './stack.tsx';
export type {
  AppStackProps,
  PushScreenProps,
  SheetScreenProps,
  StackItemProps,
} from './stack.tsx';

export { MiniPlayer } from './mini-player.tsx';
export type { MiniPlayerProps } from './mini-player.tsx';

export {
    ModeSegment,
    NowPlayingScreen,
    StageSheet,
    TransportControls,
} from './now-playing-screen.tsx';
export type {
    NowPlayingScreenProps,
    StageSheetProps,
    TransportProps,
} from './now-playing-screen.tsx';

export { QueueList } from './queue-list.tsx';
export type { QueueListProps } from './queue-list.tsx';

export {
    globalKeyAction,
    initialRovingIndex,
    isEditableTarget,
    rowKeyAction,
    seekStepMs,
    sheetKeyAction,
} from './keyboard.ts';
export type { GlobalKeyAction, RowKeyAction } from './keyboard.ts';

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
    NameField,
    ProviderPickerSheet,
    RowActionsSheet,
    Sheet,
    SheetScaffold,
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

export { HomeScreen } from './home-screen.tsx';
export type { HomeScreenProps } from './home-screen.tsx';

export { GalleryScreen } from './gallery.tsx';

export {
    PLAY_LEFT,
    PLAY_RIGHT,
    PAUSE_LEFT,
    PAUSE_RIGHT,
    quadPath,
    progressPathState,
} from './motion.ts';
export type { Quad } from './motion.ts';

export * as fixtures from '@auqw/ui-shared/fixtures';
