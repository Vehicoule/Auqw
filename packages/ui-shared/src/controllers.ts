/**
 * Headless screen controllers — the shared half of each ui-web /
 * ui-native screen pair: label resolution, phase dispatch, and
 * per-row bound callbacks. A controller returns a plain view
 * description; the screen file binds it to platform primitives and
 * owns everything visual (colors, layout, motion, navigation idioms).
 * Labels resolve inside the hooks — translated strings are never
 * cached at module scope or they go stale on a locale switch.
 */
import { useMemo, useState } from 'react';
import type { ThemeName } from '@auqw/design-tokens';
import type { RepeatMode } from '@auqw/application';
import { t } from './i18n.ts';
import type { MessageId } from './i18n.ts';
import { formatClock } from './view-models.ts';
import type {
  ArtistRailModel,
  CollectionKey,
  CorrectionsFilter,
  CorrectionsModel,
  DownloadChip,
  EntityScreenModel,
  ImportPreviewModel,
  LibraryCardModel,
  LibraryModel,
  LyricsModel,
  PlayerModel,
  QueueModel,
  QueueSectionKey,
  RadioModel,
  ReviewRowModel,
  SearchStateModel,
  StageMode,
  TrackRowModel,
  TransferModel,
} from './view-models.ts';

/**
 * Icon names shared by both renderers — each package's `IconName` is
 * a superset, so a controller can pick the glyph and the JSX binds it
 * directly.
 */
export type SharedIconName =
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'clock'
  | 'close'
  | 'download'
  | 'drag-handle'
  | 'heart'
  | 'heart-filled'
  | 'library'
  | 'list-plus'
  | 'lyrics'
  | 'next'
  | 'note'
  | 'pause'
  | 'play'
  | 'podium'
  | 'previous'
  | 'queue'
  | 'radio'
  | 'repeat'
  | 'repeat-one'
  | 'search'
  | 'shuffle'
  | 'warn';

/** An optional bound callback — absent handlers stay undefined so the
 * affordance renders inert (the pattern every view derives on). */
type MaybeFn<A extends readonly unknown[] = []> =
  | ((...args: A) => void)
  | undefined;

/** A pressable control's semantic surface — the JSX picks colors. */
export type ControlView = {
  readonly icon: SharedIconName;
  readonly a11yLabel: string;
  readonly active?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onPress: MaybeFn;
};

/** Bind a handler to fixed args. */
function bind<A extends readonly unknown[]>(
  fn: MaybeFn<A>,
  ...args: A
): MaybeFn {
  return fn === undefined ? undefined : () => fn(...args);
}

// ---- queue ------------------------------------------------------------

/** Localized header label for a queue display section. */
export function queueSectionLabel(key: QueueSectionKey): string {
  return t(`queue.${key}`);
}

export type QueueScreenHandlers = {
  readonly onToggleReorder?: MaybeFn;
  readonly onPressItem?: MaybeFn<[occurrenceId: string]>;
  readonly onRemoveItem?: MaybeFn<[occurrenceId: string]>;
  readonly onMoveItem?: MaybeFn<[occurrenceId: string, direction: -1 | 1]>;
  readonly onMoveItemTo?: MaybeFn<[occurrenceId: string, toIndex: number]>;
};

export type QueueReorderButton = ControlView & {
  readonly icon: 'drag-handle';
  readonly active: boolean;
  readonly onPress: () => void;
};

/** The reorder toggle — absent when the host never binds a handler. */
export function queueReorderButton(
  reordering: boolean,
  onToggleReorder: MaybeFn,
): QueueReorderButton | null {
  if (onToggleReorder === undefined) {
    return null;
  }
  return {
    icon: 'drag-handle',
    active: reordering,
    a11yLabel: reordering ? t('queue.reorderDone') : t('queue.reorder'),
    onPress: onToggleReorder,
  };
}

export type QueueScreenView = {
  readonly title: string;
  readonly countLabel: string;
  readonly reorder: QueueReorderButton | null;
  readonly current: {
    readonly title: string;
    readonly status: PlayerModel['status'];
    readonly playing: boolean;
    readonly artworkUrl: string | null;
    readonly metaLabel: string;
  } | null;
};

export function useQueueScreenController({
  queue,
  player = null,
  reordering = false,
  onToggleReorder,
}: {
  readonly queue: QueueModel;
  readonly player?: PlayerModel | null | undefined;
  readonly reordering?: boolean | undefined;
  readonly onToggleReorder?: MaybeFn;
}): QueueScreenView {
  return {
    title: t('queue.title'),
    countLabel: t('queue.count', { count: queue.items.length }),
    reorder: queueReorderButton(reordering, onToggleReorder),
    current:
      player === null
        ? null
        : {
            title: player.title,
            status: player.status,
            playing: player.status === 'playing',
            artworkUrl: player.artworkUrl,
            metaLabel: `${player.artist ?? '—'} · ${formatClock(
              player.positionMs,
            )} / ${formatClock(player.durationMs)}`,
          },
  };
}

// ---- corrections ------------------------------------------------------

export type CorrectionsScreenHandlers = {
  readonly onBack?: MaybeFn;
  readonly onFilter?: MaybeFn<[filter: CorrectionsFilter]>;
  readonly onConfirm?: MaybeFn<[reviewId: string, candidateIndex: number]>;
  readonly onReject?: MaybeFn<[reviewId: string]>;
  readonly onUndo?: MaybeFn<[reviewId: string]>;
  readonly onRetry?: MaybeFn;
};

const CORRECTIONS_FILTERS: readonly {
  readonly value: CorrectionsFilter;
  readonly label: MessageId;
}[] = [
  { value: 'pending', label: 'corrections.filter.pending' },
  { value: 'resolved', label: 'corrections.filter.resolved' },
  { value: 'all', label: 'corrections.filter.all' },
];

export type CorrectionsFilterChip = {
  readonly value: CorrectionsFilter;
  readonly label: string;
  readonly selected: boolean;
  readonly a11yLabel: string;
  readonly onPress: MaybeFn;
};

export type CorrectionsCandidateView = {
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
  /** `pending` AND bound — a resolved review's candidates are inert. */
  readonly enabled: boolean;
  readonly a11yLabel: string;
  readonly onPress: MaybeFn;
};

export type CorrectionsRowAction = {
  readonly kind: 'reject' | 'undo';
  readonly label: string;
  readonly a11yLabel: string;
  readonly onPress: MaybeFn;
};

export type CorrectionsRowView = {
  readonly row: ReviewRowModel;
  readonly pending: boolean;
  readonly statusColor: 'warn' | 'secondary';
  readonly candidates: readonly CorrectionsCandidateView[];
  readonly action: CorrectionsRowAction;
};

