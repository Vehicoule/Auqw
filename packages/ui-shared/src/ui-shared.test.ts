// Smoke coverage for the shared view-model layer. The deep mapper and
// fixture invariants live in packages/ui-native/src/ui-native.test.ts —
// they now exercise this module through '@auqw/ui-shared'. Here we only
// prove the package resolves cleanly for a plain node consumer: the
// mappers import nothing react-native and fixtures stay coherent.
import { assert, assertEqual } from '@auqw/application/testing';
import {
  formatAgo,
  getLocale,
  languageOptionKey,
  resolveLocale,
  setLocale,
  settingsGroups,
  t,
  toHomeModel,
  toQueueModel,
  toSettingsModel,
  toSyncPanel,
} from './index.ts';
import type { Locale, MessageId } from './index.ts';
import {
  shimmerHighlight,
  staggerProgress,
  waveformBarExtent,
  waveformBarLayout,
  waveformPeaks,
} from './waveform.ts';
import {
  PEAKS_RESOLUTION,
  normalizePeakWindows,
  peaksFromChannels,
  resamplePeaks,
} from './peaks.ts';
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

// ---- settings groups --------------------------------------------------
const settingsGrouped = toSettingsModel(fixtureSettings, fixtureDiagnostics, {
  localSources: [{ sourceId: 'src-a', label: 'Music' }],
});
const groups = settingsGroups(settingsGrouped.rows);
assertEqual(groups.length, 6, 'six labeled groups');
assertEqual(
  groups.map((g) => g.key).join(','),
  'theme,catalogProvider,qualityKbps,downloadMetered,localSources,sync',
  'group boundaries land on their keys',
);
assertEqual(
  groups.flatMap((g) => g.rows.map((r) => r.key)).join(','),
  settingsGrouped.rows.map((r) => r.key).join(','),
  'groups preserve every row in order',
);
assertEqual(groups[0]?.label, 'appearance', 'labels resolve');
const localGroup = groups.find((g) => g.key === 'localSources');
assert(
  localGroup?.rows.some(
    (r) => r.key === 'localSourceRemove:src-a' && r.destructive === true,
  ) === true,
  'local-source removal lands in local files, marked destructive',
);
assert(
  settingsGrouped.rows.find((r) => r.key === 'removeAllDownloads')
    ?.destructive === true,
  'remove-all-downloads marked destructive',
);

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
// explicit Hans script beats a Traditional-leaning region
assertEqual(resolveLocale('zh-Hans-HK', 'en-US'), 'zh', 'zh-Hans-HK pins zh');
assertEqual(resolveLocale('zh-Hans-TW', 'en-US'), 'zh', 'zh-Hans-TW pins zh');
assertEqual(
  resolveLocale('zh-Hant-TW-x-hans', 'en-US'),
  'en',
  'private-use hans is not a script',
);
assertEqual(languageOptionKey('zh-Hant-TW'), 'system', 'Traditional reads as system');
assertEqual(languageOptionKey('zh-Hans-HK'), 'zh', 'explicit Hans selects');

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
  t('sync.status.connectedCount', { count: 1 }),
  '1 conectado',
  'es sync count agrees in number',
);
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
  t('sync.status.pairedCount', { count: 1 }),
  '1 appairé',
  'fr sync count agrees in number',
);
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

// waveformPeaks: deterministic per seed, every arm inside its clamp.
const bars = waveformPeaks('track-a', 60);
assertEqual(bars.length, 60);
assert(
  bars.every((p) => p.up >= 0.12 && p.up <= 1 && p.down >= 0.08 && p.down <= 1),
  'every arm stays inside its seeded clamp',
);
assertEqual(
  JSON.stringify(bars),
  JSON.stringify(waveformPeaks('track-a', 60)),
  'same seed and count is deterministic',
);
assert(
  JSON.stringify(bars) !== JSON.stringify(waveformPeaks('track-b', 60)),
  'a different seed produces a different pattern',
);
assert(
  bars.some((p) => Math.abs(p.up - p.down) > 0.02),
  'seeded pairs are asymmetric — up and down differ',
);
assertEqual(waveformPeaks('track-a', 0).length, 0, 'count 0 yields no bars');
assertEqual(
  waveformPeaks('track-a', -3).length,
  0,
  'negative count yields no bars',
);
assert(
  new Set(bars.map((p) => p.up)).size > 10,
  'the pattern actually varies bar to bar',
);

