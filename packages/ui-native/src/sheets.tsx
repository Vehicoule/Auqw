import { useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, bind, Icon, Pressable, Text } from './primitives.tsx';
import type { IconName } from './primitives.tsx';
import { t } from '@auqw/ui-shared';
import type {
  LanguageOption,
  ProviderPickerOption,
} from '@auqw/ui-shared';

/**
 * Sheet building blocks: the content frame (title row + actions) plus
 * a name field matching the search-field treatment, reused by the
 * Slice-2 sheets — row actions and the add-to-playlist picker. The
 * surrounding chrome is the host's job: `SheetScreen` in stack.tsx /
 * stack.native.tsx (native formSheet, or scrim + panel on web).
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
      accessibilityViewIsModal
      style={{
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
          accessibilityLabel={t('common.close')}
          style={{ padding: theme.spacing.xs }}
        >
          <Icon name="close" size={14} color={theme.colors.textSecondary} />
        </Pressable>
      </View>
      {children}
    </View>
  );
}

// Every sheet row shares this frame: touch-height row, pressed bg,
// optional dashed outline for "reset/create" affordances.
function SheetRow({
  onPress,
  accessibilityLabel,
  selected,
  dashed,
  children,
}: {
  readonly onPress?: (() => void) | undefined;
  readonly accessibilityLabel: string;
  readonly selected?: boolean | undefined;
  readonly dashed?: boolean | undefined;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={
        selected === undefined ? undefined : { selected }
      }
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          minHeight: theme.sizes.touch,
          paddingHorizontal: theme.spacing.sm,
          borderRadius: theme.radius.control,
        },
        dashed === true && {
          borderWidth: theme.strokes.hairline,
          borderStyle: 'dashed',
          borderColor: theme.colors.fg25,
        },
        pressed && { backgroundColor: theme.colors.fg08 },
      ]}
    >
      {children}
    </Pressable>
  );
}

/**
 * Field + confirm/cancel row — the same rounded-field treatment the
 * search bar uses, reused by the new-playlist flow and the picker.
 */
export function NameField({
  value,
  placeholder,
  submitLabel = t('common.create'),
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
          accessibilityLabel={t('common.cancel')}
          style={{ paddingHorizontal: theme.spacing.xs }}
        >
          <Text variant="metadata" color="secondary">
            {t('common.cancel')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * Single-value editor sheet — free-form settings values like the
 * storefront's ISO-3166 alpha-2 code. `onSubmit` gets the trimmed
 * draft; the caller validates and dismisses on accept. `clearLabel`
 * renders a dashed reset row for values with an auto/null state.
 */
export function ValueFieldSheet({
  title,
  initial = '',
  placeholder,
  submitLabel = t('common.save'),
  clearLabel,
  onSubmit,
  onClear,
  onDismiss,
}: {
  readonly title: string;
  readonly initial?: string | undefined;
  readonly placeholder: string;
  readonly submitLabel?: string | undefined;
  readonly clearLabel?: string | undefined;
  readonly onSubmit?: ((value: string) => void) | undefined;
  readonly onClear?: (() => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState(initial);
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      <NameField
        value={draft}
        placeholder={placeholder}
        submitLabel={submitLabel}
        autoFocus
        onChange={setDraft}
        onSubmit={onSubmit}
        onCancel={onDismiss}
      />
      {clearLabel !== undefined && onClear !== undefined && (
        <SheetRow onPress={onClear} accessibilityLabel={clearLabel} dashed>
          <Icon name="close" size={15} color={theme.colors.textSecondary} />
          <Text variant="body" color="secondary">
            {clearLabel}
          </Text>
        </SheetRow>
      )}
    </SheetScaffold>
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
        <SheetRow
          key={action.key}
          onPress={bind(onAction, action.key)}
          accessibilityLabel={action.label}
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
        </SheetRow>
      ))}
    </SheetScaffold>
  );
}

export type { ProviderPickerOption };

/**
 * One settings slot's provider choices — only providers that
 * declared the slot's capability reach `options` (the caller gates);
 * the selected option reads accent + check, never a fake default.
 */
export function ProviderPickerSheet({
  title = t('sheets.providerTitle'),
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
  const theme = useTheme();
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      {options.length === 0 ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            minHeight: theme.sizes.touch,
            paddingHorizontal: theme.spacing.sm,
          }}
        >
          <Icon name="warn" size={15} color={theme.colors.warn} />
          <Text variant="body" color="secondary">
            {t('sheets.noProvider')}
          </Text>
        </View>
      ) : (
        options.map((option) => {
          const selected = option.key === selectedKey;
          return (
            <SheetRow
              key={option.key}
              onPress={bind(onPick, option.key)}
              accessibilityLabel={option.label}
              selected={selected}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  variant="body"
                  color={selected ? 'accent' : 'primary'}
                  numberOfLines={1}
                >
                  {option.label}
                </Text>
                {option.detail != null && (
                  <Text variant="metadata" color="secondary">
                    {option.detail}
                  </Text>
                )}
              </View>
              {selected && (
                <Icon name="check" size={14} color={theme.colors.accent} />
              )}
            </SheetRow>
          );
        })
      )}
    </SheetScaffold>
  );
}