export type CorrectionsBodyView =
  | {
      readonly kind: 'loading';
      readonly title: string;
    }
  | {
      readonly kind: 'error';
      readonly title: string;
      readonly hint: string | null;
      readonly onRetry: MaybeFn;
    }
  | {
      readonly kind: 'empty';
      readonly title: string;
      readonly hint: string;
      readonly icon: 'check';
    }
  | {
      readonly kind: 'rows';
      readonly listA11yLabel: string;
      readonly rows: readonly CorrectionsRowView[];
    };

export type CorrectionsScreenView = {
  readonly title: string;
  readonly backA11yLabel: string;
  readonly countsLabel: string;
  readonly filtersA11yLabel: string;
  readonly filters: readonly CorrectionsFilterChip[];
  readonly body: CorrectionsBodyView;
};

export function useCorrectionsScreenController({
  model,
  onFilter,
  onConfirm,
  onReject,
  onUndo,
  onRetry,
}: {
  readonly model: CorrectionsModel;
} & Omit<CorrectionsScreenHandlers, 'onBack'>): CorrectionsScreenView {
  const body: CorrectionsBodyView =
    model.state === 'loading'
      ? { kind: 'loading', title: t('corrections.loading') }
      : model.state === 'error'
        ? {
            kind: 'error',
            title: t('corrections.errorTitle'),
            hint: model.message,
            onRetry,
          }
        : model.rows.length === 0
          ? {
              kind: 'empty',
              title: t('corrections.empty'),
              hint:
                model.filter === 'pending'
                  ? t('corrections.emptyHint.pending')
                  : t('corrections.emptyHint.other'),
              icon: 'check',
            }
          : {
              kind: 'rows',
              listA11yLabel: t('settings.diag.matchReviews'),
              rows: model.rows.map((row) => {
                const pending = row.status === 'pending';
                return {
                  row,
                  pending,
                  statusColor: pending ? 'warn' : 'secondary',
                  candidates: row.candidates.map((candidate) => ({
                    index: candidate.index,
                    title: candidate.title,
                    subtitle: candidate.subtitle,
                    enabled: pending && onConfirm !== undefined,
                    a11yLabel: t('corrections.a11y.confirm', {
                      title: candidate.title,
                    }),
                    onPress: pending
                      ? bind(onConfirm, row.reviewId, candidate.index)
                      : undefined,
                  })),
                  action:
                    pending
                      ? {
                          kind: 'reject',
                          label: t('corrections.rejectAll'),
                          a11yLabel: t('corrections.a11y.reject', {
                            title: row.title,
                          }),
                          onPress: bind(onReject, row.reviewId),
                        }
                      : {
                          kind: 'undo',
                          label: t('corrections.undo'),
                          a11yLabel: t('corrections.a11y.undo', {
                            title: row.title,
                          }),
                          onPress: bind(onUndo, row.reviewId),
                        },
                };
              }),
            };
  return {
    title: t('corrections.title'),
    backA11yLabel: t('common.back'),
    countsLabel: t('corrections.counts', {
      pending: model.pendingCount,
      resolved: model.resolvedCount,
    }),
    filtersA11yLabel: t('corrections.statusFilterA11y'),
    filters: CORRECTIONS_FILTERS.map((filter) => ({
      value: filter.value,
      label: t(filter.label),
      selected: model.filter === filter.value,
      a11yLabel: t('corrections.filterA11y', { label: t(filter.label) }),
      onPress: bind(onFilter, filter.value),
    })),
    body,
  };
}

// ---- transfer ---------------------------------------------------------

export type TransferScreenHandlers = {
  readonly onBack?: MaybeFn;
  readonly onExport?: MaybeFn;
  readonly onPickImportFile?: MaybeFn;
  readonly onApplyImport?: MaybeFn;
  readonly onResetImport?: MaybeFn;
};

export type TransferRowView = {
  readonly label: string;
  readonly detail: string | null;
  readonly detailTone: 'secondary' | 'warn';
  readonly disabled: boolean;
  readonly onPress: MaybeFn;
};

export type TransferImportFooterView =
  | {
      readonly kind: 'done';
      readonly detail: string;
      readonly resetLabel: string;
      readonly resetA11yLabel: string;
      readonly onReset: MaybeFn;
    }
  | {
      readonly kind: 'error';
      readonly title: string;
      readonly hint: string | null;
      readonly resetLabel: string;
      readonly resetA11yLabel: string;
      readonly onReset: MaybeFn;
    }
  | {
      readonly kind: 'confirm';
      readonly applying: boolean;
      readonly applyLabel: string;
      readonly applyA11yLabel: string;
      readonly onApply: MaybeFn;
      readonly cancelLabel: string;
      readonly cancelA11yLabel: string;
      readonly onCancel: MaybeFn;
    };

export type TransferImportView = {
  readonly phase: TransferModel['importPhase'];
  readonly title: string;
  readonly metaLabel: string;
  readonly rows: ImportPreviewModel['rows'];
  readonly footer: TransferImportFooterView;
};

export type TransferScreenView = {
  readonly title: string;
  readonly backA11yLabel: string;
  readonly exportSectionLabel: string;
  readonly importSectionLabel: string;
  readonly exportRow: TransferRowView;
  readonly importRow: TransferRowView;
  readonly importBody: TransferImportView | null;
};

