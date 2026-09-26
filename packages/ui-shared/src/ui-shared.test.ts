// Smoke coverage for the shared view-model layer. The deep mapper and
// fixture invariants live in packages/ui-native/src/ui-native.test.ts —
// they now exercise this module through '@auqw/ui-shared'. Here we only
// prove the package resolves cleanly for a plain node consumer: the
// mappers import nothing react-native and fixtures stay coherent.
import {
  formatAgo,
  getLocale,
  languageOptionKey,
  resolveLocale,
  setLocale,
  t,
  toHomeModel,
  toQueueModel,
  toSettingsModel,
  toSyncPanel,
} from './index.ts';
import type { Locale, MessageId } from './index.ts';
import {
  ringTrackDash,
  shimmerHighlight,
  staggerProgress,
  waveAmplitudeFor,
  waveformAmplitudes,
  waveformBarExtent,
  waveformBarLayout,
} from './waveform.ts';
import { en } from './locales/en.ts';
import { de } from './locales/de.ts';
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

// ---- sync panel ------------------------------------------------------------
const NOW = 1_800_000_000_000;

assertEqual(formatAgo(NOW - 5_000, NOW), 'just now');
assertEqual(formatAgo(NOW - 5 * 60_000, NOW), '5m ago');
assertEqual(formatAgo(NOW - 3 * 3_600_000, NOW), '3h ago');
assertEqual(formatAgo(NOW - 4 * 86_400_000, NOW), '4d ago');
assertEqual(formatAgo(NOW - 40 * 86_400_000, NOW).length, 10, 'weeks+ → ISO date');
assertEqual(formatAgo(NOW + 1_000, NOW), '—', 'future is honest');
assertEqual(formatAgo(NaN, NOW), '—', 'non-finite is honest');

const syncPanel = toSyncPanel(
  {
    listener: 'listening',
    endpoint: '192.168.1.20:44100',
    boundPort: 44100,
    advertise: 'announcing',
    pairedDevices: 1,
    sessions: 2,
    lastSyncAt: NOW - 5 * 60_000,
    engine: 'ready',
    name: 'desk',
    fingerprint: 'ab:cd:ef',
  },
  [
    {
      id: 'dev-phone',
      name: 'pixel',
      pairedAt: NOW - 3 * 3_600_000,
      lastSeenAt: NOW - 5_000,
    },
  ],
  { payload: '{"v":1,"code":"123456"}', code: '123456', endpoint: '192.168.1.20:48715', expiresAt: NOW + 4 * 60_000 },
  NOW,
);
const syncStatus = syncPanel.status;
assert(syncStatus !== null, 'status maps through');
assertEqual(syncStatus.listenerLabel, 'listening');
assertEqual(syncStatus.engineLabel, 'ready');
assertEqual(syncStatus.addressLabel, '192.168.1.20:44100');
assertEqual(syncStatus.lastSyncLabel, '5m ago');
assertEqual(syncStatus.sessionsLabel, '2 live');
assertEqual(syncStatus.fingerprintLabel, 'ab:cd:ef');
assertEqual(syncPanel.devices.length, 1);
assertEqual(syncPanel.devices[0]?.pairedLabel, 'paired 3h ago');
assertEqual(syncPanel.devices[0]?.lastSeenLabel, 'seen just now');
assertEqual(syncPanel.pairing?.code, '123456');
assertEqual(syncPanel.pairing?.expiresLabel, 'expires in 4m');

const noSync = toSyncPanel(null, [], null, NOW);
assertEqual(noSync.status, null, 'a dead channel maps to a null status');
assertEqual(noSync.devices.length, 0);
assertEqual(noSync.pairing, null);

const expiredPairing = toSyncPanel(
  null,
  [],
  { payload: 'x', code: '000000', endpoint: '10.0.0.2:48715', expiresAt: NOW - 1 },
  NOW,
);
assertEqual(expiredPairing.pairing?.expiresLabel, 'expired');

// ---- i18n engine ----------------------------------------------------------

