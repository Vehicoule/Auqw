import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useTheme } from './theme.tsx';
import { PAUSE_LEFT, PAUSE_RIGHT, PLAY_LEFT, PLAY_RIGHT, quadPath } from './motion.ts';

export type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'metadata'
  | 'label';

export type TextColor =
  | 'primary'
  | 'bright'
  | 'secondary'
  | 'accent'
  | 'warn'
  | 'liked'
  | 'canvas';

const TEXT_TAGS = {
  display: 'h1',
  title: 'h2',
  heading: 'h3',
  body: 'p',
  metadata: 'span',
  label: 'span',
} as const;

export type TextProps = {
  readonly variant?: TextVariant | undefined;
  readonly color?: TextColor | undefined;
  readonly numeric?: boolean | undefined;
  readonly uppercase?: boolean | undefined;
  readonly numberOfLines?: number | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly title?: string | undefined;
  readonly children: ReactNode;
};

export function Text({
  variant = 'body',
  color = 'primary',
  numeric = false,
  uppercase = false,
  numberOfLines,
  className,
  style,
  title,
  children,
}: TextProps) {
  const Tag = TEXT_TAGS[variant];
  const classes = [
    'uw-text',
    `uw-text--${variant}`,
    `uw-color--${color}`,
    numeric ? 'uw-text--numeric' : '',
    uppercase ? 'uw-text--upper' : '',
    numberOfLines === 1 ? 'uw-text--1line' : '',
    numberOfLines !== undefined && numberOfLines > 1 ? 'uw-text--clamp' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const clampStyle: CSSProperties | undefined =
    numberOfLines !== undefined && numberOfLines > 1
      ? { WebkitLineClamp: numberOfLines }
      : undefined;
  return (
    <Tag
      className={classes}
      style={
        style === undefined && clampStyle === undefined
          ? undefined
          : { ...clampStyle, ...style }
      }
      title={title}
    >
      {children}
    </Tag>
  );
}

export function Hairline({ vertical = false }: { readonly vertical?: boolean | undefined }) {
  return <div className={vertical ? 'uw-hairline uw-hairline--v' : 'uw-hairline'} />;
}

export type PressableProps = {
  readonly onPress?: (() => void) | undefined;
  readonly onContextMenu?: ((event: MouseEvent) => void) | undefined;
  readonly ariaLabel: string;
  readonly ariaPressed?: boolean | undefined;
  readonly ariaSelected?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly title?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly onFocus?: (() => void) | undefined;
  readonly children?: ReactNode | undefined;
};

// A pressable with no handler is inert — same rule as IconButton:
// it must look and announce as disabled, not ship as a live
// control that silently does nothing.
export function Pressable({
  onPress,
  onContextMenu,
  ariaLabel,
  ariaPressed,
  ariaSelected,
  disabled = false,
  className,
  style,
  title,
  tabIndex,
  onFocus,
  children,
}: PressableProps) {
  const off = disabled || (onPress === undefined && onContextMenu === undefined);
  return (
    <button
      type="button"
      className={`uw-pressable${off ? ' uw-off' : ''}${className ? ` ${className}` : ''}`}
      onClick={off ? undefined : onPress}
      onContextMenu={
        off || onContextMenu === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              onContextMenu(event);
            }
      }
      disabled={off}
      aria-disabled={off ? 'true' : undefined}
      aria-pressed={ariaPressed}
      aria-selected={ariaSelected}
      aria-label={ariaLabel}
      style={style}
      title={title ?? undefined}
      tabIndex={off ? -1 : tabIndex}
      onFocus={onFocus}
    >
      {children}
    </button>
  );
}

export type IconButtonProps = {
  readonly icon: IconName;
  readonly onPress?: (() => void) | undefined;
  readonly ariaLabel: string;
  readonly size?: number | undefined;
  readonly iconSize?: number | undefined;
  readonly color?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly filled?: boolean | undefined;
  readonly className?: string | undefined;
};

