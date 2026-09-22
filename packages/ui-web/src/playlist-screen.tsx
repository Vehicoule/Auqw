import { useState } from 'react';
import {
  Artwork,
  Icon,
  IconButton,
  Pressable,
  Text,
} from './primitives.tsx';
import { TrackRow, useTrackList } from './track-row.tsx';
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
  return (
    <Pressable
      onPress={onPress}
      ariaLabel={label}
      className={`uw-headbtn${warn ? ' uw-headbtn--warn' : ''}`}
    >
      <Text variant="metadata" color={warn ? 'warn' : 'primary'}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PlaylistScreen({
  model,
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
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const entries = model?.entries ?? [];
  const list = useTrackList({
    count: entries.length,
    onActivate:
      onPressEntry === undefined
        ? undefined
        : (index) => {
            const entry = entries[index];
            if (entry !== undefined) {
              onPressEntry(entry);
            }
          },
    onContext:
      onContext === undefined
        ? undefined
        : (index) => {
            const entry = entries[index];
            if (entry !== undefined) {
              onContext(entry);
            }
          },
  });
  if (model === null) {
    return (
      <div className="uw-screen uw-playlist">
        <UnavailableState
          title="playlist not found"
          hint="it may have been deleted"
        />
        {onBack !== undefined && (
          <div className="uw-playlist__back">
            <HeaderButton label="back" onPress={onBack} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className="uw-screen uw-playlist"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <div className="uw-playlist__head">
        <Pressable onPress={onBack} ariaLabel="back" className="uw-back">
          <Icon name="chevron-left" size={16} color="var(--text-secondary)" />
        </Pressable>
        <Artwork url={model.artworkUrl} size={56} />
        <div className="uw-playlist__head-text">
          <Text variant="heading" color="bright" numberOfLines={1}>
            {model.name}
          </Text>
          <Text variant="metadata" color="secondary">
            user playlist · {model.count}{' '}
            {model.count === 1 ? 'track' : 'tracks'}
          </Text>
        </div>
        <IconButton
          icon="play"
          size={34}
          iconSize={14}
          color="var(--text-bright)"
          ariaLabel={`play ${model.name}`}
          onPress={model.count === 0 ? undefined : onPlayAll}
        />
      </div>

      <div className="uw-playlist__actions">
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
      </div>

      {renaming && (
        <div className="uw-playlist__rename">
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
        </div>
      )}

      {model.entries.length === 0 ? (
        <EmptyState
          title="empty playlist"
          hint="add tracks from any row's add-to-playlist action"
          icon="list-plus"
        />
      ) : (
        <div
          role="list"
          aria-label={model.name}
          className="uw-list"
          onKeyDown={list.listProps.onKeyDown}
        >
          {model.entries.map((entry, index) => (
            <TrackRow
              key={entry.entryId}
              row={entry.row}
              badge={entry.duplicate ? 'repeat' : null}
              reorderControls="buttons"
              tabIndex={list.rowTabIndex(index)}
              onFocusRow={() => list.onRowFocus(index)}
              onMoveUp={
                index > 0 && onMoveEntry !== undefined
                  ? () => onMoveEntry(entry, -1)
                  : undefined
              }
              onMoveDown={
                index < model.entries.length - 1 && onMoveEntry !== undefined
                  ? () => onMoveEntry(entry, 1)
                  : undefined
              }
              onPress={
                onPressEntry === undefined
                  ? undefined
                  : () => onPressEntry(entry)
              }
              onToggleLike={
                onToggleLike === undefined
                  ? undefined
                  : () => onToggleLike(entry)
              }
              onContext={
                onContext === undefined ? undefined : () => onContext(entry)
              }
              onRemove={
                onRemoveEntry === undefined
                  ? undefined
                  : () => onRemoveEntry(entry)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
