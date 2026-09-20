import { FlatList, ScrollView, View } from 'react-native';
import { useTheme } from './theme.tsx';
import { Artwork, Pressable, Text } from './primitives.tsx';
import { EmptyState } from './states.tsx';
import type { HomeModel, RailCardModel } from './view-models.ts';

export type HomeScreenProps = {
  readonly model: HomeModel;
  readonly topInset?: number | undefined;
  readonly scrollEnabled?: boolean | undefined;
  readonly onPressCard?: ((card: RailCardModel) => void) | undefined;
  readonly onPressSeeAll?: ((section: 'recents' | 'suggestions') => void) | undefined;
};

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
              style={{ paddingHorizontal: theme.spacing.xs }}
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