// interpolation
assertEqual(t('home.seeAllA11y', { title: 'jump back in' }), 'see all jump back in');
assertEqual(t('ago.minutes', { count: 5 }), '5m ago');
assertEqual(
  t('home.seeAllA11y'),
  'see all {title}',
  'a missing param leaves its placeholder rather than rendering undefined',
);
assertEqual(
  typeof t('state.loading'),
  'string',
  't() always returns a string',
);

// plural selection: English has one/other; German 0 uses `other`
assertEqual(t('collection.plays', { count: 1 }), '1 play');
assertEqual(t('collection.plays', { count: 4 }), '4 plays');
assertEqual(t('collection.plays', { count: 0 }), '0 plays');
setLocale('de');
assertEqual(t('collection.plays', { count: 1 }), '1 wiedergabe');
assertEqual(
  t('collection.plays', { count: 0 }),
  '0 wiedergaben',
  'German puts 0 in `other`, not `one`',
);
assertEqual(t('collection.plays', { count: 2 }), '2 wiedergaben');
assertEqual(t('state.loading'), 'wird geladen');

// fallback to en for a missing catalog / unknown id — never `undefined`
setLocale('fr' as unknown as Locale);
assertEqual(getLocale(), 'fr' as unknown as Locale);
assertEqual(
  t('state.loading'),
  'loading',
  'a locale without a catalog falls back to en',
);
assertEqual(
  t('definitely.missing' as MessageId),
  'definitely.missing',
  'an id unknown even to en degrades to the id itself, never undefined',
);
setLocale('en');
assertEqual(t('state.loading'), 'loading');

// resolveLocale: setting wins when supported, else systemTag, else 'en'
assertEqual(resolveLocale(undefined, 'de-DE'), 'de', 'absent follows the system');
assertEqual(resolveLocale(null, 'en-US'), 'en');
assertEqual(resolveLocale('system', 'de-DE'), 'de', "'system' follows the system");
assertEqual(resolveLocale('de', 'en-US'), 'de', 'a supported tag pins the UI');
assertEqual(resolveLocale('de-DE', 'en-US'), 'de', 'BCP-47 pins by primary subtag');
assertEqual(resolveLocale('fr', 'en-US'), 'en', 'unsupported tag falls back to en');
assertEqual(resolveLocale('fr', 'de-DE'), 'de', 'unsupported setting follows the system');
assertEqual(resolveLocale('system', 'fr-FR'), 'en', 'unsupported system defaults to en');

// languageOptionKey: the picker's displayed key must agree with what
// resolveLocale activates — a padded stored tag pins 'de', not 'system'
assertEqual(languageOptionKey(undefined), 'system');
assertEqual(languageOptionKey('de-DE'), 'de', 'BCP-47 reduces to primary subtag');
assertEqual(languageOptionKey(' de '), 'de', 'padding still selects the pinned locale');
assertEqual(languageOptionKey('fr'), 'system', 'unsupported reads as system');

// completeness guard: en and de carry the same message ids
const enIds = Object.keys(en);
const deIds = new Set(Object.keys(de));
for (const id of enIds) {
  assert(deIds.has(id), `de is missing the message id ${id}`);
  assert(
    de[id as MessageId] !== undefined,
    `de has no message for ${id}`,
  );
}
assertEqual(
  deIds.size,
  enIds.length,
  'de must not carry ids en does not know',
);

// waveformAmplitudes: deterministic per seed, every bar in [0.12, 1]
const amps = waveformAmplitudes('track-a', 60);
assertEqual(amps.length, 60);
assert(
  amps.every((v) => v >= 0.12 && v <= 1),
  'every amplitude stays inside [0.12, 1]',
);
assertEqual(
  JSON.stringify(amps),
  JSON.stringify(waveformAmplitudes('track-a', 60)),
  'same seed and count is deterministic',
);
assert(
  JSON.stringify(amps) !== JSON.stringify(waveformAmplitudes('track-b', 60)),
  'a different seed produces a different pattern',
);
assertEqual(waveformAmplitudes('track-a', 0).length, 0, 'count 0 yields no bars');
assertEqual(
  waveformAmplitudes('track-a', -3).length,
  0,
  'negative count yields no bars',
);
assert(
  new Set(amps).size > 10,
  'the pattern actually varies bar to bar',
);

