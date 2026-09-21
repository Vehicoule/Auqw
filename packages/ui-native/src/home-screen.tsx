import { FlatList, ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, Icon, Pressable, Text } from './primitives.tsx';
import { EmptyState } from './states.tsx';
import { formatClock } from './view-models.ts';
import type { HomeModel, RailCardModel, ResumeModel } from './view-models.ts';

export type HomeScreenProps = {
  readonly model: HomeModel;
  readonly topInset?: number | undefined;
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
  const theme = useTheme();
  const fraction =
    resume.durationMs === null || resume.durationMs <= 0
      ? 0
      : Math.min(1, Math.max(0, resume.positionMs / resume.durationMs));
  return (
    <Pressable
      compact
      onPress={onResume}
      accessibilityLabel={`resume ${resume.card.title}, paused at ${formatClock(resume.positionMs)}`}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
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
          paused · continue
        </Text>
        <Text
          variant="body"
          color="primary"
          numberOfLines={1}
          style={{ marginTop: 2 }}
        >
          {resume.card.title}
        </Text>
        <View
          style={{
            height: 3,
            borderRadius: 2,
            backgroundColor: theme.colors.fg08,
            marginTop: theme.spacing.xs,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.round(fraction * 100)}%`,
              height: 3,
              borderRadius: 2,
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
  readonly section: 'recents' | 'suggestions';
  readonly cards: readonly RailCardModel[];
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'suggestions') => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: theme.spacing.xl }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          paddingHorizontal: theme.spacing.screen,
          marginBottom: theme.spacing.md,
        }}
      >
        <Text variant="heading" color="bright">
          {title}
        </Text>
        {subtitle !== null && (
          <Text variant="metadata" color="secondary" style={{ marginLeft: 10 }}>
            {subtitle}
          </Text>
        )}
        {onPressSeeAll !== undefined && (
          <>
            <View style={{ flex: 1 }} />
            <Pressable
              compact
              onPress={() => onPressSeeAll(section)}
              accessibilityLabel={`see all ${title}`}
              style={{
                paddingHorizontal: theme.spacing.md,
                minHeight: 26,
                justifyContent: 'center',
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.fg08,
              }}
            >
              <Text variant="metadata" color="secondary">
                see all
              </Text>
            </Pressable>
          </>
        )}
      </View>
      {cards.length === 0 ? (
        <EmptyState title="nothing here yet" icon="note" />
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
              onPress={
                onPressCard === undefined ? undefined : () => onPressCard(item)
              }
              accessibilityLabel={`${item.title}${
                item.subtitle === null ? '' : `, ${item.subtitle}`
              }`}
              style={{ width: 112 }}
            >
              <Artwork url={item.artworkUrl} size={112} />
              <Text
                variant="body"
                color="primary"
                numberOfLines={1}
                style={{ marginTop: theme.spacing.sm }}
              >
                {item.title}
              </Text>
              <Text
                variant="metadata"
                color="secondary"
                numberOfLines={1}
                style={{ marginTop: 2 }}
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
        paddingBottom: theme.spacing.xxl,
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
      <Rail
        title="jump back in"
        subtitle="pick up where you left off"
        section="recents"
        cards={model.recents}
        onPressCard={onPressCard}
        onPressSeeAll={onPressSeeAll}
      />
      <Rail
        title="suggested for you"
        subtitle="from your providers"
        section="suggestions"
        cards={model.suggestions}
        onPressCard={onPressCard}
        onPressSeeAll={onPressSeeAll}
      />
    </ScrollView>
  );
}