// waveformBarLayout: count from width, bars centered
const layout = waveformBarLayout(200);
assertEqual(layout.count, 36, 'n bars cost n·bar + (n−1)·gap');
assertEqual(
  layout.count,
  Math.floor((200 + 2.5) / (3 + 2.5)),
  'count follows the barWidth+gap budget',
);
assertEqual(waveformBarLayout(3).count, 1, 'one barWidth alone fits one bar');
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

// peaksFromChannels: per-window RMS buckets → normalized pairs.
// Synthetic PCM: a sine's flat envelope, an impulse's spike.
const FLOOR = Math.pow(0.05, 1.2); // normalized floor stub height
{
  // An exactly alternating ±0.5 signal gives every bucket the same
  // energy — the degenerate percentile band maps each bar to the
  // top, both arms.
  const uniform = new Float32Array(1024);
  for (let i = 0; i < uniform.length; i += 1) {
    uniform[i] = i % 2 === 0 ? 0.5 : -0.5;
  }
  const profile = peaksFromChannels([uniform], 8);
  assertEqual(profile.length, 8, 'profile has the requested width');
  assert(
    profile.every((p) => p.up === 1 && p.down === 1),
    'a constant envelope reads as a flat full row',
  );
  assertEqual(
    peaksFromChannels([uniform], PEAKS_RESOLUTION).length,
    PEAKS_RESOLUTION,
    'canonical resolution yields the canonical width',
  );

  // One loud positive-only burst over a quiet ±0.1 floor → the
  // headroom-relaxed band keeps the floor low while the burst
  // saturates its upper arm only. (A lone spike in pure silence is
  // under the band's 5% mass and honestly renders nothing.)
  const burst = new Float32Array(1024);
  for (let i = 0; i < burst.length; i += 1) {
    burst[i] = i % 2 === 0 ? 0.1 : -0.1;
  }
  for (let i = 768; i < 896; i += 1) {
    burst[i] = 1;
  }
  const spiked = peaksFromChannels([burst], 8);
  assertEqual(spiked[6]?.up, 1, 'the burst owns its bucket');
  assertEqual(
    spiked[6]?.down,
    0,
    'a unipolar burst leaves the lower arm an honest zero — asymmetric',
  );
  assert(
    (spiked[0]?.up ?? 0) > FLOOR && (spiked[0]?.up ?? 0) < 0.25,
    'quiet neighbours draw low — above the stub floor, far from the burst',
  );

  // Stereo splits channels: left → up, right → down.
  const left = new Float32Array(4);
  const right = new Float32Array(4);
  left[0] = 0.5;
  right[3] = -1;
  const stereo = peaksFromChannels([left, right], 4);
  assertEqual(stereo[0]?.up, 1, 'the left channel feeds the upper arm');
  assertEqual(stereo[3]?.down, 1, 'the right channel feeds the lower arm');
  assertEqual(
    stereo[0]?.down,
    0,
    'the absent lower channel reads zero — bars are not mirrors',
  );

  // Dynamics survive: a 14 dB-quiet tail does not normalize to full
  // height the way the old loudest-bucket map read. Twenty buckets
  // give the percentile band enough mass to anchor p95 at the loud
  // level.
  const loudHush = new Float32Array(2048);
  loudHush.fill(0.5, 0, 1536);
  loudHush.fill(0.1, 1536);
  const dyn = peaksFromChannels([loudHush], 20);
  assertEqual(dyn[0]?.up, 1, 'the loud section saturates');
  assert(
    (dyn[19]?.up ?? 1) < 0.2,
    'a quieter section draws a lower envelope',
  );

  // Silence and emptiness are honest zeros, never a divide-by-NaN.
  const flat = peaksFromChannels([new Float32Array(64)], 8);
  assert(
    flat.every((p) => p.up === 0 && p.down === 0),
    'silence yields a zero profile',
  );
  const empty = peaksFromChannels([new Float32Array(0)], 8);
  assert(
    empty.every((p) => p.up === 0 && p.down === 0),
    'empty input yields a zero profile',
  );
  assertEqual(
    peaksFromChannels([uniform], 0).length,
    0,
    'zero count yields empty',
  );
}

