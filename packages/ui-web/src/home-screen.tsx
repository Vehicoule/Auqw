import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import { bindTo } from './track-row.tsx';
import { progressOf } from './progress.tsx';
import { CollectionTile } from './collection-screen.tsx';
import { formatClock, t } from '@auqw/ui-shared';
import { collectionTileViews } from '@auqw/ui-shared/controllers';
import type { CollectionKey, HomeModel, RailCardModel, ResumeModel } from '@auqw/ui-shared';

export type HomeScreenProps = {
  readonly model: HomeModel;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'played' | 'suggestions') => void) | undefined;
  readonly onOpenCollection?: ((key: CollectionKey) => void) | undefined;
  readonly onPlayCollection?: ((key: CollectionKey) => void) | undefined;
  readonly onResume?: (() => void) | undefined;
};

function ResumeCard({
  resume,
  onResume,
}: {
  readonly resume: ResumeModel;
  readonly onResume?: (() => void) | undefined;
}) {
  const fraction = progressOf(resume.positionMs, resume.durationMs);
  return (
    <Pressable
      onPress={onResume}
      ariaLabel={t('home.resumeA11y', {
        title: resume.card.title,
        position: formatClock(resume.positionMs),
      })}
      className="uw-resume"
    >
      <Artwork url={resume.card.artworkUrl} size={44} />
      <span className="uw-resume__body">
        <Text variant="label" color="accent" uppercase>
          {t('home.resumeLabel')}
        </Text>
        <Text variant="body" color="primary" numberOfLines={1}>
          {resume.card.title}
        </Text>
        <span className="uw-resume__bar">
          <span
            className="uw-resume__fill"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
      </span>
      <Icon name="play" size={15} color="var(--accent)" />
    </Pressable>
  );
}

const RAIL_EMPTY_ICON = {
  recents: 'clock',
  played: 'clock',
  suggestions: 'compass',
} as const;

function Rail({
  title,
  subtitle,
  section,
  cards,
  onPressCard,
  onPressSeeAll,
}: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly section: 'recents' | 'played' | 'suggestions';
  readonly cards: readonly RailCardModel[];
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'played' | 'suggestions') => void) | undefined;
}) {
  return (
    <section className="uw-rail" aria-label={title}>
      <div className="uw-rail__head">
        <Text variant="heading" color="bright">
          {title}
        </Text>
        {subtitle !== null && (
          <Text variant="metadata" color="secondary" className="uw-rail__sub">
            {subtitle}
          </Text>
        )}
        {onPressSeeAll !== undefined && (
          <Pressable
            onPress={() => onPressSeeAll(section)}
            ariaLabel={t('home.seeAllA11y', { title })}
            className="uw-rail__see-all"
          >
            <Text variant="metadata" color="secondary">
              {t('home.seeAll')}
            </Text>
          </Pressable>
        )}
      </div>
      {cards.length === 0 ? (
        <div className="uw-rail__empty">
          <Icon
            name={RAIL_EMPTY_ICON[section]}
            size={14}
            color="var(--fg25)"
          />
          <Text variant="metadata" color="secondary">
            {t('home.empty')}
          </Text>
        </div>
      ) : (
        <div className="uw-rail__cards" role="list">
          {cards.map((card) => (
            <Pressable
              key={card.key}
              onPress={bindTo(onPressCard, card)}
              ariaLabel={
                card.subtitle === null
                  ? card.title
                  : t('common.cardA11y', {
                      title: card.title,
                      subtitle: card.subtitle,
                    })
              }
              className="uw-rail__card"
            >
              <Artwork url={card.artworkUrl} size={136} />
              <Text variant="body" color="primary" numberOfLines={2}>
                {card.title}
              </Text>
              <Text variant="metadata" color="secondary" numberOfLines={1}>
                {card.subtitle ?? '—'}
              </Text>
            </Pressable>
          ))}
        </div>
      )}
    </section>
  );
}

export function HomeScreen({
  model,
  scrollEnabled = true,
  onPressCard,
  onPressSeeAll,
  onOpenCollection,
  onPlayCollection,
  onResume,
}: HomeScreenProps) {
  const tiles = collectionTileViews(
    model.collections,
    onOpenCollection,
    onPlayCollection,
  );
  return (
    <div
      className="uw-screen uw-home"
      data-scroll={scrollEnabled ? 'true' : 'false'}
    >
      <Text variant="display" color="bright">
        {model.greeting}
      </Text>
      {model.subline !== null && (
        <Text variant="metadata" color="secondary" className="uw-home__subline">
          {model.subline}
        </Text>
      )}
      {model.resume !== null && (
        <ResumeCard resume={model.resume} onResume={onResume} />
      )}
      <div className="uw-collections uw-home__tiles" role="list">
        {tiles.map((tile) => (
          <div
            key={tile.tile.key}
            role="listitem"
            className="uw-collections__cell"
          >
            <CollectionTile view={tile} />
          </div>
        ))}
      </div>
      {model.played.length > 0 && (
        <Rail
          title={t('home.played.title')}
          subtitle={t('home.played.subtitle')}
          section="played"
          cards={model.played}
          onPressCard={onPressCard}
          onPressSeeAll={onPressSeeAll}
        />
      )}
      <Rail
        title={t('home.recents.title')}
        subtitle={t('home.recents.subtitle')}
        section="recents"
        cards={model.recents}
        onPressCard={onPressCard}
        onPressSeeAll={onPressSeeAll}
      />
      <Rail
        title={t('home.suggestions.title')}
        subtitle={t('home.suggestions.subtitle')}
        section="suggestions"
        cards={model.suggestions}
        onPressCard={onPressCard}
        onPressSeeAll={onPressSeeAll}
      />
    </div>
  );
}