export function useTransferScreenController({
  model,
  onExport,
  onPickImportFile,
  onApplyImport,
  onResetImport,
}: {
  readonly model: TransferModel;
} & Omit<TransferScreenHandlers, 'onBack'>): TransferScreenView {
  const exportBusy = model.exportPhase === 'working';
  const importBusy =
    model.importPhase === 'reading' || model.importPhase === 'applying';
  const preview = model.preview;
  const footer: TransferImportFooterView | null =
    preview === null
      ? null
      : model.importPhase === 'done'
        ? {
            kind: 'done',
            detail: model.importDetail ?? t('transfer.applied'),
            resetLabel: t('common.done'),
            resetA11yLabel: t('transfer.resetA11y'),
            onReset: onResetImport,
          }
        : model.importPhase === 'error'
          ? {
              kind: 'error',
              title: t('transfer.failed'),
              hint: model.importDetail,
              resetLabel: t('transfer.startOver'),
              resetA11yLabel: t('transfer.resetA11y'),
              onReset: onResetImport,
            }
          : {
              kind: 'confirm',
              applying: model.importPhase === 'applying',
              applyLabel:
                model.importPhase === 'applying'
                  ? t('transfer.applying')
                  : t('transfer.apply'),
              applyA11yLabel: t('transfer.apply'),
              onApply: onApplyImport,
              cancelLabel: t('common.cancel'),
              cancelA11yLabel: t('transfer.cancelA11y'),
              onCancel: onResetImport,
            };
  return {
    title: t('transfer.title'),
    backA11yLabel: t('common.back'),
    exportSectionLabel: t('transfer.exportSection'),
    importSectionLabel: t('transfer.importSection'),
    exportRow: {
      label: exportBusy ? t('transfer.exporting') : t('transfer.export'),
      detail:
        model.exportPhase === 'done' || model.exportPhase === 'error'
          ? model.exportDetail
          : null,
      detailTone: model.exportPhase === 'error' ? 'warn' : 'secondary',
      disabled: exportBusy || onExport === undefined,
      onPress: onExport,
    },
    importRow: {
      label: importBusy ? t('transfer.working') : t('transfer.import'),
      detail: model.importPhase === 'error' ? model.importDetail : null,
      detailTone: 'warn',
      disabled: importBusy || onPickImportFile === undefined,
      onPress: onPickImportFile,
    },
    importBody:
      preview === null || footer === null
        ? null
        : {
            phase: model.importPhase,
            title: t('transfer.previewTitle'),
            metaLabel:
              t('transfer.format', { version: preview.formatVersion }) +
              (preview.exportedLabel === null
                ? ''
                : t('transfer.exportedSuffix', {
                    date: preview.exportedLabel,
                  })) +
              t('transfer.sourceSuffix', { source: preview.sourceLabel }),
            rows: preview.rows,
            footer,
          },
  };
}

// ---- library ----------------------------------------------------------

export type LibraryScreenHandlers = {
  readonly onPressItem?: MaybeFn<[recordingId: string]>;
  readonly onToggleLike?: MaybeFn<[recordingId: string]>;
  readonly onAddToPlaylist?: MaybeFn<[recordingId: string]>;
  readonly onContext?: MaybeFn<[recordingId: string]>;
  readonly onOpenCollection?: MaybeFn<
    [key: 'liked' | 'top50' | 'history' | 'downloads']
  >;
  readonly onPlayCollection?: MaybeFn<
    [key: 'liked' | 'top50' | 'history' | 'downloads']
  >;
  readonly onOpenCard?: MaybeFn<[card: LibraryCardModel]>;
  readonly onOpenArtist?: MaybeFn<[artist: ArtistRailModel]>;
  readonly onCreatePlaylist?: MaybeFn<[name: string]>;
};

export type LibraryKindFilter = 'all' | 'playlist' | 'album' | 'artist';
export type LibrarySort = 'recent' | 'title';
export type LibraryLayout = 'grid' | 'list';

export const LIBRARY_COLLECTION_ICONS: Readonly<
  Record<CollectionKey, SharedIconName>
> = {
  liked: 'heart',
  downloads: 'download',
  top50: 'podium',
  history: 'clock',
};

// Labels are message ids resolved at render — never cache translated
// strings at module scope or they go stale on a locale switch.
const LIBRARY_KIND_FILTERS: readonly {
  readonly key: 'playlist' | 'album' | 'artist';
  readonly label: MessageId;
}[] = [
  { key: 'playlist', label: 'library.filter.playlists' },
  { key: 'album', label: 'library.filter.albums' },
  { key: 'artist', label: 'library.filter.artists' },
];

export type LibraryCollectionView = {
  readonly tile: LibraryModel['collections'][number];
  readonly icon: SharedIconName;
  readonly enabled: boolean;
  readonly a11yLabel: string;
  readonly countLabel: string;
  readonly playA11yLabel: string;
  readonly onOpen: MaybeFn;
  readonly onPlay: MaybeFn;
};

export type LibraryCardView = {
  readonly card: LibraryCardModel;
  readonly a11yLabel: string;
  /** Bound when a handler exists; the card component gates on `openable`. */
  readonly onPress: MaybeFn;
};

export type LibraryRowView = {
  readonly row: TrackRowModel;
  readonly onPress: MaybeFn;
  readonly onToggleLike: MaybeFn;
  readonly onAddToPlaylist: MaybeFn;
  readonly onContext: MaybeFn;
};

export type LibraryScreenView = {
  readonly title: string;
  readonly collections: readonly LibraryCollectionView[];
  readonly headingLabel: string;
  readonly sortChip: { readonly label: string; readonly onPress: () => void };
  readonly layoutChip: { readonly label: string; readonly onPress: () => void };
  readonly layout: LibraryLayout;
  readonly filterA11yLabel: string;
  readonly filterOptions: readonly {
    readonly key: LibraryKindFilter;
    readonly label: string;
    readonly active: boolean;
    readonly onPress: () => void;
  }[];
  /** The inline playlist-name field — non-null while creating. */
  readonly creating: boolean;
  readonly nameField: {
    readonly value: string;
    readonly placeholder: string;
    readonly onChange: (value: string) => void;
    readonly onSubmit: MaybeFn<[name: string]>;
    readonly onCancel: () => void;
  } | null;
  /** cards.length === 0 while not creating — the honest empty state. */
  readonly showEmpty: boolean;
  readonly empty: {
    readonly title: string;
    readonly hint: string;
    readonly icon: 'list-plus';
  };
  readonly newCard: {
    readonly label: string;
    readonly a11yLabel: string;
    readonly onPress: MaybeFn;
  } | null;
  readonly cards: readonly LibraryCardView[];
  readonly artists: {
    readonly heading: string;
    readonly items: readonly {
      readonly artist: ArtistRailModel;
      readonly a11yLabel: string;
      readonly onPress: MaybeFn;
    }[];
  } | null;
  readonly recent: {
    readonly heading: string;
    readonly a11yLabel: string;
    readonly rows: readonly LibraryRowView[];
  } | null;
};

/** The library screen's local control state — the hook owns the
 * slots; the view derivation stays pure for testing. */
export type LibraryControls = {
  readonly filter: LibraryKindFilter;
  readonly sort: LibrarySort;
  readonly layout: LibraryLayout;
  readonly creating: boolean;
  readonly draft: string;
  readonly setFilter: (filter: LibraryKindFilter) => void;
  readonly setSort: (sort: LibrarySort) => void;
  readonly setLayout: (layout: LibraryLayout) => void;
  readonly setCreating: (creating: boolean) => void;
  readonly setDraft: (draft: string) => void;
};

/**
 * The locale-free half of the library derivation — which kind filters
 * the model contains, and the cards filtered + ordered for display.
 * Kept separate so the hook can memoize it on [cards, filter, sort]
 * exactly like the original screens did; nothing here calls t().
 */
