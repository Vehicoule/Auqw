/**
 * The i18n engine — lookup, interpolation, and plural selection only.
 * Message data lives in `./locales/*.ts`; `en` is the source of truth
 * for message ids. Adding a language is a new file in `./locales/`
 * (plus one name in `Locale` and one row in `catalogs` below).
 *
 * No dependencies: plurals go through the platform `Intl.PluralRules`
 * and everything else is a flat string catalog.
 */
import { en } from './locales/en.ts';
import { de } from './locales/de.ts';

/** CLDR plural categories `Intl.PluralRules` can select. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * A catalog entry: a plain message, or plural forms keyed by CLDR
 * plural category (`zero|one|two|few|many|other`), always with an
 * `other` form as the final fallback.
 */
export type Message = string | Readonly<Record<string, string>>;

export type Locale = 'en' | 'de';

export type MessageId = keyof typeof en;

/** Every supported locale's catalog. `en` is also the fallback catalog. */
const catalogs: Readonly<Record<Locale, Readonly<Record<string, Message>>>> = {
  en,
  de,
};

const SYSTEM_LOCALE: Locale = 'en';

let current: Locale = SYSTEM_LOCALE;

const pluralRules = new Map<Locale, Intl.PluralRules>();

/**
 * `null` when the runtime has no usable `Intl.PluralRules` — the one
 * surface question the language decision row leaves open (Hermes).
 * `systemLocaleTag` already degrades safely; this covers the plural
 * path so a counted message can never throw at render.
 */
function rulesFor(locale: Locale): Intl.PluralRules | null {
  const cached = pluralRules.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  if (typeof Intl === 'undefined' || typeof Intl.PluralRules !== 'function') {
    return null;
  }
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    return null;
  }
  pluralRules.set(locale, rules);
  return rules;
}

/**
 * CLDR plural category for `count`. Degrades to the `one`/`other`
 * split (correct for `en` and `de`) when `Intl.PluralRules` is absent,
 * so the app renders instead of throwing.
 */
function pluralCategory(locale: Locale, count: number): PluralCategory {
  const rules = rulesFor(locale);
  return rules === null
    ? count === 1
      ? 'one'
      : 'other'
    : rules.select(count);
}

/**
 * The platform's locale tag, with no dependency — `Intl` ships on
 * every surface we target (Hermes on Android, V8 on desktop). This
 * is the one probe the language decision-log row leaves open on
 * Hermes, so it degrades safely to 'en' rather than throwing.
 */
export function systemLocaleTag(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return SYSTEM_LOCALE;
  }
}

/** Switch the UI language. Callers resolve the setting via `resolveLocale`. */
export function setLocale(locale: Locale): void {
  current = locale;
}

/** The active UI language. */
export function getLocale(): Locale {
  return current;
}

/**
 * Map a BCP-47 tag to a supported `Locale` by primary-language subtag
 * ('de-DE' → 'de'), or `null` when the language is not supported.
 */
function fromTag(tag: string | null | undefined): Locale | null {
  if (tag === undefined || tag === null || tag === '') {
    return null;
  }
  const primary = tag.trim().toLowerCase().split('-')[0];
  return primary === 'en' || primary === 'de' ? primary : null;
}

/**
 * Resolve the UI language from the stored setting and the platform's
 * locale tag. A supported tag in `setting` (a BCP-47 tag like `'de'` or
 * `'de-DE'`) pins the UI; an absent/`'system'`/unsupported setting
 * follows `systemTag`, defaulting to `'en'`.
 */
export function resolveLocale(
  setting: string | null | undefined,
  systemTag: string,
): Locale {
  const pinned = fromTag(setting);
  return pinned ?? fromTag(systemTag) ?? SYSTEM_LOCALE;
}

function lookup(
  locale: Locale,
  id: MessageId,
  category: PluralCategory,
): string | undefined {
  const catalog: Readonly<Record<string, Message>> | undefined =
    Object.hasOwn(catalogs, locale) ? catalogs[locale] : undefined;
  const message: Message | undefined = catalog?.[id];
  if (message === undefined) {
    return undefined;
  }
  if (typeof message === 'string') {
    return message;
  }
  return message[category] ?? message['other'];
}

function interpolate(
  template: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate `id` in the active locale. `{name}` placeholders fill from
 * `params`; plural messages select their form with
 * `Intl.PluralRules(locale).select(count)` when `params.count` is a
 * number. A missing entry falls back to `en`, then to the id itself —
 * this never returns `undefined`.
 */
export function t(
  id: MessageId,
  params?: Readonly<Record<string, string | number>>,
): string {
  const count = params === undefined ? undefined : params['count'];
  const category: PluralCategory =
    typeof count === 'number' ? pluralCategory(current, count) : 'other';
  const template =
    lookup(current, id, category) ??
    lookup(SYSTEM_LOCALE, id, category) ??
    id;
  return interpolate(template, params);
}
