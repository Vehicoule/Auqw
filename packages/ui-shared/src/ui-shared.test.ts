// Smoke coverage for the shared view-model layer. The deep mapper and
// fixture invariants live in packages/ui-native/src/ui-native.test.ts —
// they now exercise this module through '@auqw/ui-shared'. Here we only
// prove the package resolves cleanly for a plain node consumer: the
// mappers import nothing react-native and fixtures stay coherent.
import { assert, assertEqual } from '@auqw/application/testing';
import { appError } from '@auqw/application';
import {
  createSerializedWrite,
  downloadChip,
  downloadChipsByRecording,
  downloadIconState,
  downloadLedgerCount,
  formatAgo,
  languageOptionKey,
  nextQueueDestination,
  overlayReducer,
  resolveLocale,
  setLocale,
  settingsGroups,
  settingsRowConfirms,
  t,
  toAuthSheetModel,
  toHomeModel,
  toLibraryModel,
  toQueueModel,
  toSettingsModel,
  toSyncPanel,
} from './index.ts';
import type { Locale, MessageId, OverlayEntry } from './index.ts';
import type { DownloadProgress, Result } from '@auqw/application';
import {
  waveformBarExtent,
  waveformBarLayout,
  waveformPlaceholder,
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
  fixtureEntities,
  fixtureEntitySourceRefs,
  fixturePlayCounts,
  fixturePlayHistory,
  fixturePlaylistEntries,
  fixturePlaylists,
  fixtureSearchResults,
  fixtureSettings,
  fixtureSettingsModel,
} from './fixtures.ts';
import {
  fixtureCorrectionsModel,
  fixtureCorrectionsModelEmpty,
  fixtureCorrectionsModelError,
  fixtureCorrectionsModelLoading,
  fixtureCorrectionsModelPending,
  fixtureEntityModel,
  fixtureEntityModelError,
  fixtureLibraryModel,
  fixtureLyricsError,
  fixtureLyricsPlain,
  fixtureImportPreviewModel,
  fixtureLyricsSynced,
  fixturePlayerBuffering,
  fixturePlayerFailed,
  fixturePlayerPlaying,
  fixtureRadioModels,
  fixtureSearchStates,
  fixtureTransferModel,
  fixtureTransferModelDone,
  fixtureTransferModelError,
  fixtureTransferModelPreview,
} from './fixtures.ts';
import {
  downloadButtonView,
  libraryScreenView,
  librarySortedCards,
  lyricsPaneView,
  queueReorderButton,
  queueSectionLabel,
  radioRowView,
  stageMetaView,
  stageModeTabs,
  useCorrectionsScreenController,
  useEntityScreenController,
  useQueueScreenController,
  useSearchScreenController,
  useTransferScreenController,
  useTransportView,
} from './controllers.ts';
import type { LibraryControls } from './controllers.ts';

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

// Sections: the display grouping is nowPlaying → upNext → history,
// built around the cursor while `items` stays canonical.
assertEqual(
  queue.sections.map((section) => section.key).join(','),
  'nowPlaying,upNext',
);
assertEqual(
  queue.sections[0]?.items[0]?.occurrenceId,
  'occ-1',
  'the current item leads the display order',
);
assert(
  queue.sections[1]?.items.every((item) => item.section === 'upNext') === true,
  'upNext members carry their section',
);
const currentItem = queue.items.find((item) => item.current);
assert(currentItem !== undefined, 'current item exists');
assertEqual(
  queue.items[currentItem.index]?.occurrenceId,
  currentItem.occurrenceId,
  'item.index is the canonical slot',
);
assertEqual(queue.ended, false, 'a running queue is not ended');

// A mid-queue cursor puts already-played entries in a trailing
// history section after the pending list.
const midQueue = toQueueModel({
  queue: {
    ...fixtureQueue,
    currentOccurrenceId: 'occ-4',
    mode: 'paused',
    positionMs: 0,
  },
  recordings: fixtureRecordings,
  likes: fixtureLikes,
});
assertEqual(
  midQueue.sections.map((section) => section.key).join(','),
  'nowPlaying,upNext,history',
);
assertEqual(
  midQueue.sections
    .flatMap((section) => section.items.map((item) => item.occurrenceId))
    .join(','),
  'occ-4,occ-5,occ-6,occ-7,occ-8,occ-1,occ-2,occ-3',
  'display order is current → pending → earlier',
);