// normalizePeakWindows: shared percentile band + gamma on one scale.
{
  const norm = normalizePeakWindows([
    { up: 1, down: 0.5 },
    { up: 0.2, down: 0.1 },
  ]);
  // Percentiles over the joint magnitudes keep a single shared scale:
  // the loudest arm reaches 1, the quietest sits on the floor.
  assertEqual(norm.length, 2, 'one pair per window');
  assert(
    norm.every((p) => p.up >= FLOOR - 1e-9 && p.up <= 1),
    'normalized arms stay in range',
  );
  assert(
    normalizePeakWindows([]).length === 0,
    'empty input normalizes to empty',
  );
  const silent = normalizePeakWindows([{ up: 0, down: 0 }]);
  assert(silent[0]?.up === 0 && silent[0]?.down === 0, 'silence stays zero');
}

// resamplePeaks: per-side max-pool downsample, per-side linear
// upsample, zeroed-pair padding.
{
  const up = resamplePeaks(
    [
      { up: 0, down: 0.4 },
      { up: 1, down: 0.2 },
    ],
    4,
  );
  assertEqual(up.length, 4, 'upsampled to the bar count');
  assertEqual(up[0]?.up, 0, 'upsample starts at the first peak');
  assertEqual(up[0]?.down, 0.4, 'the lower arm interpolates too');
  assertEqual(up[3]?.up, 1, 'upsample ends at the last peak');
  assert(
    Math.abs((up[1]?.up ?? 0) - 1 / 3) < 0.001,
    'upsample interpolates linearly',
  );

  // 4→2 per-side max-pool: a transient survives aggregation.
  const down = resamplePeaks(
    [
      { up: 0.2, down: 0.9 },
      { up: 1, down: 0.3 },
      { up: 0.4, down: 0.6 },
      { up: 0.1, down: 0.8 },
    ],
    2,
  );
  assertEqual(down[0]?.up, 1, 'downsample keeps the bucket max up');
  assertEqual(down[0]?.down, 0.9, 'downsample keeps the bucket max down');
  assertEqual(down[1]?.up, 0.4, 'second bucket max up');
  assertEqual(down[1]?.down, 0.8, 'second bucket max down');

  // Identity resample is exact.
  const same = resamplePeaks(
    [
      { up: 0.3, down: 0.2 },
      { up: 0.7, down: 0.5 },
    ],
    2,
  );
  assertEqual(same[0]?.up, 0.3, 'same-count resample is exact');
  assertEqual(same[1]?.down, 0.5, 'same-count resample is exact');

  assert(
    resamplePeaks([], 4).every((p) => p.up === 0 && p.down === 0),
    'empty input yields zeroed pairs',
  );
  assertEqual(resamplePeaks([{ up: 1, down: 1 }], 0).length, 0, 'zero count yields empty');
  const single = resamplePeaks([{ up: 0.5, down: 0.3 }], 3);
  assert(
    single.every((p) => p.up === 0.5 && p.down === 0.3),
    'a lone peak broadcasts across the row',
  );
}

console.log('ui-shared tests passed');
