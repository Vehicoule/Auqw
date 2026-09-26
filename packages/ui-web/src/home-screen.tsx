import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import { EmptyState } from './states.tsx';
import { formatClock, t } from '@auqw/ui-shared';
import type { HomeModel, RailCardModel, ResumeModel } from '@auqw/ui-shared';

export type HomeScreenProps = {
  readonly model: HomeModel;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'suggestions') => void) | undefined;
  readonly onResume?: (() => void) | undefined;
};

function ResumeCard({
  resume,
  onResume,
}: {
  readonly resume: ResumeModel;
  readonly onResume?: (() => void) | undefined;
}) {
  const fraction =
    resume.durationMs === null || resume.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, resume.positionMs / resume.durationMs));
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
  readonly section: 'recents' | 'suggestions';
  readonly cards: readonly RailCardModel[];
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'suggestions') => void) | undefined;
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
        <EmptyState title={t('home.empty')} icon="note" />
      ) : (
        <div className="uw-rail__cards" role="list">
          {cards.map((card) => (
            <Pressable
              key={card.key}
              onPress={
                onPressCard === undefined ? undefined : () => onPressCard(card)
              }
              ariaLabel={
              card.subtitle === null
                ? card.title
                : t('common.cardA11y', { title: card.title, subtitle: card.subtitle })
            }
              className="uw-rail__card"
            >
              <Artwork url={card.artworkUrl} size={136} />
              <Text variant="body" color="primary" numberOfLines={1}>
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
  onResume,
}: HomeScreenProps) {
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
