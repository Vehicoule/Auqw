import { View } from 'react-native';
import {
  DownloadIcon,
  IconButton,
  Pressable,
  Text,
} from './primitives.tsx';
import { useTheme } from './theme.tsx';
import { t, type UpdateCardModel } from '@auqw/ui-shared';

/**
 * The mobile update surface — the snack's replacement. Same chrome as
 * the collapsed miniplayer (raised card, hairline, float radius) and
 * the same floating slot above the tab bar: the host anchors it.
 *
 * Every pipeline phase renders through one model: a real byte bar
 * pinned to the card's bottom edge while 'downloading', the
 * DownloadIcon morph for idle → busy → failed, a cancel verb while
 * the pipeline can honestly abort, and no dismiss control while a
 * run is live — hiding progress would strand the user's only way to
 * stop a ~55 MB fetch.
 */
export function UpdateCard({
  model,
  onAct,
  onDismiss,
}: {
  readonly model: UpdateCardModel;
  readonly onAct: () => void;
  readonly onDismiss: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        marginHorizontal: theme.spacing.md,
        borderRadius: theme.radius.float,
        borderWidth: theme.strokes.hairline,
        borderColor: theme.colors.hairline,
        backgroundColor: theme.colors.raised,
        overflow: 'hidden',
      }}
      accessibilityLiveRegion="polite"
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          paddingLeft: theme.spacing.sm,
          paddingRight: theme.spacing.xs,
          paddingVertical: theme.spacing.xs,
          minHeight: theme.sizes.miniPlayer,
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor:
              model.chip === 'failed'
                ? theme.colors.fg08
                : theme.colors.accentSoft,
          }}
        >
          <DownloadIcon
            state={model.chip}
            size={16}
            color={
              model.chip === 'failed'
                ? theme.colors.warn
                : theme.colors.accent
            }
          />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text variant="body" color="primary">
            {model.title}
          </Text>
          {model.detail !== '' && (
            <Text variant="metadata" color="secondary">
              {model.detail}
            </Text>
          )}
        </View>
        {model.actionLabel !== null && (
          <Pressable
            onPress={onAct}
            accessibilityRole="button"
            accessibilityLabel={model.actionLabel}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            style={{
              minHeight: theme.sizes.touch,
              minWidth: theme.sizes.touch,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.spacing.xs,
            }}
          >
            <Text variant="body" color="accent">
              {model.actionLabel}
            </Text>
          </Pressable>
        )}
        {model.dismissible && (
          <IconButton
            icon="close"
            size={32}
            iconSize={10}
            accessibilityLabel={t('update.dismiss')}
            onPress={onDismiss}
          />
        )}
      </View>
      {model.progress !== null && (
        <View
          style={{
            height: theme.strokes.progress * 2,
            backgroundColor: theme.colors.fg18,
          }}
        >
          <View
            style={{
              width: `${model.progress * 100}%`,
              height: '100%',
              backgroundColor: theme.colors.accent,
            }}
          />
        </View>
      )}
    </View>
  );
}
