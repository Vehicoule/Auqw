import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { useTheme } from './theme.tsx';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  Text,
} from './primitives.tsx';
import { TrackRow } from './track-row.tsx';
import { EmptyState, UnavailableState } from './states.tsx';
import { NameField } from './sheets.tsx';
import type { PlaylistEntryModel, PlaylistModel } from '@auqw/ui-shared';

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
  readonly onPlayAll?: (() => void) | undefined;
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
  const theme = useTheme();
  return (
    <Pressable
      compact
      onPress={onPress}
      accessibilityLabel={label}
      style={{
        paddingHorizontal: theme.spacing.md,
        minHeight: 30,
        justifyContent: 'center',
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.fg08,
      }}
    >
      <Text variant="metadata" color={warn ? 'warn' : 'primary'}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PlaylistScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onBack,
  onPlayAll,
  onDownloadAll,
  downloadAllState = 'none',
  onRename,
  onDelete,
  onPressEntry,
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
          title="playlist not found"
          hint="it may have been deleted"
        />
        {onBack !== undefined && (
          <View style={{ alignItems: 'center', paddingBottom: theme.spacing.xl }}>
            <HeaderButton label="back" onPress={onBack} />
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
        <Pressable
          compact
          onPress={onBack}
          accessibilityLabel="back"
          style={{ padding: theme.spacing.xs }}
        >
          <Icon
            name="chevron-left"
            size={16}
            color={theme.colors.textSecondary}
          />
        </Pressable>
        <Artwork url={model.artworkUrl} size={56} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading" color="bright" numberOfLines={1}>
            {model.name}
          </Text>
          <Text variant="metadata" color="secondary">
            user playlist · {model.count}{' '}
            {model.count === 1 ? 'track' : 'tracks'}
          </Text>
        </View>
        <IconButton
          icon="play"
          size={34}
          iconSize={14}
          color={theme.colors.textBright}
          accessibilityLabel={`play ${model.name}`}
          onPress={model.count === 0 ? undefined : onPlayAll}
        />
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
                ? 'downloaded'
                : downloadAllState === 'partial'
                  ? 'download missing'
                  : 'download all'
            }
            onPress={
              model.count === 0 || downloadAllState === 'all'
                ? undefined
                : onDownloadAll
            }
          />
        )}
        <HeaderButton
          label="rename"
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
              label="confirm delete"
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
              label="cancel"
              onPress={() => setConfirming(false)}
            />
          </>
        ) : (
          <HeaderButton
            label="delete"
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
            placeholder="playlist name"
            submitLabel="save"
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
          title="empty playlist"
          hint="add tracks from any row's add-to-playlist action"
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
            paddingBottom: theme.spacing.xxl,
          }}
          renderItem={({ item, index }) => (
            <TrackRow
              row={item.row}
              badge={item.duplicate ? 'repeat' : null}
              reorderControls="buttons"
              onMoveUp={
                index > 0 && onMoveEntry !== undefined
                  ? () => onMoveEntry(item, -1)
                  : undefined
              }
              onMoveDown={
                index < model.entries.length - 1 &&
                  onMoveEntry !== undefined
                  ? () => onMoveEntry(item, 1)
                  : undefined
              }
              onPress={
                onPressEntry === undefined
                  ? undefined
                  : () => onPressEntry(item)
              }
              onToggleLike={
                onToggleLike === undefined
                  ? undefined
                  : () => onToggleLike(item)
              }
              onContext={
                onContext === undefined ? undefined : () => onContext(item)
              }
              onRemove={
                onRemoveEntry === undefined
                  ? undefined
                  : () => onRemoveEntry(item)
              }
            />
          )}
        />
      )}
    </View>
  );
}
