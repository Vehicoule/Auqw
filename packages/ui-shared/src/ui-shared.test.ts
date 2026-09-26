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
import { en } from './locales/en.ts';
import { de } from './locales/de.ts';
import { es } from './locales/es.ts';
import { fr } from './locales/fr.ts';
import { zh } from './locales/zh.ts';
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
setLocale('ja' as unknown as Locale);
assertEqual(getLocale(), 'ja' as unknown as Locale);
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
assertEqual(resolveLocale('ja', 'en-US'), 'en', 'unsupported tag falls back to en');
assertEqual(resolveLocale('ja', 'de-DE'), 'de', 'unsupported setting follows the system');
assertEqual(resolveLocale('system', 'ja-JP'), 'en', 'unsupported system defaults to en');
assertEqual(resolveLocale('fr-FR', 'en-US'), 'fr', 'supported non-base tag pins the UI');
assertEqual(resolveLocale('es-419', 'en-US'), 'es', 'es region tag pins');
assertEqual(resolveLocale('zh-Hans-CN', 'en-US'), 'zh', 'zh primary subtag pins');
// only Simplified ships — Traditional-script/region tags fall back to the default
assertEqual(resolveLocale('zh-Hant-TW', 'en-US'), 'en', 'zh-Hant falls back');
assertEqual(resolveLocale('zh-TW', 'en-US'), 'en', 'zh-TW falls back');
assertEqual(resolveLocale('zh-HK', 'en-US'), 'en', 'zh-HK falls back');
assertEqual(resolveLocale('zh-MO', 'en-US'), 'en', 'zh-MO falls back');
assertEqual(resolveLocale('zh-CN', 'en-US'), 'zh', 'zh-CN stays Simplified');
assertEqual(languageOptionKey('zh-Hant-TW'), 'system', 'Traditional reads as system');

// languageOptionKey: the picker's displayed key must agree with what
// resolveLocale activates — a padded stored tag pins 'de', not 'system'
assertEqual(languageOptionKey(undefined), 'system');
assertEqual(languageOptionKey('de-DE'), 'de', 'BCP-47 reduces to primary subtag');
assertEqual(languageOptionKey(' de '), 'de', 'padding still selects the pinned locale');
assertEqual(languageOptionKey('fr'), 'fr', 'supported primary subtag selects');
assertEqual(languageOptionKey('ja'), 'system', 'unsupported reads as system');

// completeness guard: every shipped catalog carries the same message ids as en
const enIds = Object.keys(en);
for (const [tag, catalog] of Object.entries({ de, es, fr, zh })) {
  const ids = new Set(Object.keys(catalog));
  for (const id of enIds) {
    assert(ids.has(id), `${tag} is missing the message id ${id}`);
    assert(
      catalog[id as MessageId] !== undefined,
      `${tag} has no message for ${id}`,
    );
  }
  assertEqual(
    ids.size,
    enIds.length,
    `${tag} must not carry ids en does not know`,
  );
}

// per-locale behavior: plurals route through CLDR categories and
// placeholders interpolate — a spot-check per shipped catalog
setLocale('es');
assertEqual(t('common.trackCount', { count: 1 }), '1 pista', 'es one');
assertEqual(t('common.trackCount', { count: 3 }), '3 pistas', 'es other');
assertEqual(
  t('common.cardA11y', { title: 'a', subtitle: 'b' }),
  'a, b',
  'es interpolates',
);
setLocale('fr');
assertEqual(t('common.trackCount', { count: 0 }), '0 titre', 'fr zero is one');
assertEqual(t('common.trackCount', { count: 1 }), '1 titre', 'fr one');
assertEqual(t('common.trackCount', { count: 2 }), '2 titres', 'fr other');
assertEqual(
  t('common.cardA11y', { title: 'a', subtitle: 'b' }),
  'a, b',
  'fr interpolates',
);
setLocale('zh');
assertEqual(t('common.trackCount', { count: 1 }), '1 首', 'zh ignores number');
assertEqual(t('common.trackCount', { count: 5 }), '5 首', 'zh other');
assertEqual(
  t('common.cardA11y', { title: 'a', subtitle: 'b' }),
  'a，b',
  'zh interpolates',
);
setLocale('en');

console.log('ui-shared tests passed');