export function IconButton({
  icon,
  onPress,
  ariaLabel,
  size,
  iconSize = 14,
  color,
  disabled = false,
  active = false,
  filled = false,
  className,
}: IconButtonProps) {
  const off = disabled || onPress === undefined;
  return (
    <button
      type="button"
      className={`uw-icon-btn${off ? ' uw-off' : ''}${active ? ' uw-icon-btn--active' : ''}${className ? ` ${className}` : ''}`}
      onClick={off ? undefined : onPress}
      disabled={off}
      aria-disabled={off ? 'true' : undefined}
      aria-pressed={active ? 'true' : undefined}
      aria-label={ariaLabel}
      style={size === undefined ? undefined : { width: size, height: size }}
    >
      {icon === 'heart' || icon === 'heart-filled' ? (
        <HeartIcon filled={icon === 'heart-filled' || filled} size={iconSize} color={color} />
      ) : (
        <Icon name={icon} size={iconSize} color={color} filled={filled} />
      )}
    </button>
  );
}

export type ArtworkProps = {
  readonly url: string | null;
  readonly size?: number | undefined;
  readonly fill?: boolean | undefined;
  readonly cornerRadius?: number | undefined;
  readonly monogram?: string | null | undefined;
  readonly dimmed?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly className?: string | undefined;
};

export function Artwork({
  url,
  size = 40,
  fill = false,
  cornerRadius,
  monogram,
  dimmed = false,
  loading = false,
  className,
}: ArtworkProps) {
  const classes = [
    'uw-artwork',
    fill ? 'uw-artwork--fill' : '',
    dimmed ? 'uw-artwork--dimmed' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const frame = fill
    ? undefined
    : { width: size, height: size, borderRadius: cornerRadius };
  return (
    <div className={classes} style={frame} aria-hidden="true">
      {loading ? (
        <div className="uw-artwork__veil">
          <Spinner size={fill ? 24 : Math.max(10, size * 0.3)} />
        </div>
      ) : url === null ? (
        monogram !== null && monogram !== undefined && monogram !== '' ? (
          <span
            className="uw-artwork__monogram"
            style={{ fontSize: fill ? 28 : size * 0.34 }}
          >
            {monogram.slice(0, 2).toUpperCase()}
          </span>
        ) : (
          <Icon name="note" size={fill ? 36 : size * 0.44} color="var(--text-secondary)" />
        )
      ) : (
        <img className="uw-artwork__img" src={url} alt="" />
      )}
    </div>
  );
}

export type IconName =
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'search'
  | 'heart'
  | 'heart-filled'
  | 'queue'
  | 'settings'
  | 'close'
  | 'drag-handle'
  | 'spinner'
  | 'warn'
  | 'download'
  | 'list-plus'
  | 'home'
  | 'compass'
  | 'library'
  | 'note'
  | 'repeat'
  | 'shuffle'
  | 'clock'
  | 'lyrics'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'chevron-down'
  | 'radio'
  | 'check'
  | 'menu'
  | 'monitor';

type GlyphShape =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly rx?: number;
    };

type Glyph = {
  readonly filled: boolean;
  readonly shapes: readonly GlyphShape[];
};

function p(d: string): GlyphShape {
  return { kind: 'path', d };
}

function c(cx: number, cy: number, r: number): GlyphShape {
  return { kind: 'circle', cx, cy, r };
}

function rr(
  x: number,
  y: number,
  w: number,
  h: number,
  rx?: number,
): GlyphShape {
  return rx === undefined
    ? { kind: 'rect', x, y, w, h }
    : { kind: 'rect', x, y, w, h, rx };
}

