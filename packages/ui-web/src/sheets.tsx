import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { useOverlayDismiss } from './stack.tsx';
import { sheetKeyAction } from './keyboard.ts';

/**
 * Sheet building blocks: the content frame (title row + actions) plus
 * a name field matching the search-field treatment, reused by the
 * Slice-2 sheets — row actions and the add-to-playlist picker. The
 * modal chrome (scrim + dialog) is `Sheet`'s job; the block-level
 * sheets stay plain panels so hosts can place them. Sheets own no
 * state beyond the draft name; every action delegates.
 */

export type SheetAction = {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly destructive?: boolean | undefined;
};

export function SheetScaffold({
  title,
  onDismiss,
  children,
}: {
  readonly title: string;
  readonly onDismiss?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="uw-sheet-panel">
      <div className="uw-sheet-panel__head">
        <Text variant="heading" color="bright" className="uw-sheet-panel__title">
          {title}
        </Text>
        <Pressable
          onPress={onDismiss}
          ariaLabel="close"
          className="uw-sheet-panel__close"
        >
          <Icon name="close" size={14} color="var(--text-secondary)" />
        </Pressable>
      </div>
      {children}
    </div>
  );
}

/**
 * The modal host — scrim + dialog panel. Mounts only when `open`;
 * Escape and scrim click dismiss, matching the native sheet's swipe.
 */