export function librarySortedCards(
  all: readonly LibraryCardModel[],
  filter: LibraryKindFilter,
  sort: LibrarySort,
): {
  readonly kindsPresent: readonly (typeof LIBRARY_KIND_FILTERS)[number][];
  readonly cards: readonly LibraryCardModel[];
} {
  const kindsPresent = LIBRARY_KIND_FILTERS.filter((f) =>
    all.some((card) => card.kind === f.key),
  );
  const filtered =
    filter === 'all' ? all : all.filter((card) => card.kind === filter);
  return {
    kindsPresent,
    cards:
      sort === 'recent'
        ? [...filtered].sort((a, b) => b.sortMs - a.sortMs)
        : [...filtered].sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export function libraryScreenView(
  model: LibraryModel,
  { kindsPresent, cards }: ReturnType<typeof librarySortedCards>,
  {
    filter,
    sort,
    layout,
    creating,
    draft,
    setFilter,
    setSort,
    setLayout,
    setCreating,
    setDraft,
  }: LibraryControls,
  {
    onPressItem,
    onToggleLike,
    onAddToPlaylist,
    onContext,
    onOpenCollection,
    onPlayCollection,
    onOpenCard,
    onOpenArtist,
    onCreatePlaylist,
  }: LibraryScreenHandlers,
): LibraryScreenView {
  return {
    title: t('nav.library'),
    collections: model.collections.map((tile) => ({
      tile,
      icon: LIBRARY_COLLECTION_ICONS[tile.key],
      enabled: tile.enabled,
      a11yLabel: t('library.tileA11y', {
        label: tile.label,
        count: tile.count,
      }),
      countLabel: tile.note ?? t('common.trackCount', { count: tile.count }),
      playA11yLabel: t('library.tilePlayA11y', { label: tile.label }),
      onOpen: bind(onOpenCollection, tile.key),
      onPlay:
        tile.count === 0 ? undefined : bind(onPlayCollection, tile.key),
    })),
    headingLabel: t('library.heading'),
    sortChip: {
      label: t(`library.sort.${sort}`),
      onPress: () => setSort(sort === 'recent' ? 'title' : 'recent'),
    },
    layoutChip: {
      label: t(`library.view.${layout}`),
      onPress: () => setLayout(layout === 'grid' ? 'list' : 'grid'),
    },
    layout,
    filterA11yLabel: t('library.kindFilterA11y'),
    filterOptions: [
      {
        key: 'all' as const,
        label: t('library.filter.all'),
        active: filter === 'all',
        onPress: () => setFilter('all'),
      },
      ...kindsPresent.map((f) => ({
        key: f.key as LibraryKindFilter,
        label: t(f.label),
        active: filter === f.key,
        onPress: () => setFilter(f.key),
      })),
    ],
    creating,
    nameField: creating
      ? {
          value: draft,
          placeholder: t('common.newPlaylistName'),
          onChange: setDraft,
          onSubmit:
            onCreatePlaylist === undefined
              ? undefined
              : (name) => {
                  onCreatePlaylist(name);
                  setDraft('');
                  setCreating(false);
                },
          onCancel: () => {
            setDraft('');
            setCreating(false);
          },
        }
      : null,
    showEmpty: cards.length === 0 && !creating,
    empty: {
      title: t('library.emptyTitle'),
      hint: t('library.emptyHint'),
      icon: 'list-plus',
    },
    newCard: creating
      ? null
      : {
          label: t('common.newPlaylist'),
          a11yLabel: t('common.newPlaylist'),
          onPress:
            onCreatePlaylist === undefined
              ? undefined
              : () => setCreating(true),
        },
    cards: cards.map((card) => ({
      card,
      a11yLabel: t('common.cardA11y', {
        title: card.title,
        subtitle: card.subtitle,
      }),
      onPress: bind(onOpenCard, card),
    })),
    artists:
      model.artists.length === 0
        ? null
        : {
            heading: t('library.artistsHeading'),
            items: model.artists.map((artist) => ({
              artist,
              a11yLabel: artist.name,
              onPress:
                artist.entityRef === null
                  ? undefined
                  : bind(onOpenArtist, artist),
            })),
          },
    recent:
      model.recentlyAdded.length === 0
        ? null
        : {
            heading: t('library.recentlyLiked'),
            a11yLabel: t('library.recentlyLiked'),
            rows: model.recentlyAdded.map((item) => ({
              row: item,
              onPress: bind(onPressItem, item.key),
              onToggleLike: bind(onToggleLike, item.key),
              onAddToPlaylist: bind(onAddToPlaylist, item.key),
              onContext: bind(onContext, item.key),
            })),
          },
  };
}

export function useLibraryScreenController({
  model,
  ...handlers
}: {
  readonly model: LibraryModel;
} & LibraryScreenHandlers): LibraryScreenView {
  const [filter, setFilter] = useState<LibraryKindFilter>('all');
  const [sort, setSort] = useState<LibrarySort>('recent');
  const [layout, setLayout] = useState<LibraryLayout>('grid');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  // Same memoization the original screens had: the card slice is
  // locale-free, so caching it can never serve a stale translation.
  const sorted = useMemo(
    () => librarySortedCards(model.cards, filter, sort),
    [model.cards, filter, sort],
  );
  return libraryScreenView(
    model,
    sorted,
    {
      filter,
      sort,
      layout,
      creating,
      draft,
      setFilter,
      setSort,
      setLayout,
      setCreating,
      setDraft,
    },
    handlers,
  );
}

// ---- entity -----------------------------------------------------------

export type EntityScreenHandlers = {
  readonly onBack?: MaybeFn;
  readonly onPlayAll?: MaybeFn;
  readonly onShuffleAll?: MaybeFn;
  readonly onToggleLike?: MaybeFn;
  readonly onPressItem?: MaybeFn<[row: TrackRowModel]>;
  readonly onAddToPlaylist?: MaybeFn<[row: TrackRowModel]>;
  readonly onContext?: MaybeFn<[row: TrackRowModel]>;
  readonly onLoadMore?: MaybeFn;
  readonly onRetry?: MaybeFn;
};

export type EntityPillView = {
  readonly label: string;
  readonly icon: SharedIconName;
  readonly accent: boolean;
  readonly disabled: boolean;
  readonly onPress: MaybeFn;
};

export type EntityRowView = {
  readonly row: TrackRowModel;
  readonly onPress: MaybeFn;
  readonly onAddToPlaylist: MaybeFn;
  readonly onContext: MaybeFn;
};

export type EntityScreenView =
  | {
      readonly kind: 'loading';
      readonly title: string;
      readonly backA11yLabel: string;
    }
  | {
      readonly kind: 'error';
      readonly title: string;
      readonly backA11yLabel: string;
      readonly hint: string | null;
      readonly onRetry: MaybeFn;
    }
  | {
      readonly kind: 'ready';
      readonly model: EntityScreenModel;
      readonly backA11yLabel: string;
      readonly kindLabel: string;
      readonly play: EntityPillView;
      readonly shuffle: EntityPillView;
      readonly like: {
        readonly icon: 'heart-filled' | 'heart';
        readonly liked: boolean;
        readonly a11yLabel: string;
        readonly onPress: MaybeFn;
      };
      readonly notice: { readonly text: string } | null;
      readonly body:
        | {
            readonly kind: 'empty';
            readonly title: string;
            readonly hint: string;
            readonly icon: 'note';
          }
        | {
            readonly kind: 'rows';
            readonly listA11yLabel: string | undefined;
            readonly rows: readonly EntityRowView[];
            readonly loadMore: {
              readonly busy: boolean;
              readonly label: string;
              readonly a11yLabel: string;
              readonly onPress: MaybeFn;
            } | null;
          };
    };

export function useEntityScreenController({
  model,
  onPlayAll,
  onShuffleAll,
  onToggleLike,
  onPressItem,
  onAddToPlaylist,
  onContext,
  onLoadMore,
  onRetry,
}: {
  readonly model: EntityScreenModel;
} & Omit<EntityScreenHandlers, 'onBack'>): EntityScreenView {
  if (model.phase === 'loading') {
    return {
      kind: 'loading',
      title: t('state.loading'),
      backA11yLabel: t('common.back'),
    };
  }
  if (model.phase === 'error') {
    return {
      kind: 'error',
      title: t('entity.errorTitle'),
      backA11yLabel: t('common.back'),
      hint: model.message,
      onRetry,
    };
  }
  const empty = model.items.length === 0;
  return {
    kind: 'ready',
    model,
    backA11yLabel: t('common.back'),
    kindLabel:
      model.kind === null
        ? t('entity.kind.fallback')
        : t(`entity.kind.${model.kind}`),
    play: {
      label: t('common.play'),
      icon: 'play',
      accent: true,
      disabled: empty,
      onPress: onPlayAll,
    },
    shuffle: {
      label: t('entity.shuffle'),
      icon: 'shuffle',
      accent: false,
      disabled: empty,
      onPress: onShuffleAll,
    },
    like: {
      icon: model.liked ? 'heart-filled' : 'heart',
      liked: model.liked,
      a11yLabel: model.liked ? t('common.unlike') : t('common.like'),
      onPress: model.canLike ? onToggleLike : undefined,
    },
    notice:
      !model.complete || model.message !== null
        ? { text: model.message ?? t('entity.partial') }
        : null,
    body: empty
      ? {
          kind: 'empty',
          title: t('entity.empty'),
          hint: t('entity.emptyHint'),
          icon: 'note',
        }
      : {
          kind: 'rows',
          listA11yLabel: model.title ?? undefined,
          rows: model.items.map((item) => ({
            row: item,
            onPress: bind(onPressItem, item),
            onAddToPlaylist: bind(onAddToPlaylist, item),
            onContext: bind(onContext, item),
          })),
          loadMore: model.hasMore
            ? {
                busy: model.loadingMore,
                label: model.loadingMore
                  ? t('state.loading')
                  : t('entity.loadMore'),
                a11yLabel: t('entity.loadMore'),
                onPress: model.loadingMore ? undefined : onLoadMore,
              }
            : null,
        },
  };
}

// ---- search -----------------------------------------------------------

export type SearchScreenHandlers = {
  readonly onQueryChange?: MaybeFn<[query: string]>;
  readonly onSubmit?: MaybeFn;
  readonly onCancel?: MaybeFn;
  readonly onRetry?: MaybeFn;
  readonly onResultPress?: MaybeFn<[row: TrackRowModel]>;
  readonly onToggleLike?: MaybeFn<[row: TrackRowModel]>;
  readonly onAddToPlaylist?: MaybeFn<[row: TrackRowModel]>;
  readonly onContext?: MaybeFn<[row: TrackRowModel]>;
  readonly onRecentPress?: MaybeFn<[query: string]>;
  readonly onSuggestionPress?: MaybeFn<[query: string]>;
};

export type SearchFieldView = {
  readonly icon: 'search';
  readonly label: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly loading: boolean;
  readonly onChange: MaybeFn<[query: string]>;
  readonly onSubmit: MaybeFn;
  readonly cancel: {
    readonly label: string;
    readonly a11yLabel: string;
    readonly onPress: () => void;
  } | null;
  readonly clear: {
    readonly icon: 'close';
    readonly a11yLabel: string;
    readonly onPress: () => void;
  } | null;
};

export type SearchRowView = {
  readonly row: TrackRowModel;
  readonly onPress: MaybeFn;
  readonly onToggleLike: MaybeFn;
  readonly onAddToPlaylist: MaybeFn;
  readonly onContext: MaybeFn;
};

export type SearchScreenView = {
  /** Live text vs committed query — owns the suggestions pane. */
  readonly draft: boolean;
  readonly field: SearchFieldView;
  readonly suggestions: {
    readonly heading: string;
    readonly a11yLabel: string;
    readonly commit: {
      readonly icon: 'search';
      readonly label: string;
      readonly a11yLabel: string;
      readonly onPress: MaybeFn;
    };
    readonly items: readonly {
      readonly label: string;
      readonly icon: 'search';
      readonly a11yLabel: string;
      readonly onPress: MaybeFn;
    }[];
  } | null;
  readonly resultsHead: {
    readonly title: string;
    readonly metaLabel: string;
  } | null;
  readonly idle:
    | {
        readonly kind: 'recents';
        readonly heading: string;
        readonly items: readonly {
          readonly label: string;
          readonly icon: 'clock';
          readonly a11yLabel: string;
          readonly onPress: MaybeFn;
        }[];
      }
    | {
        readonly kind: 'empty';
        readonly title: string;
        readonly hint: string;
        readonly icon: 'search';
      }
    | null;
  readonly status:
    | {
        readonly kind: 'loading';
        readonly title: string;
        readonly hint: string;
      }
    | {
        readonly kind: 'empty';
        readonly title: string;
        readonly hint: string;
        readonly icon: 'search';
      }
    | {
        readonly kind: 'error';
        readonly title: string;
        readonly hint: string | null;
        readonly onRetry: MaybeFn;
      }
    | {
        readonly kind: 'unavailable';
        readonly title: string;
        readonly hint: string | null;
      }
    | null;
  readonly results: {
    readonly a11yLabel: string;
    readonly rows: readonly SearchRowView[];
  } | null;
};

export function useSearchScreenController({
  state,
  query,
  onQueryChange,
  onSubmit,
  onCancel,
  onRetry,
  onResultPress,
  onToggleLike,
  onAddToPlaylist,
  onContext,
  recents = [],
  onRecentPress,
  suggestions = [],
  onSuggestionPress,
}: {
  readonly state: SearchStateModel;
  readonly query?: string | undefined;
  readonly recents?: readonly string[] | undefined;
  readonly suggestions?: readonly string[] | undefined;
} & SearchScreenHandlers): SearchScreenView {
  const loading = state.phase === 'loading';
  const editing = query ?? state.query;
  const trimmed = editing.trim();
  // Draft mode: the box carries text that was never committed as the
  // shown query — completions own the pane until submit.
  const draft = trimmed !== '' && trimmed !== state.query;
  return {
    draft,
    field: {
      icon: 'search',
      label: t('search.fieldLabel'),
      value: editing,
      readOnly: onQueryChange === undefined,
      loading,
      onChange: onQueryChange,
      onSubmit,
      cancel:
        loading && onCancel !== undefined
          ? {
              label: t('common.cancel'),
              a11yLabel: t('search.a11y.cancel'),
              onPress: onCancel,
            }
          : null,
      clear:
        !loading && editing !== '' && onQueryChange !== undefined
          ? {
              icon: 'close',
              a11yLabel: t('search.a11y.clear'),
              onPress: () => onQueryChange(''),
            }
          : null,
    },
    suggestions: draft
      ? {
          heading: t('search.suggestions'),
          a11yLabel: t('search.suggestions'),
          commit: {
            icon: 'search',
            label: t('search.commitQuery', { query: trimmed }),
            a11yLabel: t('search.a11y.suggestion', { query: trimmed }),
            onPress: onSubmit,
          },
          items: suggestions.map((suggestion) => ({
            label: suggestion,
            icon: 'search' as const,
            a11yLabel: t('search.a11y.suggestion', { query: suggestion }),
            onPress: bind(onSuggestionPress, suggestion),
          })),
        }
      : null,
    resultsHead:
      !draft && state.phase === 'ready'
        ? {
            title: t('search.results'),
            metaLabel: t('search.resultsMeta', {
              provider: state.providerId ?? t('search.providerFallback'),
              count: state.results.length,
            }),
          }
        : null,
    idle:
      !draft && state.phase === 'idle'
        ? recents.length > 0
          ? {
              kind: 'recents',
              heading: t('search.recent'),
              items: recents.map((recent) => ({
                label: recent,
                icon: 'clock' as const,
                a11yLabel: t('search.a11y.again', { query: recent }),
                onPress: bind(onRecentPress, recent),
              })),
            }
          : {
              kind: 'empty',
              title: t('search.emptyTitle'),
              hint: t('search.emptyHint'),
              icon: 'search',
            }
        : null,
    status:
      !draft && state.phase === 'empty'
        ? {
            kind: 'empty' as const,
            title: t('search.noResults', { query: state.query }),
            hint: t('search.noResultsHint'),
            icon: 'search' as const,
          }
        : !draft && state.phase === 'error'
          ? {
              kind: 'error' as const,
              title: t('search.failed'),
              hint: state.message,
              onRetry: state.retryable ? onRetry : undefined,
            }
          : !draft && state.phase === 'unavailable'
            ? {
                kind: 'unavailable' as const,
                title: t('search.unavailableTitle'),
                hint: state.message,
              }
            : !draft && state.phase === 'loading' && state.results.length === 0
              ? {
                  kind: 'loading' as const,
                  title: t('search.loading'),
                  hint: state.query,
                }
              : null,
    results:
      !draft &&
      (state.phase === 'ready' || state.phase === 'loading') &&
      state.results.length > 0
        ? {
            a11yLabel: t('search.resultsA11y'),
            rows: state.results.map((row) => ({
              row,
              onPress: bind(onResultPress, row),
              onToggleLike: bind(onToggleLike, row),
              onAddToPlaylist: bind(onAddToPlaylist, row),
              onContext: bind(onContext, row),
            })),
          }
        : null,
  };
}

// ---- stage (now-playing screen ↔ stage sheet) -------------------------

export type StageQueueHandlers = {
  readonly onPressQueueItem?: MaybeFn<[occurrenceId: string]>;
  readonly onRemoveQueueItem?: MaybeFn<[occurrenceId: string]>;
  readonly onToggleQueueReorder?: MaybeFn;
  readonly onMoveQueueItem?: MaybeFn<[occurrenceId: string, direction: -1 | 1]>;
  readonly onMoveQueueItemTo?: MaybeFn<[occurrenceId: string, toIndex: number]>;
};

export type StageScreenHandlers = StageQueueHandlers & {
  readonly onPlayPause?: MaybeFn;
  readonly onNext?: MaybeFn;
  readonly onPrevious?: MaybeFn;
  readonly onToggleLike?: MaybeFn;
  readonly onToggleShuffle?: MaybeFn;
  readonly onCycleRepeat?: MaybeFn;
  readonly onDownload?: MaybeFn;
  /** Add-to-playlist affordance on the meta row (same as native). */
  readonly onAddToPlaylist?: MaybeFn;
  /**
   * Stops playback and clears the stage's track (the queue keeps its
   * items — the native mini-player's swipe-down dismiss). Overlays the
   * stage's top-right in every mode; omitted hides the control.
   */
  readonly onStopPlayback?: MaybeFn;
  readonly onSeek?: MaybeFn<[ms: number]>;
  readonly onRetryLyrics?: MaybeFn;
  readonly onStartRadio?: MaybeFn;
  readonly onStopRadio?: MaybeFn;
  readonly onModeChange?: MaybeFn<[mode: StageMode]>;
};

/** Stage tab order — shared by both platforms. */
export const STAGE_MODE_ORDER: readonly StageMode[] = [
  'queue',
  'player',
  'lyrics',
];

/** Stage tab metadata — labels and icons per mode. */
export const STAGE_MODE_META: Readonly<
  Record<StageMode, { readonly label: MessageId; readonly icon: SharedIconName }>
> = {
  player: { label: 'stage.mode.player', icon: 'note' },
  lyrics: { label: 'stage.mode.lyrics', icon: 'lyrics' },
  queue: { label: 'stage.mode.queue', icon: 'queue' },
};

export type StageModeTab = {
  readonly key: StageMode;
  readonly label: string;
  readonly icon: SharedIconName;
  readonly active: boolean;
  readonly onPress: MaybeFn;
};

/** Resolved tabs in the caller's order — pass `STAGE_MODE_ORDER`. */
export function stageModeTabs(
  order: readonly StageMode[],
  mode: StageMode,
  onSelect: MaybeFn<[mode: StageMode]>,
): readonly StageModeTab[] {
  return order.map((key) => {
    const meta = STAGE_MODE_META[key];
    return {
      key,
      label: t(meta.label),
      icon: meta.icon,
      active: key === mode,
      onPress: bind(onSelect, key),
    };
  });
}

/**
 * Uncontrolled-mode fallback: a host may pin `mode`, else the sheet
 * tracks its own selection and reports through `onModeChange`. Every
 * open lands on the player pane — a false→true flip of `open` resets
 * the internal selection during render so the rising sheet never
 * paints the stale mode. Hosts that pin `mode` own the reset
 * themselves so an explicit open target (deep links) isn't stomped.
 */
export function useStageMode(
  mode: StageMode | undefined,
  onModeChange: MaybeFn<[mode: StageMode]>,
  open?: boolean | undefined,
): {
  readonly activeMode: StageMode;
  readonly select: (mode: StageMode) => void;
} {
  const [internalMode, setInternalMode] = useState<StageMode>('player');
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open === true) {
      setInternalMode('player');
    }
  }
  return {
    activeMode: mode ?? internalMode,
    select: (m) => {
      setInternalMode(m);
      onModeChange?.(m);
    },
  };
}