// The shared icon vocabulary — same glyph table the native renderer
// draws; 'monitor' is the desktop-only addition for the chrome's
// paired-devices row.
const GLYPHS: Record<IconName, Glyph> = {
  play: { filled: true, shapes: [p('M7 4.5v15l13-7.5z')] },
  pause: {
    filled: true,
    shapes: [rr(6.5, 5, 4, 14), rr(13.5, 5, 4, 14)],
  },
  previous: {
    filled: true,
    shapes: [p('M17 5v14L7 12z'), rr(5, 5, 2, 14)],
  },
  next: {
    filled: true,
    shapes: [p('M7 5v14l10-7z'), rr(17, 5, 2, 14)],
  },
  search: {
    filled: false,
    shapes: [c(10.5, 10.5, 6), p('m15 15 5.5 5.5')],
  },
  heart: {
    filled: false,
    shapes: [
      p(
        'M12 20s-8-4.7-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.3-8 10-8 10z',
      ),
    ],
  },
  'heart-filled': {
    filled: true,
    shapes: [
      p(
        'M12 20s-8-4.7-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.3-8 10-8 10z',
      ),
    ],
  },
  queue: {
    filled: false,
    shapes: [
      p('M5 6h14M5 11h14M5 16h9'),
      p('M17 14v6m0 0-2-2m2 2 2-2'),
    ],
  },
  settings: {
    filled: false,
    shapes: [
      c(12, 12, 3),
      p(
        'M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M18 6l-2 2M8 16l-2 2',
      ),
    ],
  },
  close: { filled: false, shapes: [p('M6 6l12 12M18 6 6 18')] },
  'drag-handle': { filled: false, shapes: [p('M5 9h14M5 15h14')] },
  spinner: { filled: false, shapes: [p('M20 12a8 8 0 1 1-8-8')] },
  warn: {
    filled: false,
    shapes: [p('M12 4 3 20h18zM12 10v4m0 3v.5')],
  },
  download: {
    filled: false,
    shapes: [p('M12 4v11m0 0-4-4m4 4 4-4M4 19h16')],
  },
  'list-plus': {
    filled: false,
    shapes: [p('M4 6h12M4 11h12M4 16h7m4 0h6m-3-3v6')],
  },
  home: {
    filled: false,
    shapes: [p('M4 11 12 4l8 7v8h-5v-5H9v5H4z')],
  },
  compass: {
    filled: false,
    shapes: [c(12, 12, 8), p('m15.5 8.5-2 5-5 2 2-5z')],
  },
  library: {
    filled: false,
    shapes: [p('M5 5v14M9.5 5v14M14 6l5 1.2L16 19l-5-1.2z')],
  },
  note: {
    filled: false,
    shapes: [p('M9 18V6l10-2v11'), c(6.5, 18, 2.5), c(16.5, 15, 2.5)],
  },
  repeat: {
    filled: false,
    shapes: [
      p('M17 4l3 3-3 3M20 7H7a3 3 0 0 0-3 3v1M7 20l-3-3 3-3M4 17h13a3 3 0 0 0 3-3v-1'),
    ],
  },
  shuffle: {
    filled: false,
    shapes: [
      p('M4 6h4l9 12h5m0 0-3-3m3 3-3 3M4 18h4l2.5-3.3M14.5 9.3 16 7.5h5m0 0-3-3m3 3-3 3'),
    ],
  },
  clock: {
    filled: false,
    shapes: [c(12, 12, 8), p('M12 7v5l3.5 2')],
  },
  lyrics: {
    filled: false,
    shapes: [p('M5 5h14M5 10h14M5 15h9M5 20h6')],
  },
  'chevron-left': { filled: false, shapes: [p('m14 6-6 6 6 6')] },
  'chevron-right': { filled: false, shapes: [p('m10 6 6 6-6 6')] },
  'chevron-up': { filled: false, shapes: [p('m6 14 6-6 6 6')] },
  'chevron-down': { filled: false, shapes: [p('m6 10 6 6 6-6')] },
  radio: {
    filled: false,
    shapes: [
      c(12, 12, 1.6),
      p('M8.46 8.46a5 5 0 0 0 0 7.08M15.54 8.46a5 5 0 0 1 0 7.08'),
      p('M5.64 5.64a9 9 0 0 0 0 12.72M18.36 5.64a9 9 0 0 1 0 12.72'),
    ],
  },
  check: { filled: false, shapes: [p('m5 12.5 4.5 4.5L19 7')] },
  menu: {
    filled: false,
    shapes: [p('M4 7h16M4 12h16M4 17h16')],
  },
  monitor: {
    filled: false,
    shapes: [rr(3, 5, 18, 12, 1.5), p('M9 21h6m-3-4v4')],
  },
};

