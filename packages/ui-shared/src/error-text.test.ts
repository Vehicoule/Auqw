// errorText: every AppError kind maps to humanized catalog text,
// disposal kinds stay silent, and the raw kind/message never leaks
// onto a user surface.
import { assert, assertEqual } from '@auqw/application/testing';
import { appError, MATCH_GATE_MESSAGE } from '@auqw/application';
import type { ErrorKind } from '@auqw/application';
import { errorText } from './error-text.ts';
import { setLocale, t } from './i18n.ts';
import { en } from './locales/en.ts';
import { de } from './locales/de.ts';
import { es } from './locales/es.ts';
import { fr } from './locales/fr.ts';
import { zh } from './locales/zh.ts';

const ALL_KINDS: readonly ErrorKind[] = [
  'no-result',
  'not-applicable',
  'unsupported',
  'auth-required',
  'auth-expired',
  'rate-limit',
  'transient',
  'expired-resource',
  'permission-denied',
  'invalid-response',
  'timeout',
  'cancelled',
  'budget-exceeded',
  'guest-trap',
  'invalid-message',
  'artifact-rejected',
  'streams-capped',
  'released',
  'superseded',
  'evicted',
  'expired',
  'not-found',
  'unavailable',
  'storage-full',
  'internal',
];

// 'released' is deliberately absent: a live prepare can resolve
// released when its host drops the request — that failure must surface.
// 'cancelled' surfaces — providers return it as a real verdict; the
// ops-level call sites (reportResult/reportPlay) own teardown silence.
const SILENT_KINDS: readonly ErrorKind[] = ['superseded'];

// absent input is absent output
assertEqual(errorText(null), null);
assertEqual(errorText(undefined), null);

for (const kind of ALL_KINDS) {
  const text = errorText(appError(kind, `raw engineer text ${kind}`));
  if (SILENT_KINDS.includes(kind)) {
    assertEqual(text, null, `${kind} is disposal — no user-facing text`);
    continue;
  }
  assert(
    typeof text === 'string' && text.length > 0,
    `${kind} produces text`,
  );
  assert(
    text !== `raw engineer text ${kind}` && text !== kind,
    `${kind} leaks neither the raw message nor the bare kind slug`,
  );
  // Every surfaced line is a real catalog entry, not an id echo.
  assert(
    (en as Readonly<Record<string, unknown>>)[text] === undefined,
    `${kind} resolved to a catalog string, not a message id`,
  );
}

// The match gate is 'unavailable' + the shared contract message —
// it must route to review copy, not generic 'unavailable'.
assertEqual(
  errorText(appError('unavailable', MATCH_GATE_MESSAGE)),
  t('error.matchGate'),
  'the match gate names the review remedy',
);
assert(
  errorText(appError('unavailable', 'host unreachable')) !==
    t('error.matchGate'),
  'plain unavailable stays plain',
);

// Known mappings, spot-checked verbatim.
assertEqual(
  errorText(appError('timeout', 'operation deadline exceeded')),
  'still loading — try again',
);
// A provider bot wall is 'transient' on the wire but not weather —
// it gets its own honest line in every wrap shape the host emits.
assertEqual(
  errorText(appError('transient', 'transient: bot-check')),
  'the provider is refusing requests right now — try again later',
);
assertEqual(
  errorText(
    appError('transient', 'guest failure (transient): transient: bot-check'),
  ),
  'the provider is refusing requests right now — try again later',
);
// The dedicated kind lands the same line without any sniffing.
assertEqual(
  errorText(appError('provider-wall', 'provider-wall: bot-check')),
  'the provider is refusing requests right now — try again later',
);
assertEqual(
  errorText(appError('transient', 'socket hangup')),
  'something interrupted that — try again',
  'generic transient keeps the hiccup copy',
);
assertEqual(
  errorText(appError('rate-limit', 'rate-limit')),
  'the provider is rate-limiting right now',
);
assertEqual(
  errorText(appError('budget-exceeded', 'budget-exceeded')),
  'over a limit — slim it down or try later',
);
assertEqual(
  errorText(appError('unsupported', 'x')),
  'not supported here',
);
assertEqual(
  errorText(appError('internal', 'raw-secret-message')),
  'something went wrong — try again',
);

// Text follows the active locale.
setLocale('de');
assertEqual(
  errorText(appError('timeout', 'operation deadline exceeded')),
  'lädt noch — erneut versuchen',
  'the mapper speaks the active locale',
);
setLocale('en');

// Per-locale coverage: every `error.*` key en defines must exist and
// differ in each shipped locale — a missing key silently falls back
// to English with no other signal.
const ERROR_KEYS = Object.keys(en).filter((k) => k.startsWith('error.'));
for (const [tag, locale] of Object.entries({ de, es, fr, zh })) {
  const table = locale as Readonly<Record<string, unknown>>;
  for (const key of ERROR_KEYS) {
    const value = table[key];
    assert(
      typeof value === 'string' && value.length > 0,
      `${tag} is missing ${key}`,
    );
    assert(
      value !== (en as Readonly<Record<string, unknown>>)[key],
      `${tag} ${key} still carries the English string`,
    );
  }
}

console.log('error-text tests passed');