export type DownloadButtonView = {
  readonly icon: 'check' | 'warn' | 'download' | 'spinner';
  readonly stored: boolean;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly a11yLabel: string;
  readonly onPress: MaybeFn;
};

const DOWNLOAD_BUTTON_META: Record<
  DownloadChip,
  {
    readonly icon: DownloadButtonView['icon'];
    readonly busy: boolean;
    readonly a11y: MessageId;
  }
> = {
  idle: { icon: 'download', busy: false, a11y: 'stage.download.idleA11y' },
  queued: { icon: 'download', busy: true, a11y: 'stage.download.busyA11y' },
  downloading: { icon: 'download', busy: true, a11y: 'stage.download.busyA11y' },
  stored: { icon: 'check', busy: false, a11y: 'stage.download.storedA11y' },
  failed: { icon: 'warn', busy: false, a11y: 'stage.download.failedA11y' },
  removing: { icon: 'spinner', busy: true, a11y: 'stage.download.busyA11y' },
};

/** The owned-bytes affordance — absent when `download` is null. */
export function downloadButtonView(
  download: DownloadChip,
  onDownload: MaybeFn,
): DownloadButtonView {
  const meta = DOWNLOAD_BUTTON_META[download];
  return {
    icon: meta.icon,
    stored: download === 'stored',
    failed: download === 'failed',
    busy: meta.busy,
    a11yLabel: t(meta.a11y),
    onPress: download === 'removing' ? undefined : onDownload,
  };
}