/**
 * UI-language choices — 'system' (follow the platform locale) plus
 * every shipped locale. Mirrors `ProviderPickerSheet`: the selected
 * row reads accent + check, never a fake default, and the sheet owns
 * no state — every pick delegates to the host.
 */
export function LanguagePickerSheet({
  title = t('sheets.languageTitle'),
  options,
  selectedKey,
  onPick,
  onDismiss,
}: {
  readonly title?: string | undefined;
  readonly options: readonly LanguageOption[];
  readonly selectedKey: string | null;
  readonly onPick?: ((key: string) => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
}) {
  const theme = useTheme();
  // The row list outgrows short (e.g. landscape) viewports; bound the
  // list to the viewport and scroll rather than let the sheet spill
  // past the top edge — both hosts render ScrollView natively.
  const listMaxHeight = Math.round(useWindowDimensions().height * 0.6);
  return (
    <SheetScaffold title={title} onDismiss={onDismiss}>
      <ScrollView style={{ maxHeight: listMaxHeight }}>
        {options.map((option) => {
          const selected = option.key === selectedKey;
          return (
            <SheetRow
              key={option.key}
              onPress={bind(onPick, option.key)}
              accessibilityLabel={option.label}
              selected={selected}
            >
              <Text
                variant="body"
                color={selected ? 'accent' : 'primary'}
                style={{ flex: 1 }}
                numberOfLines={1}
              >
                {option.label}
              </Text>
              {selected && (
                <Icon name="check" size={14} color={theme.colors.accent} />
              )}
            </SheetRow>
          );
        })}
      </ScrollView>
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
  title = t('sheets.addToPlaylist'),
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
        <SheetRow
          key={playlist.playlistId}
          onPress={bind(onPick, playlist.playlistId)}
          accessibilityLabel={t('sheets.itemA11y', {
            name: playlist.name,
            count: playlist.count,
          })}
        >
          <Artwork url={playlist.artworkUrl} size={40} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="body" color="primary" numberOfLines={1}>
              {playlist.name}
            </Text>
            <Text variant="metadata" color="secondary">
              {t('common.trackCount', { count: playlist.count })}
            </Text>
          </View>
        </SheetRow>
      ))}
      {creating ? (
        <NameField
          value={draft}
          placeholder={t('common.newPlaylistName')}
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
        <SheetRow
          onPress={
            onCreate === undefined ? undefined : () => setCreating(true)
          }
          accessibilityLabel={t('common.newPlaylist')}
          dashed
        >
          <Icon name="list-plus" size={15} color={theme.colors.textSecondary} />
          <Text variant="body" color="secondary">
            {t('common.newPlaylist')}
          </Text>
        </SheetRow>
      )}
    </SheetScaffold>
  );
}
