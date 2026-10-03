import { FlatList, View } from 'react-native';
import { useStableRows } from '@auqw/ui-shared';
import { useTheme } from './theme.tsx';
import { Artwork, IconButton, Pressable, Text } from './primitives.tsx';
import type {
  EntityCardView,
  EntityRailView,
} from '@auqw/ui-shared/controllers';

/**
 * A horizontal rail of typed entity cards (artist/album/playlist
 * hits, discography, related artists) — the search + entity screens
 * share it. The card body opens the entity page; the like heart is
 * an absolute sibling overlaid on the artwork's top-right corner.
 */
export function EntityRail({ rail }: { readonly rail: EntityRailView }) {
  const theme = useTheme();
  // Controllers re-map card views every render — serving the previous
  // array while the wrapped card models are unchanged keeps the
  // list's `data` identical between playback ticks (fresh refs re-arm
  // VirtualizedList's batched cell-update setState — the update-depth
  // storm chain).
  const cards = useStableRows(rail.cards, (view) => view.card);
  return (
    <View style={{ marginTop: theme.spacing.xl }}>
      <Text
        variant="heading"
        color="bright"
        style={{
          paddingHorizontal: theme.spacing.screen,
          marginBottom: theme.spacing.md,
        }}
      >
        {rail.title}
      </Text>
      <FlatList
        horizontal
        data={cards}
        keyExtractor={(card) => card.card.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.screen,
          gap: theme.spacing.lg,
        }}
        renderItem={({ item }) => <EntityCard card={item} />}
      />
    </View>
  );
}

function EntityCard({ card }: { readonly card: EntityCardView }) {
  const theme = useTheme();
  return (
    <View style={{ width: 112 }}>
      <Pressable
        compact
        onPress={card.onPress}
        accessibilityLabel={card.a11yLabel}
      >
        <Artwork
          url={card.card.artworkUrl}
          size={112}
          cornerRadius={card.card.kind === 'artist' ? 56 : undefined}
        />
        <Text
          variant="body"
          color="primary"
          numberOfLines={2}
          style={{
            minHeight: theme.typography.body.lineHeight * 2,
            marginTop: theme.spacing.xs,
          }}
        >
          {card.card.title}
        </Text>
        <Text variant="metadata" color="secondary" numberOfLines={1}>
          {card.card.subtitle ?? card.kindLabel}
        </Text>
      </Pressable>
      {card.onToggleLike !== undefined && (
        <IconButton
          icon={card.card.liked ? 'heart-filled' : 'heart'}
          size={28}
          iconSize={13}
          color={card.card.liked ? theme.colors.liked : undefined}
          accessibilityLabel={card.likeA11yLabel}
          onPress={card.onToggleLike}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            backgroundColor: theme.colors.fg08,
            borderRadius: theme.radius.pill,
          }}
        />
      )}
    </View>
  );
}
