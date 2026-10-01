import { FlatList, ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, bind, Icon, PillButton, Pressable, Text } from './primitives.tsx';
import { EmptyState } from './states.tsx';
import { formatClock, t } from '@auqw/ui-shared';
import type { HomeModel, RailCardModel, ResumeModel } from '@auqw/ui-shared';

export type HomeScreenProps = {
  readonly model: HomeModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'played' | 'suggestions') => void) | undefined;
  readonly onResume?: (() => void) | undefined;
};

function ResumeCard({
  resume,
  onResume,
}: {
  readonly resume: ResumeModel;
  readonly onResume?: (() => void) | undefined;
}) {
  const theme = useTheme();
  const fraction =
    resume.durationMs === null || resume.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, resume.positionMs / resume.durationMs));
  return (
    <Pressable
      compact
      onPress={onResume}
      accessibilityLabel={t('home.resumeA11y', {
        title: resume.card.title,
        position: formatClock(resume.positionMs),
      })}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          marginHorizontal: theme.spacing.screen,
          marginTop: theme.spacing.lg,
          padding: theme.spacing.sm,
          borderRadius: theme.radius.float,
          borderWidth: theme.strokes.hairline,
          borderColor: theme.colors.hairline,
          backgroundColor: theme.colors.raised,
        },
        pressed && { backgroundColor: theme.colors.fg08 },
      ]}
    >
      <Artwork url={resume.card.artworkUrl} size={44} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="label" color="accent" uppercase>
          {t('home.resumeLabel')}
        </Text>
        <Text
          variant="body"
          color="primary"
          numberOfLines={1}
          style={{ marginTop: theme.spacing.xxs }}
        >
          {resume.card.title}
        </Text>
        <View
          style={{
            height: 3,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.fg08,
            marginTop: theme.spacing.xs,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.round(fraction * 100)}%`,
              height: 3,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.accent,
            }}
          />
        </View>
      </View>
      <Icon name="play" size={15} color={theme.colors.accent} />
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
  readonly section: 'recents' | 'played' | 'suggestions';
  readonly cards: readonly RailCardModel[];
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'played' | 'suggestions') => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: theme.spacing.xl }}>
      <View
        style={{
          paddingHorizontal: theme.spacing.screen,
          marginBottom: theme.spacing.md,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.sm,
          }}
        >
          <Text variant="heading" color="bright">
            {title}
          </Text>
          {onPressSeeAll !== undefined && (
            <PillButton
              label={t('home.seeAll')}
              minHeight={26}
              onPress={bind(onPressSeeAll, section)}
              accessibilityLabel={t('home.seeAllA11y', { title })}
            />
          )}
        </View>
        {subtitle !== null && (
          <Text
            variant="metadata"
            color="secondary"
            style={{ marginTop: theme.spacing.xxs }}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {cards.length === 0 ? (
        <EmptyState title={t('home.empty')} icon="note" />
      ) : (
        <FlatList
          horizontal
          data={cards}
          keyExtractor={(card) => card.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.screen,
            gap: theme.spacing.lg,
          }}
          renderItem={({ item }) => (
            <Pressable
              compact
              onPress={bind(onPressCard, item)}
              accessibilityLabel={
                item.subtitle === null
                  ? item.title
                  : t('common.cardA11y', {
                      title: item.title,
                      subtitle: item.subtitle,
                    })
              }
              style={{ width: 112 }}
            >
              <Artwork url={item.artworkUrl} size={112} />
              <Text
                variant="body"
                color="primary"
                numberOfLines={2}
                style={{
                  marginTop: theme.spacing.sm,
                  minHeight: theme.typography.body.lineHeight * theme.textScale * 2,
                }}
              >
                {item.title}
              </Text>
              <Text
                variant="metadata"
                color="secondary"
                numberOfLines={1}
                style={{ marginTop: theme.spacing.xxs }}
              >
                {item.subtitle ?? '—'}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

export function HomeScreen({
  model,
  topInset = 0,
  scrollEnabled = true,
  onPressCard,
  onPressSeeAll,
  onResume,
}: HomeScreenProps) {
  const theme = useTheme();
  return (
    <ScrollView
      scrollEnabled={scrollEnabled}
      style={{ flex: 1, backgroundColor: theme.colors.canvas }}
      contentContainerStyle={{
        paddingTop: topInset + theme.spacing.sm,
        // The floating miniplayer overlays the last rows — the extra
        // strip lets them scroll clear of the pill.
        paddingBottom:
          theme.spacing.xxl + theme.sizes.miniPlayer + theme.spacing.md,
      }}
    >
      <Text
        variant="display"
        color="bright"
        style={{ paddingHorizontal: theme.spacing.screen }}
      >
        {model.greeting}
      </Text>
      {model.subline !== null && (
        <Text
          variant="metadata"
          color="secondary"
          style={{
            paddingHorizontal: theme.spacing.screen,
            marginTop: theme.spacing.xs + 1,
          }}
        >
          {model.subline}
        </Text>
      )}
      {model.resume !== null && (
        <ResumeCard resume={model.resume} onResume={onResume} />
      )}
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
    </ScrollView>
  );
}