export type TransportInput = {
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
  /** Shuffle toggle state — the cursor walks a dealt play order. */
  readonly shuffle?: boolean | undefined;
  /** Current repeat mode — off / all / one from the player port. */
  readonly repeat?: RepeatMode | undefined;
  /** Owned-bytes state of the current track; null hides the button. */
  readonly download?: DownloadChip | null | undefined;
  readonly onPlayPause?: MaybeFn;
  readonly onPrevious?: MaybeFn;
  readonly onNext?: MaybeFn;
  readonly onToggleLike?: MaybeFn;
  readonly onToggleShuffle?: MaybeFn;
  readonly onCycleRepeat?: MaybeFn;
  readonly onDownload?: MaybeFn;
};

export type TransportView = {
  readonly a11yLabel: string;
  readonly busy: boolean;
  readonly playing: boolean;
  readonly like: {
    readonly icon: 'heart-filled' | 'heart';
    readonly liked: boolean;
    readonly a11yLabel: string;
    readonly active: boolean;
    readonly onPress: MaybeFn;
  };
  readonly shuffle: {
    readonly icon: 'shuffle';
    readonly a11yLabel: string;
    readonly disabled: boolean;
    readonly active: boolean;
    readonly onPress: MaybeFn;
  };
  readonly previous: {
    readonly icon: 'previous';
    readonly a11yLabel: string;
    readonly disabled: boolean;
    readonly onPress: MaybeFn;
  };
  readonly play: {
    readonly a11yLabel: string;
    readonly pressed: boolean;
    readonly onPress: MaybeFn;
  };
  readonly next: {
    readonly icon: 'next';
    readonly a11yLabel: string;
    readonly disabled: boolean;
    readonly onPress: MaybeFn;
  };
  readonly repeat: {
    readonly icon: 'repeat-one' | 'repeat';
    readonly a11yLabel: string;
    readonly active: boolean;
    readonly disabled: boolean;
    readonly onPress: MaybeFn;
  };
  readonly download: DownloadButtonView | null;
};

