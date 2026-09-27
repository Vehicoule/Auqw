export * from './view-models.ts';

export * from './peaks.ts';
export * from './waveform.ts';

export * as fixtures from './fixtures.ts';

export {
  fromTag,
  getLocale,
  resolveLocale,
  setLocale,
  systemLocaleTag,
  t,
} from './i18n.ts';
export type {
  Locale,
  Message,
  MessageId,
  PluralCategory,
} from './i18n.ts';