export function Sheet({
  open,
  label,
  onDismiss,
  children,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly onDismiss?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  // Escape ownership comes from the stack when mounted inside one —
  // a push under this sheet keeps its listener silent until the sheet
  // unregisters on close.
  useOverlayDismiss(open ? onDismiss : undefined);
  if (!open) {
    return null;
  }
  return (
    <div className="uw-sheet-host" data-sheet="panel">
      <button
        type="button"
        className="uw-scrim"
        aria-label="close sheet"
        tabIndex={-1}
        onClick={onDismiss}
      />
      <div className="uw-sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/**
 * Field + confirm/cancel row — the same rounded-field treatment the
 * search bar uses, reused by the new-playlist flow and the picker.
 */
export function NameField({
  value,
  placeholder,
  submitLabel = 'create',
  autoFocus = false,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly submitLabel?: string | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly onSubmit?: ((value: string) => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
}) {
  const trimmed = value.trim();
  return (
    <div className="uw-namefield">
      <input
        className="uw-namefield__input"
        aria-label={placeholder}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        readOnly={onChange === undefined}
        onChange={
          onChange === undefined
            ? undefined
            : (event) => onChange(event.currentTarget.value)
        }
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onSubmit !== undefined && trimmed !== '') {
            onSubmit(trimmed);
          }
          if (sheetKeyAction(event.key) === 'close' && onCancel !== undefined) {
            onCancel();
          }
        }}
      />
      {onSubmit !== undefined && (
        <Pressable
          onPress={trimmed === '' ? undefined : () => onSubmit(trimmed)}
          ariaLabel={submitLabel}
          className="uw-namefield__action"
        >
          <Text
            variant="metadata"
            color={trimmed === '' ? 'secondary' : 'accent'}
          >
            {submitLabel}
          </Text>
        </Pressable>
      )}
      {onCancel !== undefined && (
        <Pressable
          onPress={onCancel}
          ariaLabel="cancel"
          className="uw-namefield__action"
        >
          <Text variant="metadata" color="secondary">
            cancel
          </Text>
        </Pressable>
      )}
    </div>
  );
}

export function RowActionsSheet({
  title,
  actions,
  onAction,
  onDismiss,
}: {
  readonly title: string;
  readonly actions: readonly SheetAction[];
  readonly onAction?: ((key: string) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      <div role="menu" aria-label={title}>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            onPress={
              onAction === undefined ? undefined : () => onAction(action.key)
            }
            ariaLabel={action.label}
            className="uw-sheet-row"
          >
            <Icon
              name={action.icon}
              size={15}
              color={
                action.destructive === true
                  ? 'var(--warn)'
                  : 'var(--text-secondary)'
              }
            />
            <Text
              variant="body"
              color={action.destructive === true ? 'warn' : 'primary'}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </div>
    </SheetScaffold>
  );
}

export type ProviderPickerOption = {
  /** The settings value — a provider id, or 'auto' for auto-routing. */
  readonly key: string;
  readonly label: string;
  readonly detail?: string | null | undefined;
};

/**
 * One settings slot's provider choices — only providers that
 * declared the slot's capability reach `options` (the caller gates);
 * the selected option reads accent + check, never a fake default.
 */
export function ProviderPickerSheet({
  title = 'provider',
  options,
  selectedKey,
  onPick,
  onDismiss,
}: {
  readonly title?: string | undefined;
  readonly options: readonly ProviderPickerOption[];
  readonly selectedKey: string | null;
  readonly onPick?: ((key: string) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      {options.length === 0 ? (
        <div className="uw-sheet-row" data-state="unavailable">
          <Icon name="warn" size={15} color="var(--warn)" />
          <Text variant="body" color="secondary">
            no provider declares this capability
          </Text>
        </div>
      ) : (
        options.map((option) => {
          const selected = option.key === selectedKey;
          return (
            <Pressable
              key={option.key}
              onPress={
                onPick === undefined ? undefined : () => onPick(option.key)
              }
              ariaLabel={option.label}
              ariaSelected={selected}
              className="uw-sheet-row"
            >
              <span className="uw-sheet-row__text">
                <Text
                  variant="body"
                  color={selected ? 'accent' : 'primary'}
                  numberOfLines={1}
                >
                  {option.label}
                </Text>
                {option.detail != null && (
                  <Text variant="metadata" color="secondary" numberOfLines={1}>
                    {option.detail}
                  </Text>
                )}
              </span>
              {selected && (
                <Icon name="check" size={14} color="var(--accent)" />
              )}
            </Pressable>
          );
        })
      )}
    </SheetScaffold>
  );
}

export type PlaylistPickerItem = {
  readonly playlistId: string;
  readonly name: string;
  readonly count: number;
  readonly artworkUrl: string | null;
};

export function AddToPlaylistSheet({
  title = 'add to playlist',
  playlists,
  onPick,
  onCreate,
  onDismiss,
}: {
  readonly title?: string | undefined;
  readonly playlists: readonly PlaylistPickerItem[];
  readonly onPick?: ((playlistId: string) => void) | undefined;
  readonly onCreate?: ((name: string) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      {playlists.map((playlist) => (
        <Pressable
          key={playlist.playlistId}
          onPress={
            onPick === undefined
              ? undefined
              : () => onPick(playlist.playlistId)
          }
          ariaLabel={`${playlist.name}, ${playlist.count} tracks`}
          className="uw-sheet-row"
        >
          <Artwork url={playlist.artworkUrl} size={40} />
          <span className="uw-sheet-row__text">
            <Text variant="body" color="primary" numberOfLines={1}>
              {playlist.name}
            </Text>
            <Text variant="metadata" color="secondary">
              {playlist.count} {playlist.count === 1 ? 'track' : 'tracks'}
            </Text>
          </span>
        </Pressable>
      ))}
      {creating ? (
        <NameField
          value={draft}
          placeholder="new playlist name"
          autoFocus
          onChange={setDraft}
          onSubmit={
            onCreate === undefined
              ? undefined
              : (name) => {
                  onCreate(name);
                  setDraft('');
                  setCreating(false);
                }
          }
          onCancel={() => {
            setDraft('');
            setCreating(false);
          }}
        />
      ) : (
        <Pressable
          onPress={onCreate === undefined ? undefined : () => setCreating(true)}
          ariaLabel="new playlist"
          className="uw-sheet-row uw-sheet-row--dashed"
        >
          <Icon name="list-plus" size={15} color="var(--text-secondary)" />
          <Text variant="body" color="secondary">
            new playlist
          </Text>
        </Pressable>
      )}
    </SheetScaffold>
  );
}