// A queue with no cursor holds its items as ended/up-next — a surface
// can keep showing it instead of collapsing to empty.
const endedQueue = toQueueModel({
  queue: {
    ...fixtureQueue,
    currentOccurrenceId: null,
    mode: 'stopped',
    positionMs: 0,
  },
  recordings: fixtureRecordings,
});
assertEqual(endedQueue.ended, true, 'items with no cursor is an ended queue');
assertEqual(
  endedQueue.sections.map((section) => section.key).join(','),
  'upNext',
  'an ended queue lists everything as up next',
);

// Failed occurrences mark their row 'error'; the engine's
// blockedError counts even without an explicit id set.
const failedQueue = toQueueModel({
  queue: fixtureQueue,
  recordings: fixtureRecordings,
  failedOccurrenceIds: new Set(['occ-5']),
});
const failedItem = failedQueue.items.find((i) => i.occurrenceId === 'occ-5');
assertEqual(failedItem?.row.state, 'error', 'failed occurrence marks the row');
assertEqual(failedItem?.row.note, t('queue.failed'));
const blockedQueue = toQueueModel({
  queue: {
    ...fixtureQueue,
    mode: 'paused',
    blockedError: appError('unavailable', 'gone'),
  },
  recordings: fixtureRecordings,
});
assertEqual(
  blockedQueue.items.find((i) => i.current)?.row.state,
  'error',
  'a blocked current marks itself failed',
);
assertEqual(queueSectionLabel('upNext'), t('queue.upNext'));
assertEqual(queueSectionLabel('history'), t('queue.history'));

// Under shuffle sections follow the dealt walk, not canonical order:
// rows after the current deal position are up next even when they
// sit earlier in the queue array, and each section lists its rows in
// walk order.
const shuffledQueue = toQueueModel({
  queue: {
    ...fixtureQueue,
    currentOccurrenceId: 'occ-4',
    mode: 'paused',
    positionMs: 0,
  },
  recordings: fixtureRecordings,
  dealtOrder: ['occ-2', 'occ-4', 'occ-7', 'occ-1', 'occ-8'],
});
assertEqual(
  shuffledQueue.sections
    .flatMap((section) => section.items.map((item) => item.occurrenceId))
    .join(','),
  'occ-4,occ-7,occ-1,occ-8,occ-3,occ-5,occ-6,occ-2',
  'dealt order drives sections: undealt rows trail up next',
);
assertEqual(
  shuffledQueue.sections.find((s) => s.key === 'history')?.items.length,
  1,
  'deal positions before current are history',
);

// A deal that lost the current id falls back to canonical order.
const staleDeal = toQueueModel({
  queue: fixtureQueue,
  recordings: fixtureRecordings,
  dealtOrder: ['occ-5', 'occ-6'],
});
assertEqual(
  staleDeal.sections
    .flatMap((s) => s.items.map((i) => i.occurrenceId))
    .join(','),
  'occ-1,occ-2,occ-3,occ-4,occ-5,occ-6,occ-7,occ-8',
  'current missing from the deal: canonical partitioning',
);

