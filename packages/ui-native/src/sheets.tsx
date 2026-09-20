import { useState } from 'react';
import type { ReactNode } from 'react';
import { TextInput, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';

/**
 * Sheet building blocks: a bottom-anchored overlay (scrim + raised
 * panel), a name field matching the search-field treatment, and the
 * two Slice-2 sheets — row actions and the add-to-playlist picker.
 * Sheets own no state beyond the draft name; every action delegates.
 */

export type SheetAction = {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly destructive?: boolean | undefined;
};

function SheetScaffold({
  title,
  onDismiss,
  children,
}: {
  readonly title: string;
  readonly onDismiss?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colors.scrim,
        justifyContent: 'flex-end',
      }}
    >
      {/* Tap-outside dismiss lives on the scrim, not the panel. */}
      <Pressable
        compact
        onPress={onDismiss}
        accessibilityLabel={`dismiss ${title}`}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        accessibilityViewIsModal
        style={{
          backgroundColor: theme.colors.raised,
          borderTopLeftRadius: theme.radius.float,
          borderTopRightRadius: theme.radius.float,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.xs,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: theme.spacing.sm,
          }}
        >
          <Text variant="heading" color="bright" style={{ flex: 1 }}>
            {title}
          </Text>
          <Pressable
            compact
            onPress={onDismiss}
            accessibilityLabel="close"
            style={{ padding: theme.spacing.xs }}
          >
            <Icon name="close" size={14} color={theme.colors.textSecondary} />
          </Pressable>
        </View>
        {children}
      </View>
    </View>
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
  const theme = useTheme();
  const trimmed = value.trim();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        backgroundColor: theme.colors.fg08,
        borderRadius: theme.radius.float,
        paddingHorizontal: 11,
        minHeight: theme.sizes.touch,
      }}
    >
      <TextInput
        value={value}
        onChangeText={onChange}
        onSubmitEditing={
          onSubmit === undefined || trimmed === ''
            ? undefined
            : () => onSubmit(trimmed)
        }
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textSecondary}
        autoCapitalize="words"
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType="done"
        accessibilityLabel={placeholder}
        style={[
          theme.typography.body,
          {
            flex: 1,
            color: theme.colors.textPrimary,
            paddingVertical: theme.spacing.sm,
          },
        ]}
      />
      {onSubmit !== undefined && (
        <Pressable
          compact
          onPress={trimmed === '' ? undefined : () => onSubmit(trimmed)}
          accessibilityLabel={submitLabel}
          accessibilityState={{ disabled: trimmed === '' }}
          style={{ paddingHorizontal: theme.spacing.xs }}
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
          compact
          onPress={onCancel}
          accessibilityLabel="cancel"
          style={{ paddingHorizontal: theme.spacing.xs }}
        >
          <Text variant="metadata" color="secondary">
            cancel
          </Text>
        </Pressable>
      )}
    </View>
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
  const theme = useTheme();
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      {actions.map((action) => (
        <Pressable
          key={action.key}
          onPress={
            onAction === undefined ? undefined : () => onAction(action.key)
          }
          accessibilityLabel={action.label}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              minHeight: theme.sizes.touch,
              paddingHorizontal: theme.spacing.sm,
              borderRadius: theme.radius.control,
            },
            pressed && { backgroundColor: theme.colors.fg08 },
          ]}
        >
          <Icon
            name={action.icon}
            size={15}
            color={
              action.destructive === true
                ? theme.colors.warn
                : theme.colors.textSecondary
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
  const theme = useTheme();
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
          accessibilityLabel={`${playlist.name}, ${playlist.count} tracks`}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              minHeight: theme.sizes.touch,
              paddingHorizontal: theme.spacing.sm,
              borderRadius: theme.radius.control,
            },
            pressed && { backgroundColor: theme.colors.fg08 },
          ]}
        >
          <Artwork url={playlist.artworkUrl} size={40} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="body" color="primary" numberOfLines={1}>
              {playlist.name}
            </Text>
            <Text variant="metadata" color="secondary">
              {playlist.count} {playlist.count === 1 ? 'track' : 'tracks'}
            </Text>
          </View>
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
          accessibilityLabel="new playlist"
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              minHeight: theme.sizes.touch,
              paddingHorizontal: theme.spacing.sm,
              borderRadius: theme.radius.control,
              borderWidth: theme.strokes.hairline,
              borderStyle: 'dashed',
              borderColor: theme.colors.fg25,
            },
            pressed && { backgroundColor: theme.colors.fg08 },
          ]}
        >
          <Icon name="list-plus" size={15} color={theme.colors.textSecondary} />
          <Text variant="body" color="secondary">
            new playlist
          </Text>
        </Pressable>
      )}
    </SheetScaffold>
  );
}