export type IconProps = {
  readonly name: IconName;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
  readonly strokeWidth?: number | undefined;
  readonly filled?: boolean | undefined;
  readonly className?: string | undefined;
};

export function Icon({
  name,
  size = 14,
  color,
  strokeWidth,
  filled,
  className,
}: IconProps) {
  const glyph = GLYPHS[name];
  const useFill = filled ?? glyph.filled;
  const paint = color ?? 'currentColor';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {glyph.shapes.map((shape, i) => {
        switch (shape.kind) {
          case 'path':
            return (
              <path
                key={i}
                d={shape.d}
                stroke={useFill ? 'none' : paint}
                strokeWidth={strokeWidth ?? 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={useFill ? paint : 'none'}
              />
            );
          case 'circle':
            return (
              <circle
                key={i}
                cx={shape.cx}
                cy={shape.cy}
                r={shape.r}
                stroke={useFill ? 'none' : paint}
                strokeWidth={strokeWidth ?? 2}
                fill={useFill ? paint : 'none'}
              />
            );
          case 'rect':
            return (
              <rect
                key={i}
                x={shape.x}
                y={shape.y}
                width={shape.w}
                height={shape.h}
                rx={shape.rx ?? 0}
                stroke={useFill ? 'none' : paint}
                strokeWidth={strokeWidth ?? 2}
                fill={useFill ? paint : 'none'}
              />
            );
        }
      })}
    </svg>
  );
}

// Chromium interpolates `d` between path() values with matching
// command lists — the play/pause quads keep identical shapes, so the
// morph runs as a pure CSS transition gated by reduced-motion.
export function PlayPauseIcon({
  playing,
  size = 18,
  color,
}: {
  readonly playing: boolean;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
}) {
  const paint = color ?? 'currentColor';
  const left = playing ? PAUSE_LEFT : PLAY_LEFT;
  const right = playing ? PAUSE_RIGHT : PLAY_RIGHT;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="uw-playpause"
    >
      <path className="uw-playpause__half" d={quadPath(left)} fill={paint} />
      <path className="uw-playpause__half" d={quadPath(right)} fill={paint} />
    </svg>
  );
}

export function HeartIcon({
  filled,
  size = 14,
  color,
}: {
  readonly filled: boolean;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
}) {
  return (
    <span
      className={`uw-heart${filled ? ' uw-heart--filled' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Icon name="heart" size={size} color={color} />
      <span className="uw-heart__fill">
        <Icon name="heart-filled" size={size} color={color} />
      </span>
    </span>
  );
}

export function Spinner({
  size = 16,
  color,
}: {
  readonly size?: number | undefined;
  readonly color?: string | undefined;
}) {
  return (
    <span
      className="uw-spinner"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Icon
        name="spinner"
        size={size}
        color={color ?? 'var(--accent)'}
        strokeWidth={2.5}
      />
    </span>
  );
}

const EQ_HEIGHTS = [0.45, 1, 0.65] as const;

export function EqBars({
  color,
  animated = true,
  size = 11,
}: {
  readonly color?: string | undefined;
  readonly animated?: boolean | undefined;
  readonly size?: number | undefined;
}) {
  const theme = useTheme();
  const run = animated && !theme.reducedMotion;
  return (
    <span
      className="uw-eq"
      style={{ height: size }}
      aria-hidden="true"
    >
      {EQ_HEIGHTS.map((h, i) => (
        <span
          key={i}
          className={`uw-eq__bar${run ? ' uw-eq__bar--run' : ''}`}
          style={{
            height: Math.max(2, h * size),
            backgroundColor: color ?? 'var(--accent)',
            animationDelay: `${i * 250}ms`,
          }}
        />
      ))}
    </span>
  );
}
