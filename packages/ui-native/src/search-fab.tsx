import { useEffect, useRef } from 'react';
import { TextInput, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import type { SearchFieldView } from '@auqw/ui-shared/controllers';
import { Icon, Pressable, Spinner, Text } from './primitives.tsx';
import { useTheme } from './theme.tsx';

const FAB = 44;

/**
 * The one search field, floating: a solid loupe pinned top-right over
 * every tab that springs open into the field (the loupe icon travels
 * into the field's leading slot — one element, no swap). Focus keeps
 * only a plain hairline emphasis — the morph itself is the affordance.
 */
export type SearchFabProps = {
  readonly field: SearchFieldView;
  /** A query is live — the collapsed loupe tints accent. */
  readonly live: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Bump to open + focus (the app's search-focus signal). */
  readonly focusSignal?: number | undefined;
  /** Focused while the search surface isn't active — the app routes. */
  readonly onNavigateToSearch?: (() => void) | undefined;
  readonly topInset: number;
  /** Pane width the open field grows into. */
  readonly width: number;
};

export function SearchFab({
  field,
  live,
  open,
  onOpenChange,
  focusSignal,
  onNavigateToSearch,
  topInset,
  width,
}: SearchFabProps) {
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);
  const openT = useSharedValue(open ? 1 : 0);
  const focusT = useSharedValue(0);

  useEffect(() => {
    openT.value = withSpring(open ? 1 : 0, { stiffness: 260, damping: 26 });
    if (open) {
      // The caret lands as the morph settles, not before the field
      // exists — 120ms is well inside the spring's open leg.
      const timer = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(timer);
    }
    // Closing while focused keeps the soft keyboard over the tab —
    // drop the caret with the field.
    inputRef.current?.blur();
    focusT.value = 0;
    return undefined;
  }, [open, openT, focusT]);

  // The signal must *change* to open — the fab unmounts when the dev
  // gallery covers the stack (and on any future conditional mount), so
  // a remount with a live tick would otherwise reopen the field and
  // route the app to explore unprompted. Same mount guard the web
  // field (search-field.tsx) carries.
  const lastSignal = useRef(focusSignal);
  useEffect(() => {
    if (focusSignal !== lastSignal.current) {
      lastSignal.current = focusSignal;
      if (focusSignal !== undefined && focusSignal > 0) {
        onOpenChange(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  const openWidth = Math.max(FAB, width - theme.spacing.screen * 2);

  const box = useAnimatedStyle(() => ({
    width: interpolate(openT.value, [0, 1], [FAB, openWidth]),
    borderRadius: interpolate(
      openT.value,
      [0, 1],
      [FAB / 2, theme.radius.float],
    ),
    // Focus emphasis — the field's own hairline cross-fades to the
    // accent tone. Animating the parent's border in place keeps the
    // stroke inside its clipping bounds (an inset overlay was clipped
    // away by overflow:hidden and never showed).
    borderColor: interpolateColor(
      focusT.value,
      [0, 1],
      [theme.colors.hairline, theme.colors.accent],
    ),
  }));

  const loupeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(openT.value, [0, 1], [1, 0.8]) }],
  }));

  const innerStyle = useAnimatedStyle(() => ({
    // Fade only — no slide; the content materializes once the field
    // is wide enough to hold it.
    opacity: interpolate(openT.value, [0.55, 0.85], [0, 1]),
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          top: topInset + theme.spacing.xs,
          right: theme.spacing.screen,
          height: FAB,
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          // Solid surface — the field must read over the content it
          // overlays; a blurred loupe cost a glass pass and still
          // showed fragments of the rows beneath.
          backgroundColor: theme.colors.raised,
          overflow: 'hidden',
        },
        box,
      ]}
    >
      <Pressable
        compact
        accessibilityLabel={field.label}
        onPress={() => {
          if (!open) {
            onOpenChange(true);
          } else {
            onNavigateToSearch?.();
          }
        }}
        style={{
          width: FAB - theme.strokes.hairline * 2,
          height: FAB - theme.strokes.hairline * 2,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Animated.View style={loupeStyle}>
          <Icon
            name="search"
            size={15}
            color={live ? theme.colors.accent : theme.colors.textSecondary}
          />
        </Animated.View>
      </Pressable>
      <Animated.View
        style={[
          {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            paddingRight: theme.spacing.xs,
          },
          innerStyle,
        ]}
        pointerEvents={open ? 'auto' : 'none'}
      >
        <TextInput
          ref={inputRef}
          value={field.value}
          editable={!field.readOnly}
          onChangeText={(text) => field.onChange?.(text)}
          onSubmitEditing={() => field.onSubmit?.()}
          onFocus={() => {
            focusT.value = theme.reducedMotion
              ? 1
              : withTiming(1, { duration: theme.motion.state });
            onNavigateToSearch?.();
          }}
          onBlur={() => {
            focusT.value = theme.reducedMotion
              ? 0
              : withTiming(0, { duration: theme.motion.state });
          }}
          placeholder={field.label}
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={field.label}
          style={[
            theme.typography.body,
            { flex: 1, color: theme.colors.textPrimary, padding: 0 },
          ]}
        />
        {field.loading ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
            }}
          >
            <Spinner size={14} />
            {field.cancel !== null && (
              <Pressable
                compact
                onPress={field.cancel.onPress}
                accessibilityLabel={field.cancel.a11yLabel}
              >
                <Text variant="metadata" color="accent">
                  {field.cancel.label}
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          field.clear !== null && (
            <Pressable
              compact
              onPress={field.clear.onPress}
              accessibilityLabel={field.clear.a11yLabel}
              style={{ padding: theme.spacing.xs }}
            >
              <Icon
                name="close"
                size={12}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          )
        )}
        <Pressable
          compact
          onPress={() => onOpenChange(false)}
          accessibilityLabel={field.label}
          style={{ padding: theme.spacing.xs }}
        >
          <Icon
            name="chevron-down"
            size={14}
            color={theme.colors.textSecondary}
          />
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}
