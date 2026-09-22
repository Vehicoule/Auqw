// Smoke coverage for the shared view-model layer. The deep mapper and
// fixture invariants live in packages/ui-native/src/ui-native.test.ts —
// they now exercise this module through '@auqw/ui-shared'. Here we only
// prove the package resolves cleanly for a plain node consumer: the
// mappers import nothing react-native and fixtures stay coherent.
import { toHomeModel, toQueueModel, toSettingsModel } from './index.ts';
import {
  fixtureDiagnostics,
  fixtureHomeModel,
  fixtureLikes,
  fixtureQueue,
  fixtureQueueModel,
  fixtureRecordings,
  fixtureSearchResults,
  fixtureSettings,
  fixtureSettingsModel,
} from './fixtures.ts';

function assert(
  condition: unknown,
  message = 'assertion failed',
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ??
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const home = toHomeModel({
  recordings: fixtureRecordings,
  likes: fixtureLikes,
  playback: { type: 'idle' },
  suggestions: fixtureSearchResults,
  greeting: 'good evening',
  subline: '3 liked',
});
assertEqual(home.greeting, 'good evening');
assertEqual(home.resume, null, 'idle playback yields no resume card');
assert(
  home.recents.every((card) => card.title === card.title.trim()),
  'recents map through the shared package',
);
assertEqual(
  home.suggestions.length,
  Math.min(12, fixtureSearchResults.length),
  'suggestions map 1:1 through the shared package',
);
assert(fixtureHomeModel.recents.length > 0, 'fixture rail cards exist');

const queue = toQueueModel({
  queue: fixtureQueue,
  recordings: fixtureRecordings,
  likes: fixtureLikes,
});
assertEqual(queue.items.length, fixtureQueueModel.items.length);
assert(
  queue.items.some((item) => item.current),
  'queue keeps its current marker through the shared mapper',
);

const settings = toSettingsModel(fixtureSettings, fixtureDiagnostics, {});
assertEqual(settings.rows.length, fixtureSettingsModel.rows.length);

console.log('ui-shared tests passed');
