import {
  Artwork,
  IconButton,
  Pressable,
  Text,
} from './primitives.tsx';
import type { EntityRailView } from '@auqw/ui-shared/controllers';

/**
 * A horizontal rail of typed entity cards (artist/album/playlist
 * hits, discography, related artists) — the search + entity screens
 * share it. The card body is a pressable that opens the entity page;
 * the like heart sits as an absolute sibling (buttons can't nest).
 */
export function EntityRail({ rail }: { readonly rail: EntityRailView }) {
  return (
    <section className="uw-rail" aria-label={rail.title}>
      <div className="uw-rail__head">
        <Text variant="heading" color="bright">
          {rail.title}
        </Text>
      </div>
      <div className="uw-rail__cards" role="list">
        {rail.cards.map((card) => (
          <div className="uw-ecard" key={card.card.key}>
            <Pressable
              onPress={card.onPress}
              ariaLabel={card.a11yLabel}
              className="uw-rail__card"
            >
              <Artwork
                url={card.card.artworkUrl}
                size={136}
                cornerRadius={card.card.kind === 'artist' ? 68 : undefined}
              />
              <Text variant="body" color="primary" numberOfLines={2}>
                {card.card.title}
              </Text>
              <Text variant="metadata" color="secondary" numberOfLines={1}>
                {card.card.subtitle ?? card.kindLabel}
              </Text>
            </Pressable>
            {card.onToggleLike !== undefined && (
              <IconButton
                icon={card.card.liked ? 'heart-filled' : 'heart'}
                size={26}
                iconSize={13}
                color={card.card.liked ? 'var(--liked)' : undefined}
                ariaLabel={card.likeA11yLabel}
                onPress={card.onToggleLike}
                className="uw-ecard__like"
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