export function useTransportView({
  status,
  intentPlaying,
  liked,
  canPrevious,
  canNext,
  shuffle = false,
  repeat = 'off',
  download = null,
  onPlayPause,
  onPrevious,
  onNext,
  onToggleLike,
  onToggleShuffle,
  onCycleRepeat,
  onDownload,
}: TransportInput): TransportView {
  return {
    a11yLabel: t('player.a11y.transport'),
    busy: status === 'preparing' || status === 'buffering',
    playing: intentPlaying,
    like: {
      icon: liked ? 'heart-filled' : 'heart',
      liked,
      a11yLabel: liked ? t('common.unlike') : t('common.like'),
      active: liked,
      onPress: onToggleLike,
    },
    shuffle: {
      icon: 'shuffle',
      a11yLabel: t('common.shuffle'),
      disabled: onToggleShuffle === undefined,
      active: shuffle,
      onPress: onToggleShuffle,
    },
    previous: {
      icon: 'previous',
      a11yLabel: t('common.previous'),
      disabled: !canPrevious,
      onPress: onPrevious,
    },
    play: {
      a11yLabel: intentPlaying ? t('common.pause') : t('common.play'),
      pressed: intentPlaying,
      onPress: onPlayPause,
    },
    next: {
      icon: 'next',
      a11yLabel: t('common.next'),
      disabled: !canNext,
      onPress: onNext,
    },
    repeat: {
      icon: repeat === 'one' ? 'repeat-one' : 'repeat',
      a11yLabel:
        repeat === 'one'
          ? t('common.repeatOne')
          : repeat === 'all'
            ? t('common.repeatAll')
            : t('common.repeat'),
      active: repeat !== 'off',
      disabled: onCycleRepeat === undefined,
      onPress: onCycleRepeat,
    },
    download:
      download === null ? null : downloadButtonView(download, onDownload),
  };
}