// ---- nextQueueDestination ----------------------------------------------
// Mirrors the engine's mark-skipping walk so offline/availability gates
// test the row the cursor actually plays, not the next walk slot.
const failed = new Set(['occ-3', 'occ-8']);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-2' },
    repeat: 'off',
    failedIds: failed,
  }),
  'occ-4',
  'canonical next steps over the marked row',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-7' },
    repeat: 'off',
    failedIds: failed,
  }),
  null,
  'tail row marked + no repeat: nowhere to land',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-7' },
    repeat: 'all',
    failedIds: failed,
  }),
  'occ-1',
  'repeat=all wraps canonical to the head row',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-7' },
    repeat: 'all',
    failedIds: new Set(['occ-1', 'occ-8']),
  }),
  'occ-2',
  'canonical wrap skips a marked head',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-7' },
    repeat: 'all',
    failedIds: new Set(
      fixtureQueue.occurrences.map((o) => o.occurrenceId),
    ),
  }),
  null,
  'all-failed canonical wrap ends the walk',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-4' },
    dealtOrder: ['occ-2', 'occ-8', 'occ-4'],
    repeat: 'all',
    failedIds: failed,
  }),
  'occ-2',
  'dealt tail wraps to the first unmarked row',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-4' },
    dealtOrder: ['occ-2', 'occ-4', 'occ-8', 'occ-1'],
    repeat: 'all',
    failedIds: failed,
  }),
  'occ-1',
  'dealt next skips the marked successor',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: 'occ-4' },
    dealtOrder: ['occ-2', 'occ-4', 'occ-8'],
    repeat: 'all',
    failedIds: new Set(['occ-2', 'occ-4', 'occ-8']),
  }),
  null,
  'a fully-marked deal has no destination even under repeat=all',
);
// An ended (or never-started) queue has a null cursor: the engine's
// next() is a no-op there that never wraps — advance() fails
// 'no-result' — so no destination exists even under repeat=all.
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: null },
    repeat: 'all',
    failedIds: failed,
  }),
  null,
  'ended queue under repeat=all never wraps — the engine refuses a null cursor',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: null },
    dealtOrder: ['occ-2', 'occ-8', 'occ-4'],
    repeat: 'all',
    failedIds: failed,
  }),
  null,
  'a null cursor stays null under shuffle — the engine checks it before the deal',
);
assertEqual(
  nextQueueDestination({
    queue: { occurrences: fixtureQueue.occurrences, currentOccurrenceId: null },
    repeat: 'off',
    failedIds: failed,
  }),
  null,
  'ended queue under repeat=off has no destination',
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

// waveformPlaceholder: flat zero-amplitude bars — honest 'no
// measurement yet', never a fabricated shape standing in for data.
const bars = waveformPlaceholder(60);
assertEqual(bars.length, 60);
assert(
  bars.every((p) => p.up === 0 && p.down === 0),
  'every placeholder arm is zero',
);
assert(
  new Set(bars).size === bars.length,
  'each bar is its own object — no shared instance to mutate',
);
assertEqual(
  waveformPlaceholder(0).length,
  0,
  'count 0 yields no bars',
);
assertEqual(
  waveformPlaceholder(-3).length,
  0,
  'negative count yields no bars',
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

// overlayReducer: push/reset/close/dismiss/clear transitions on the
// overlay screen stack — the shell behavior behind useOverlayStack.
{
  type Route = { readonly name: string };
  const route = (name: string): Route => ({ name });
  let stack: readonly OverlayEntry<Route>[] = [];
  stack = overlayReducer(stack, {
    type: 'push',
    key: 'ov-1',
    overlay: route('a'),
  });
  stack = overlayReducer(stack, {
    type: 'push',
    key: 'ov-2',
    overlay: route('b'),
  });
  stack = overlayReducer(stack, {
    type: 'push',
    key: 'ov-3',
    overlay: route('c'),
  });
  assertEqual(stack.length, 3, 'push appends in order');
  assertEqual(stack[2]?.overlay.name, 'c', 'the last push sits on top');

  // dismiss removes the entry and every screen pushed above it.
  stack = overlayReducer(stack, { type: 'dismiss', key: 'ov-2' });
  assertEqual(stack.length, 1, 'dismiss drops the entry and its above');
  assertEqual(stack[0]?.key, 'ov-1', 'only deeper routes survive');
  // A stale key is a no-op — same stack reference, nothing sliced.
  const stale = overlayReducer(stack, { type: 'dismiss', key: 'ov-9' });
  assert(stale === stack, 'dismissing an unknown key returns the stack');

  stack = overlayReducer(stack, {
    type: 'push',
    key: 'ov-4',
    overlay: route('d'),
  });
  stack = overlayReducer(stack, { type: 'close' });
  assertEqual(stack.length, 1, 'close pops the top route');
  assertEqual(stack[0]?.key, 'ov-1');

  stack = overlayReducer(stack, {
    type: 'push',
    key: 'ov-5',
    overlay: route('e'),
  });
  stack = overlayReducer(stack, {
    type: 'reset',
    key: 'ov-6',
    overlay: route('f'),
  });
  assertEqual(stack.length, 1, 'reset replaces the whole stack');
  assertEqual(stack[0]?.key, 'ov-6');

  stack = overlayReducer(stack, { type: 'clear' });
  assertEqual(stack.length, 0, 'clear empties the stack');
}

// createSerializedWrite — the queueSettingsWrite core: submissions
// land in order, each merging its patch onto the committed base at
// execution time; a failure neither commits nor wedges the chain.
{
  type Shape = { readonly a: number; readonly b: number };
  let committed: Shape | null = { a: 1, b: 0 };
  let live: Shape = { a: 0, b: 0 };
  const written: Shape[] = [];
  const gates: Array<() => void> = [];
  let nextResult: Result<unknown> = { ok: true, value: null };
  const submit = createSerializedWrite<Shape>(
    (next) => {
      written.push(next);
      return new Promise<Result<unknown>>((resolve) => {
        gates.push(() => resolve(nextResult));
      });
    },
    () => committed,
    () => live,
    (next) => {
      live = next;
    },
  );
  const flush = () => Promise.resolve();

  const first = submit({ a: 10 });
  const second = submit({ b: 20 });
  await flush();
  assertEqual(
    gates.length,
    1,
    'a second write queues behind an unsettled first',
  );
  committed = { a: 10, b: 0 }; // the snapshot the first write lands
  gates[0]?.();
  await first;
  await flush();
  assertEqual(written.length, 2, 'the queued write runs once unblocked');
  assert(
    written[1]?.a === 10 && written[1]?.b === 20,
    'a queued write merges onto the base committed at execution time',
  );
  gates[1]?.();
  await second;
  const landed = live;
  assert(
    landed.a === 10 && landed.b === 20,
    'live tracks committed writes',
  );

  // readCommitted === null → the merge base falls back to the live
  // value; a function patch reads that base at execution time.
  committed = null;
  const third = submit((latest) => ({ a: latest.a + 5 }));
  await flush();
  assert(
    written[2]?.a === 15 && written[2]?.b === 20,
    'a function patch reads the live fallback base',
  );
  gates[2]?.();
  await third;

  // A failed write skips the live update but leaves the chain usable.
  nextResult = {
    ok: false,
    error: { kind: 'transient', message: 'x', retryable: true },
  };
  const before = live;
  const failed = submit({ a: 99 });
  await flush();
  gates[3]?.();
  const failedResult = await failed;
  assert(!failedResult.ok, 'the failure surfaces to the caller');
  assert(live === before, 'a failed write leaves the live value alone');
  nextResult = { ok: true, value: null };
  const after = submit({ a: 30 });
  await flush();
  gates[4]?.();
  await after;
  assert(live.a === 30, 'the chain still lands writes after a failure');
}

// ---- controllers -------------------------------------------------------
// The hook-named controllers that hold no React state are plain
// derivations — exercised directly here. `libraryScreenView` is the pure
// half of useLibraryScreenController (the hook only owns the useState
// slots), so filtering/sorting/bound-action coverage runs in plain node.

let tapped = '';
const tap = (s: string) => {
  tapped = s;
};

// queue
{
  const view = useQueueScreenController({
    queue: fixtureQueueModel,
    player: fixturePlayerPlaying,
  });
  assertEqual(
    view.countLabel,
    t('queue.count', { count: fixtureQueueModel.items.length }),
  );
  assertEqual(view.current?.title, fixturePlayerPlaying.title);
  assertEqual(view.current?.playing, true);
  assertEqual(view.reorder, null, 'reorder hidden without a handler');
  const armed = queueReorderButton(true, () => tap('reorder'));
  assertEqual(armed?.a11yLabel, t('queue.reorderDone'));
  armed?.onPress?.();
  assertEqual(tapped, 'reorder', 'reorder button calls through');
}

// corrections — phase dispatch
{
  assertEqual(
    useCorrectionsScreenController({ model: fixtureCorrectionsModelLoading })
      .body.kind,
    'loading',
  );
  const err = useCorrectionsScreenController({
    model: fixtureCorrectionsModelError,
  });
  assert(err.body.kind === 'error');
  assertEqual(err.body.hint, fixtureCorrectionsModelError.message);
  const empty = useCorrectionsScreenController({
    model: fixtureCorrectionsModelEmpty,
  });
  assert(empty.body.kind === 'empty');
  assert(empty.body.hint === t('corrections.emptyHint.pending'));

  const view = useCorrectionsScreenController({
    model: fixtureCorrectionsModel,
    onFilter: (f) => tap(`filter:${f}`),
    onConfirm: (id, i) => tap(`confirm:${id}:${i}`),
    onReject: (id) => tap(`reject:${id}`),
    onUndo: (id) => tap(`undo:${id}`),
  });
  assert(view.body.kind === 'rows');
  assertEqual(
    view.filters.find((f) => f.value === fixtureCorrectionsModel.filter)
      ?.selected,
    true,
  );
  view.filters.find((f) => f.value === 'resolved')?.onPress?.();
  assertEqual(tapped, 'filter:resolved');

  const pendingRow = view.body.rows.find((r) => r.pending);
  assert(pendingRow !== undefined, 'fixture has a pending review');
  assertEqual(pendingRow.action.kind, 'reject');
  assert(
    pendingRow.candidates.every((c) => c.enabled),
    'pending candidates are bound',
  );
  pendingRow.candidates[0]?.onPress?.();
  assert(
    tapped.startsWith(`confirm:${pendingRow.row.reviewId}:`),
    'confirm carries reviewId + candidate index',
  );

  const resolvedRow = view.body.rows.find((r) => !r.pending);
  if (resolvedRow !== undefined) {
    assertEqual(resolvedRow.action.kind, 'undo');
    assert(
      resolvedRow.candidates.every((c) => !c.enabled),
      'resolved candidates are inert',
    );
  }

  // Unbound handlers produce inert, not undefined-shape, rows.
  const inert = useCorrectionsScreenController({
    model: fixtureCorrectionsModelPending,
  });
  assert(inert.body.kind === 'rows');
  assert(inert.body.rows.every((r) => r.action.onPress === undefined));
}

// transfer — row states + footer dispatch
{
  const idle = useTransferScreenController({ model: fixtureTransferModel });
  assertEqual(idle.importBody, null);
  assertEqual(idle.exportRow.disabled, true, 'no handler disables the row');

  const preview = useTransferScreenController({
    model: fixtureTransferModelPreview,
    onExport: () => tap('export'),
    onPickImportFile: () => tap('pick'),
    onApplyImport: () => tap('apply'),
    onResetImport: () => tap('reset'),
  });
  assert(preview.importBody !== null);
  assert(preview.importBody.footer.kind === 'confirm');
  preview.importBody.footer.onApply?.();
  assertEqual(tapped, 'apply');
  assertEqual(preview.exportRow.detail, fixtureTransferModelPreview.exportDetail);

  const done = useTransferScreenController({ model: fixtureTransferModelDone });
  assert(done.importBody?.footer.kind === 'done');
  const failed = useTransferScreenController({
    model: fixtureTransferModelError,
  });
  assertEqual(failed.importBody, null, 'no preview means no import body');
  assertEqual(
    failed.importRow.detail,
    fixtureTransferModelError.importDetail,
    'import row carries the typed detail',
  );
  const failedWithPreview = useTransferScreenController({
    model: {
      ...fixtureTransferModelError,
      preview: fixtureImportPreviewModel,
    },
  });
  assert(failedWithPreview.importBody?.footer.kind === 'error');
}

// library — pure view half covers filtering, sorting, bound actions
{
  const controls = (
    over: Partial<LibraryControls> = {},
  ): LibraryControls => ({
    filter: 'all',
    sort: 'recent',
    layout: 'grid',
    creating: false,
    draft: '',
    setFilter: (f) => tap(`filter:${f}`),
    setSort: (s) => tap(`sort:${s}`),
    setLayout: (l) => tap(`layout:${l}`),
    setCreating: (c) => tap(`creating:${c}`),
    setDraft: (d) => tap(`draft:${d}`),
    ...over,
  });
  const sliceFor = (c: LibraryControls) =>
    librarySortedCards(fixtureLibraryModel.cards, c.filter, c.sort);
  const base = controls();
  const view = libraryScreenView(
    fixtureLibraryModel,
    sliceFor(base),
    base,
    {
      onOpenCard: (card) => tap(`card:${card.title}`),
      onCreatePlaylist: (name) => tap(`create:${name}`),
    },
  );
  assertEqual(view.cards.length, fixtureLibraryModel.cards.length);
  const kinds = fixtureLibraryModel.cards.map((c) => c.kind);
  assertEqual(
    view.filterOptions.length,
    1 + new Set(kinds).size,
    'one chip per kind present in the model',
  );
  view.filterOptions[1]?.onPress?.();
  assert(tapped.startsWith('filter:'), 'kind chips call setFilter');
  view.sortChip.onPress?.();
  assertEqual(tapped, 'sort:title', 'sort chip toggles to title order');
  view.newCard?.onPress?.();
  assertEqual(tapped, 'creating:true', 'new-playlist card opens the field');

  const log: string[] = [];
  const creatingControls = controls({
    creating: true,
    draft: 'mix',
    setDraft: (d) => log.push(`draft:${d}`),
    setCreating: (c) => log.push(`creating:${c}`),
  });
  const creating = libraryScreenView(
    fixtureLibraryModel,
    sliceFor(creatingControls),
    creatingControls,
    { onCreatePlaylist: (name) => log.push(`create:${name}`) },
  );
  assertEqual(creating.newCard, null, 'new card hides while creating');
  creating.nameField?.onSubmit?.('mix');
  assertEqual(
    log.join('|'),
    'create:mix|draft:|creating:false',
    'submit creates, then clears and closes the field',
  );
  creating.nameField?.onCancel?.();
  assertEqual(
    log.join('|'),
    'create:mix|draft:|creating:false|draft:|creating:false',
    'cancel clears and closes without creating',
  );
}

// entity — discriminated phases + gating
{
  assertEqual(
    useEntityScreenController({ model: fixtureEntityModelError }).kind,
    'error',
  );
  const ready = useEntityScreenController({
    model: fixtureEntityModel,
    onToggleLike: () => tap('like'),
  });
  assert(ready.kind === 'ready');
  assertEqual(ready.like.icon, 'heart-filled', 'liked model gets filled icon');
  ready.like.onPress?.();
  assertEqual(tapped, 'like');
}

// search — phase dispatch + draft mode
{
  const idle = useSearchScreenController({
    state: fixtureSearchStates[0]!,
    recents: ['radiohead ok computer'],
    onRecentPress: (q) => tap(`recent:${q}`),
  });
  assert(idle.idle?.kind === 'recents');
  idle.idle.items[0]?.onPress?.();
  assertEqual(tapped, 'recent:radiohead ok computer');

  const ready = useSearchScreenController({
    state: fixtureSearchStates[2]!,
    onResultPress: (row) => tap(`result:${row.key}`),
  });
  assert(ready.resultsHead !== null, 'ready phase gets a results header');
  assertEqual(ready.results?.rows.length, fixtureSearchStates[2]!.results.length);
  ready.results?.rows[0]?.onPress?.();
  assert(tapped.startsWith('result:'), 'result rows bind the row model');

  // A typed-but-uncommitted draft switches the pane to suggestions.
  const drafting = useSearchScreenController({
    state: fixtureSearchStates[0]!,
    query: 'radiohe',
    suggestions: ['radiohead'],
    onSuggestionPress: (q) => tap(`suggest:${q}`),
    onQueryChange: () => {},
  });
  assertEqual(drafting.draft, true);
  assertEqual(drafting.idle, null, 'draft suppresses the recents pane');
  drafting.suggestions?.items[0]?.onPress?.();
  assertEqual(tapped, 'suggest:radiohead');

  const failed = useSearchScreenController({
    state: fixtureSearchStates[4]!,
    onRetry: () => tap('retry'),
  });
  assert(failed.status?.kind === 'error');
  failed.status.onRetry?.();
  assertEqual(tapped, 'retry');
}

// stage pieces
{
  const tabs = stageModeTabs(
    ['player', 'lyrics', 'queue'],
    'lyrics',
    (m) => tap(`mode:${m}`),
  );
  assertEqual(
    tabs.map((tab) => tab.key).join(','),
    'player,lyrics,queue',
    'order follows the caller',
  );
  assertEqual(tabs[1]?.active, true);
  tabs[2]?.onPress?.();
  assertEqual(tapped, 'mode:queue');

  const dl = downloadButtonView('failed', () => tap('dl'));
  assertEqual(dl.icon, 'warn');
  assertEqual(dl.state, 'failed', 'the view carries the raw chip');
  assertEqual(downloadButtonView('queued', undefined).busy, true);
  assertEqual(downloadButtonView('stored', undefined).a11yLabel, t('stage.download.storedA11y'));

  // Chip → icon phase: both platforms' DownloadIcon morphs on this map —
  // the four coarse phases cover all six chips, nothing falls through.
  assertEqual(downloadIconState('idle'), 'idle');
  assertEqual(downloadIconState('queued'), 'busy');
  assertEqual(downloadIconState('downloading'), 'busy');
  assertEqual(downloadIconState('removing'), 'busy');
  assertEqual(downloadIconState('stored'), 'done');
  assertEqual(downloadIconState('failed'), 'error');

  // Downloads ledger: one count/chip rule for every surface.
  const removingView = downloadButtonView('removing', () => tap('dl'));
  assertEqual(removingView.busy, true, 'removing reads busy');
  assertEqual(
    removingView.onPress,
    undefined,
    'removing disables the affordance — mid-delete is not actionable',
  );
  assertEqual(
    removingView.a11yLabel,
    t('stage.download.busyA11y'),
    'removing announces as busy',
  );

  const progress = (
    downloadId: string,
    recordingId: string,
    state: DownloadProgress['state'],
  ): DownloadProgress => ({
    downloadId,
    recordingId,
    state,
    transferredBytes: 0,
    totalBytes: null,
  });
  const ledger = [
    progress('dl-a', 'rec-self-aware', 'available'),
    progress('dl-b', 'rec-petit', 'failed_with_retry'),
    progress('dl-c', 'rec-dracula', 'requested'),
    progress('dl-d', 'rec-maladie', 'removing'),
  ];
  assertEqual(downloadChip('requested'), 'queued');
  assertEqual(downloadChip('transferring'), 'downloading');
  assertEqual(downloadChip('available'), 'stored');
  assertEqual(downloadChip('failed_with_retry'), 'failed');
  assertEqual(
    downloadChip('removing'),
    'removing',
    'mid-delete gets its own chip — never a fake failed',
  );
  assertEqual(
    downloadLedgerCount(ledger),
    3,
    'ledger count keeps failed rows, drops mid-delete ones',
  );
  const chips = downloadChipsByRecording(ledger);
  assertEqual(chips.get('rec-maladie'), 'removing');
  assertEqual(chips.get('rec-petit'), 'failed');
  assertEqual(chips.size, 4, 'list()-driven map keeps every row');

  const lib = toLibraryModel({
    recordings: fixtureRecordings,
    likes: fixtureLikes,
    playlists: fixturePlaylists,
    playlistEntries: fixturePlaylistEntries,
    playHistory: fixturePlayHistory,
    playCounts: fixturePlayCounts,
    entities: fixtureEntities,
    entitySourceRefs: fixtureEntitySourceRefs,
    downloads: ledger,
  });
  assertEqual(
    lib.collections.find((c) => c.key === 'downloads')?.count,
    lib.collectionRows.downloads.length,
    'tile count equals page rows — one rule',
  );
  assertEqual(
    lib.collectionRows.downloads.length,
    3,
    'failed-but-kept counts; removing does not',
  );
  assert(
    lib.collectionRows.downloads.some(
      (r) => r.row.download === 'failed' && r.recordingId === 'rec-petit',
    ),
    'failed rows render the failed chip on the downloads page',
  );

  assertEqual(
    radioRowView(fixtureRadioModels[0], undefined, undefined),
    null,
    'unarmed radio without a seed action hides the row',
  );
  const armedRadio = radioRowView(
    fixtureRadioModels[1],
    () => tap('start'),
    () => tap('stop'),
  );
  assert(armedRadio?.armed === true);
  assert(armedRadio.statusText.length > 0);
  const failedRadio = radioRowView(
    fixtureRadioModels[4],
    () => tap('start'),
    () => tap('stop'),
  );
  assertEqual(failedRadio?.failed, true);
  assert(
    failedRadio?.statusText.includes(
      'something interrupted that — try again',
    ) ?? false,
    'failed tail carries the humanized reason, not the raw message',
  );

  const meta = stageMetaView(fixturePlayerFailed);
  assertEqual(meta.errorMessage, fixturePlayerFailed.errorMessage);
  assertEqual(meta.waveformLoading, false, 'resolved duration draws bars');
  assertEqual(
    stageMetaView({ ...fixturePlayerBuffering, status: 'preparing' })
      .waveformLoading,
    true,
    'preparing players show the loading waveform',
  );
  assertEqual(
    stageMetaView({ ...fixturePlayerPlaying, durationMs: null })
      .waveformLoading,
    true,
    'unknown duration shows the loading waveform',
  );

  const transport = useTransportView({
    status: 'playing',
    intentPlaying: true,
    liked: false,
    canPrevious: false,
    canNext: true,
    repeat: 'one',
    onToggleLike: () => tap('like'),
  });
  assertEqual(transport.playing, true);
  assertEqual(transport.repeat.icon, 'repeat-one');
  assertEqual(transport.previous.disabled, true);
  assertEqual(transport.shuffle.disabled, true, 'unbound shuffle disables');
  transport.like.onPress?.();
  assertEqual(tapped, 'like');

  assertEqual(lyricsPaneView(fixtureLyricsError, undefined).kind, 'error');
  assertEqual(lyricsPaneView(fixtureLyricsPlain, undefined).kind, 'lines');
  const synced = lyricsPaneView(fixtureLyricsSynced, undefined);
  assert(synced.kind === 'lines');
  assert(
    synced.lines.some((line) => line.color === 'accent'),
    'synced lyrics highlight the active line',
  );
  assertEqual(lyricsPaneView(undefined, undefined).kind, 'empty');
}

// ---- auth sheet model ---------------------------------------------------
{
  // 'authorizing' surfaces the user-facing device pair; every other
  // state strips it — a stale code must never linger on a retry.
  const authorizing = toAuthSheetModel({
    state: 'authorizing',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://www.google.com/device',
    expiresAtMs: 9_999,
  });
  assertEqual(authorizing.state, 'authorizing');
  assertEqual(authorizing.userCode, 'ABCD-EFGH');
  assertEqual(authorizing.verificationUrl, 'https://www.google.com/device');
  assertEqual(authorizing.errorMessage, null);
  const failed = toAuthSheetModel({
    state: 'failed',
    error: appError('permission-denied', 'oauth: denied'),
  });
  assertEqual(failed.state, 'failed');
  assert(
    failed.errorMessage !== null && failed.errorMessage.length > 0,
    'failed state carries the localized reason',
  );
  assertEqual(failed.userCode, null);
  const signedIn = toAuthSheetModel({ state: 'signed-in' });
  assertEqual(signedIn.userCode, null);
  assertEqual(signedIn.errorMessage, null);
}

// ---- settings auth rows --------------------------------------------------
{
  // No auth seam → the account rows omit themselves entirely
  // (behavior-identical anonymous settings).
  const bare = toSettingsModel(fixtureSettings, fixtureDiagnostics, {});
  assert(
    !bare.rows.some(
      (r) =>
        r.key === 'googleAuth' ||
        r.key === 'authSignOut' ||
        r.key === 'authClientId',
    ),
    'auth rows leaked into a no-auth settings model',
  );
  const signedOut = toSettingsModel(fixtureSettings, fixtureDiagnostics, {
    auth: { state: 'signed-out', clientId: null },
  });
  const keys = signedOut.rows.map((r) => r.key);
  assert(keys.includes('googleAuth'), 'sign-in row missing');
  assert(keys.includes('authClientId'), 'client-id row missing');
  assert(!keys.includes('authSignOut'), 'signed-out shows sign-out');
  const grouped = settingsGroups(signedOut.rows);
  assert(
    grouped.some((g) => g.key === 'googleAuth' && g.label === 'account'),
    'account section missing',
  );
  const signedIn = toSettingsModel(fixtureSettings, fixtureDiagnostics, {
    auth: { state: 'signed-in', clientId: 'custom-id' },
  });
  const signOutRow = signedIn.rows.find((r) => r.key === 'authSignOut');
  assert(signOutRow !== undefined, 'signed-in hides sign-out');
  assert(signOutRow.destructive === true, 'sign-out not destructive');
  assertEqual(
    signedIn.rows.find((r) => r.key === 'googleAuth')?.value,
    'linked',
  );
  assertEqual(
    signedIn.rows.find((r) => r.key === 'authClientId')?.value,
    'custom-id',
  );

  // settingsRowConfirms — both ports gate their two-tap arm on it.
  assert(
    settingsRowConfirms(signOutRow!),
    'destructive value row arms a confirm',
  );
  const themeRow = settingsGrouped.rows.find((r) => r.key === 'theme');
  assert(themeRow !== undefined, 'theme row missing');
  assert(
    !settingsRowConfirms(themeRow),
    'non-destructive row fires directly',
  );
  const toggleRow = settingsGrouped.rows.find((r) => r.kind === 'toggle');
  assert(toggleRow !== undefined, 'toggle row missing');
  assert(
    !settingsRowConfirms({ ...toggleRow!, destructive: true }),
    'a destructive toggle still fires directly',
  );
}


console.log('ui-shared tests passed');
