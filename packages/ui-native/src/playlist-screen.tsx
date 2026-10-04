import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  BackButton,
  bind,
  IconButton,
  PillButton,
  Text,
} from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState, UnavailableState } from './states.tsx';
import { NameField } from './sheets.tsx';
import type { PlaylistEntryModel, PlaylistModel } from '@auqw/ui-shared';
import { t } from '@auqw/ui-shared';

export type PlaylistScreenProps = {
  /**
   * `null` covers a stale route (the playlist was deleted under the
   * overlay) — the screen degrades to an honest unavailable state
   * instead of fabricating a header.
   */
  readonly model: PlaylistModel | null;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onBack?: (() => void) | undefined;
  /**
   * Download-all over the playlist's recordings. `downloadState`
   * is the live roll-up — the button says what is true, never
   * 'download all' when everything is already stored.
   */
  readonly onDownloadAll?: (() => void) | undefined;
  readonly downloadAllState?: 'none' | 'partial' | 'all' | undefined;
  readonly onRename?: ((name: string) => void) | undefined;
  readonly onDelete?: (() => void) | undefined;
  readonly onPressEntry?: ((entry: PlaylistEntryModel) => void) | undefined;
  /** Advisory row intent — touch-down on a row; the caller warms it. */
  readonly onRowIntent?: ((entry: PlaylistEntryModel) => void) | undefined;
  readonly onToggleLike?: ((entry: PlaylistEntryModel) => void) | undefined;
  readonly onContext?: ((entry: PlaylistEntryModel) => void) | undefined;
  readonly onRemoveEntry?: ((entry: PlaylistEntryModel) => void) | undefined;
  readonly onMoveEntry?:
  | ((entry: PlaylistEntryModel, direction: -1 | 1) => void)
  | undefined;
};

function HeaderButton({
  label,
  warn = false,
  onPress,
}: {
  readonly label: string;
  readonly warn?: boolean | undefined;
  readonly onPress?: (() => void) | undefined;
}) {
  return (
    <PillButton label={label} tone={warn ? 'warn' : 'outline'} onPress={onPress} />
  );
}

export function PlaylistScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onBack,
  onDownloadAll,
  downloadAllState = 'none',
  onRename,
  onDelete,
  onPressEntry,
  onRowIntent,
  onToggleLike,
  onContext,
  onRemoveEntry,
  onMoveEntry,
}: PlaylistScreenProps) {
  const theme = useTheme();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  if (model === null) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.canvas,
          paddingTop: topInset,
        }}
      >
        <UnavailableState
          title={t('playlist.notFound')}
          hint={t('playlist.notFoundHint')}
        />
        {onBack !== undefined && (
          <View style={{ alignItems: 'center', paddingBottom: theme.spacing.xl }}>
            <HeaderButton label={t('common.back')} onPress={onBack} />
          </View>
        )}
      </View>
    );
  }
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingTop: topInset + theme.spacing.sm,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
        }}
      >
        <BackButton onPress={onBack} accessibilityLabel={t('common.back')} />
        <Artwork url={model.artworkUrl} size={56} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading" color="bright" numberOfLines={1}>
            {model.name}
          </Text>
          <Text variant="metadata" color="secondary">
            {t('playlist.meta', { count: model.count })}
          </Text>
        </View>
      </View>

      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          marginTop: theme.spacing.md,
          marginBottom: theme.spacing.sm,
        }}
      >
        {onDownloadAll !== undefined && (
          <HeaderButton
            label={
              downloadAllState === 'all'
                ? t('playlist.downloaded')
                : downloadAllState === 'partial'
                  ? t('playlist.downloadMissing')
                  : t('playlist.downloadAll')
            }
            onPress={
              model.count === 0 || downloadAllState === 'all'
                ? undefined
                : onDownloadAll
            }
          />
        )}
        <HeaderButton
          label={t('common.rename')}
          onPress={
            onRename === undefined
              ? undefined
              : () => {
                setDraft(model.name);
                setRenaming(true);
                setConfirming(false);
              }
          }
        />
        {/* Two-step confirm: 'delete' arms, 'confirm delete' commits. */}
        {confirming ? (
          <>
            <HeaderButton
              label={t('playlist.confirmDelete')}
              warn
              onPress={
                onDelete === undefined
                  ? undefined
                  : () => {
                    setConfirming(false);
                    onDelete();
                  }
              }
            />
            <HeaderButton
              label={t('common.cancel')}
              onPress={() => setConfirming(false)}
            />
          </>
        ) : (
          <HeaderButton
            label={t('common.delete')}
            warn
            onPress={
              onDelete === undefined ? undefined : () => setConfirming(true)
            }
          />
        )}
      </View>

      {renaming && (
        <View
          style={{
            paddingHorizontal: theme.spacing.lg,
            marginBottom: theme.spacing.sm,
          }}
        >
          <NameField
            value={draft}
            placeholder={t('playlist.namePlaceholder')}
            submitLabel={t('common.save')}
            autoFocus
            onChange={setDraft}
            onSubmit={
              onRename === undefined
                ? undefined
                : (name) => {
                  onRename(name);
                  setRenaming(false);
                }
            }
            onCancel={() => setRenaming(false)}
          />
        </View>
      )}

      {model.entries.length === 0 ? (
        <EmptyState
          title={t('playlist.empty')}
          hint={t('playlist.emptyHint')}
          icon="list-plus"
        />
      ) : (
        <FlatList
          data={model.entries}
          // entryId keys: a duplicated recording keeps distinct rows.
          keyExtractor={(entry) => entry.entryId}
          scrollEnabled={scrollEnabled}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.sm,
            paddingBottom:
              theme.spacing.xxl +
              theme.sizes.miniPlayer +
              theme.spacing.md,
          }}
          renderItem={({ item, index }) => (
            <TrackRow
              row={item.row}
              badge={item.duplicate ? t('queue.badge.repeat') : null}
              reorderControls="buttons"
              onMoveUp={index > 0 ? bind(onMoveEntry, item, -1) : undefined}
              onMoveDown={
                index < model.entries.length - 1
                  ? bind(onMoveEntry, item, 1)
                  : undefined
              }
              onPress={bind(onPressEntry, item)}
              onIntent={bind(onRowIntent, item)}
              onToggleLike={bind(onToggleLike, item)}
              onContext={bind(onContext, item)}
              onRemove={bind(onRemoveEntry, item)}
            />
          )}
        />
      )}
    </View>
  );
}