/**
 * The live radio element: a seed affordance when no tail is armed,
 * the tail's honest status when one is — 'failed' carries the typed
 * message, and stop always clears. `null` hides the row entirely.
 */
export type RadioRowView = {
  readonly armed: boolean;
  readonly failed: boolean;
  readonly statusText: string;
  readonly start: {
    readonly label: string;
    readonly a11yLabel: string;
    readonly onPress: MaybeFn;
  };
  readonly stop: {
    readonly label: string;
    readonly a11yLabel: string;
    readonly onPress: MaybeFn;
  };
};

export function radioRowView(
  radio: RadioModel | undefined,
  onStartRadio: MaybeFn,
  onStopRadio: MaybeFn,
): RadioRowView | null {
  if (radio === undefined || (!radio.armed && onStartRadio === undefined)) {
    return null;
  }
  return {
    armed: radio.armed,
    failed: radio.status === 'failed',
    statusText: `${radio.label ?? ''}${
      radio.fetching ? t('stage.radio.fetchingSuffix') : ''
    }${radio.detail === null ? '' : ` · ${radio.detail}`}`,
    start: {
      label: t('stage.radio.start'),
      a11yLabel: t('stage.radio.start'),
      onPress: onStartRadio,
    },
    stop: {
      label: t('stage.radio.stop'),
      a11yLabel: t('stage.radio.stopA11y'),
      onPress: onStopRadio,
    },
  };
}

/** The player-mode meta cluster + waveform wiring. */
export type StageMetaView = {
  readonly title: string;
  readonly artistLabel: string;
  readonly albumLabel: string | null;
  readonly errorMessage: string | null;
  /** Queue-occurrence key for per-track transient state; null off-queue. */
  readonly trackKey: string | null;
  readonly waveformSeed: string;
  readonly waveformLoading: boolean;
};

export function stageMetaView(player: PlayerModel): StageMetaView {
  return {
    title: player.title,
    artistLabel: player.artist ?? '—',
    albumLabel: player.albumLabel,
    errorMessage: player.errorMessage,
    trackKey: player.occurrenceId,
    waveformSeed: `${player.title}|${player.artist ?? ''}`,
    waveformLoading:
      player.status === 'preparing' || player.durationMs === null,
  };
}

/**
 * The lyrics-mode header: `artist · syncLabel` — the sync label rides
 * the subtitle so provenance stays attached to what is shown.
 */
export function lyricsHeaderView(
  player: PlayerModel,
  lyrics: LyricsModel | undefined,
): { readonly title: string; readonly subtitle: string } {
  return {
    title: player.title,
    subtitle: `${player.artist ?? '—'}${
      lyrics?.syncLabel != null ? ` · ${lyrics.syncLabel}` : ''
    }`,
  };
}

/**
 * Honest lyrics: only `state === 'synced'` highlights the active
 * line — plain text never gets synced treatment, instrumental /
 * unavailable / error are explicit states, and loading is bounded by
 * the session's own op deadline.
 */
export type LyricsPaneView =
  | {
      readonly kind: 'empty';
      readonly title: string;
      readonly hint: string | null;
      readonly icon: 'lyrics';
    }
  | {
      readonly kind: 'loading';
      readonly title: string;
    }
  | {
      readonly kind: 'error';
      readonly title: string;
      readonly hint: string | null;
      readonly onRetry: MaybeFn;
    }
  | {
      readonly kind: 'lines';
      readonly state: LyricsModel['state'];
      /** The synced line to keep in view — null for plain text. */
      readonly activeIndex: number | null;
      readonly lines: readonly {
        readonly text: string;
        readonly active: boolean;
        readonly color: 'accent' | 'primary' | 'secondary';
      }[];
    };

export function lyricsPaneView(
  lyrics: LyricsModel | undefined,
  onRetryLyrics: MaybeFn,
): LyricsPaneView {
  if (lyrics === undefined) {
    return { kind: 'empty', title: t('lyrics.empty'), hint: null, icon: 'lyrics' };
  }
  if (lyrics.state === 'loading') {
    return { kind: 'loading', title: t('lyrics.loading') };
  }
  if (lyrics.state === 'error') {
    return {
      kind: 'error',
      title: t('lyrics.errorTitle'),
      hint: lyrics.message,
      onRetry: onRetryLyrics,
    };
  }
  if (lyrics.state === 'instrumental') {
    return {
      kind: 'empty',
      title: t('lyrics.instrumental'),
      hint: lyrics.message,
      icon: 'lyrics',
    };
  }
  if (lyrics.state === 'unavailable' || lyrics.lines.length === 0) {
    return {
      kind: 'empty',
      title: t('lyrics.empty'),
      hint: lyrics.state === 'unavailable' ? lyrics.message : null,
      icon: 'lyrics',
    };
  }
  return {
    kind: 'lines',
    state: lyrics.state,
    activeIndex: lyrics.activeIndex,
    lines: lyrics.lines.map((line, i) => ({
      text: line,
      active: i === lyrics.activeIndex,
      color:
        i === lyrics.activeIndex
          ? 'accent'
          : lyrics.state === 'plain'
            ? 'primary'
            : 'secondary',
    })),
  };
}

// ---- gallery controls ---------------------------------------------------

/**
 * The fixture gallery's control strip — identical state slots on both
 * renderers. Platform-specific slots (web's `sheetOpen`, native's
 * `gestureState`) stay in the screen file.
 */
export type GalleryControls = {
  readonly scheme: ThemeName;
  readonly setScheme: (theme: ThemeName) => void;
  readonly reduced: boolean;
  readonly setReduced: (reduced: boolean) => void;
  readonly nav: string;
  readonly setNav: (key: string) => void;
  readonly expanded: boolean;
  readonly setExpanded: (expanded: boolean) => void;
  readonly searchPhase: number;
  readonly setSearchPhase: (index: number) => void;
  readonly textScale: number;
  readonly setTextScale: (scale: number) => void;
  readonly artworkCondition: string;
  readonly setArtworkCondition: (condition: string) => void;
};

export function useGalleryControls(): GalleryControls {
  const [scheme, setScheme] = useState<ThemeName>('dark');
  const [reduced, setReduced] = useState(false);
  const [nav, setNav] = useState('home');
  const [expanded, setExpanded] = useState(true);
  const [searchPhase, setSearchPhase] = useState(2);
  const [textScale, setTextScale] = useState(1);
  const [artworkCondition, setArtworkCondition] = useState('missing');
  return {
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
  };
}