// waveformBarLayout: count from width, bars centered
const layout = waveformBarLayout(200);
assert(layout.count > 0, 'a real width fits bars');
assertEqual(
  layout.count,
  Math.floor((200 - 2.5) / (3 + 2.5)),
  'count follows the barWidth+gap budget',
);
assertEqual(layout.xs.length, layout.count, 'one center per bar');
const expectedLeftover = 200 - (layout.count * (3 + 2.5) - 2.5);
assertEqual(
  layout.xs[0],
  expectedLeftover / 2 + 1.5,
  'first bar centers in the leftover margin',
);
const symmetric = 200 - ((layout.xs[layout.count - 1] ?? 0) + 1.5);
assert(
  Math.abs(symmetric - expectedLeftover / 2) < 1e-9,
  'bars are centered within the measured width',
);
assertEqual(waveformBarLayout(2).count, 0, 'width at the gap fits nothing');
assertEqual(waveformBarLayout(0).count, 0, 'zero width fits nothing');

// waveformBarExtent: eased bloom between the floor and the max
assertEqual(waveformBarExtent(0, 20), 2.4, 'zero amplitude keeps the floor');
assertEqual(waveformBarExtent(1, 20, 2.4, 1), 20, 'full amplitude reaches max');
assert(
  waveformBarExtent(0.5, 20) > 2.4 && waveformBarExtent(0.5, 20) < 20,
  'mid amplitude lands between floor and max',
);
assertEqual(
  waveformBarExtent(1, 20, 2.4, 0),
  2.4,
  'zero bloom collapses to the floor',
);
assertEqual(
  waveformBarExtent(1, 20, 2.4, Number.NaN),
  2.4,
  'non-finite bloom falls back to the floor',
);

// staggerProgress: delayed sweep that always completes
assertEqual(staggerProgress(1, 0, 10), 1, 'finished progress is done');
assertEqual(staggerProgress(0, 9, 10), 0, 'the tail has not started at 0');
assert(
  staggerProgress(0.5, 1, 10) > staggerProgress(0.5, 8, 10),
  'earlier bars lead the sweep',
);
assertEqual(staggerProgress(0, 0, 0), 1, 'empty count is complete');

// shimmerHighlight: wraps around the ends of the phase cycle
assertEqual(shimmerHighlight(0.5, 0.5), 1, 'aligned phase is fully lit');
assertEqual(shimmerHighlight(0, 0.5), 0, 'a half cycle away is dark');
assert(
  shimmerHighlight(0.02, 0.98) > 0.7,
  'the band wraps across the 1→0 boundary',
);

// ringTrackDash: the unplayed track starts after the indicator head
const gapDash = ringTrackDash(0.5, 200, 4);
assertEqual(gapDash.dashArray, '92 200', 'track runs head+gap to end-gap');
assertEqual(gapDash.dashOffset, -104, 'dash start sits past the wave head');
assert(gapDash.visible, 'mid progress leaves visible track');
const startDash = ringTrackDash(0, 200, 4);
assertEqual(startDash.dashOffset, -4, 'progress 0 still leaves the head gap');
assertEqual(startDash.dashArray, '192 200');
const endDash = ringTrackDash(1, 200, 4);
assertEqual(endDash.visible, false, 'no track remains past full progress');
assertEqual(endDash.dashOffset, -204, 'offset still reports the head+gap start');

// waveAmplitudeFor: blooms while playing, flat paused, eased at the ends
assertEqual(waveAmplitudeFor(0.5, false), 0, 'paused is flat');
assertEqual(waveAmplitudeFor(0.5, true), 1, 'mid-track playing is full bloom');
assert(
  Math.abs(waveAmplitudeFor(0.07, true) - 0.5) < 1e-9,
  'entry ramp midpoint',
);
assertEqual(waveAmplitudeFor(0.04, true), 0, 'ramp starts flat');
assert(
  Math.abs(waveAmplitudeFor(0.95, true) - 0.5) < 1e-9,
  'exit ramp midpoint',
);
assertEqual(waveAmplitudeFor(0.98, true), 0, 'ramp ends flat');

console.log('ui-shared tests passed');
