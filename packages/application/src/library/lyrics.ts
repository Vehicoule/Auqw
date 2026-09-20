import { isSafeNonNegative } from '../domain.ts';
import type {
  LyricsLine,
  LyricsMatch,
  LyricsResult,
} from '../ports/provider.ts';
import type { LyricsCacheEntry } from './library.ts';

/**
 * The app-side lyrics acceptance filter and cache mapping
 * (providers.md, slice 2): a matched upstream record must sit within
 * `LYRICS_DURATION_DRIFT_MS` of the recording's duration, synced lines
 * must carry strictly increasing timestamps, `instrumental` carries
 * no text, and a plain record is never presented as synced. Honest
 * absence always beats wrong text — a drifted record is rejected
 * wholesale, while a structurally unusable synced record degrades to
 * plain only on the words it actually carries.
 */
export const LYRICS_DURATION_DRIFT_MS = 5_000;

function hasText(text: string): boolean {
  return /\S/.test(text);
}

/** A record's duration evidence contradicts the recording's own. */
function drifted(
  matched: LyricsMatch | null,
  durationMs: number | null,
): boolean {
  const matchedMs = matched?.durationMs ?? null;
  return (
    matchedMs !== null &&
    durationMs !== null &&
    isSafeNonNegative(matchedMs) &&
    isSafeNonNegative(durationMs) &&
    Math.abs(matchedMs - durationMs) > LYRICS_DURATION_DRIFT_MS
  );
}

/**
 * Timed lines usable as synced lyrics: every line well-formed
 * (safe nonnegative `tMs`, string text) and timestamps strictly
 * increasing — equal timestamps are ambiguous for line-at-a-time
 * presentation and count as non-monotonic.
 */
function isValidSyncedLines(lines: readonly LyricsLine[]): boolean {
  if (lines.length === 0) {
    return false;
  }
  let prev = -1;
  for (const line of lines) {
    if (
      typeof line.text !== 'string' ||
      !isSafeNonNegative(line.tMs) ||
      line.tMs <= prev
    ) {
      return false;
    }
    prev = line.tMs;
  }
  return true;
}

/** The untimed words a synced record still honestly carries. */
function joinedText(lines: readonly LyricsLine[]): string {
  return lines.map((line) => line.text).join('\n');
}

/**
 * Maps a provider lyrics result to the result the app honestly
 * serves. `durationMs` is the recording's own duration (nullable):
 * the drift rule fires only when both durations are known — an
 * absent duration is never evidence against a record.
 *
 * Rejection kinds: a `drifted` record is wrong regardless of form,
 * so synced, plain, and instrumental all collapse to `unavailable`
 * (the words of a wrong record are wrong text, not a downgrade). A
 * synced record whose *timing* fails — empty line set, malformed or
 * non-increasing timestamps — degrades to `plain` on the words its
 * lines carry, or `unavailable` when it carries none. Plain requires
 * only non-empty text and is never upgraded to synced; `unavailable`
 * passes through untouched.
 */
export function applyAcceptance(
  result: LyricsResult,
  context: { durationMs: number | null },
): LyricsResult {
  if (result.kind === 'unavailable') {
    return result;
  }
  if (drifted(result.matched, context.durationMs)) {
    return { kind: 'unavailable', matched: result.matched };
  }
  switch (result.kind) {
    case 'instrumental':
      // The wire shape carries no text on instrumental; the flag is
      // honored as reported.
      return result;
    case 'plain':
      return hasText(result.text)
        ? result
        : { kind: 'unavailable', matched: result.matched };
    case 'synced': {
      if (isValidSyncedLines(result.lines)) {
        return result;
      }
      const text = joinedText(result.lines);
      return hasText(text)
        ? { kind: 'plain', text, matched: result.matched }
        : { kind: 'unavailable', matched: result.matched };
    }
  }
}

// ---- LRC text (cache storage form) ------------------------------------

const MAX_LRC_LINE_TEXT = 1024;

/**
 * One `mm:ss[.frac]` LRC time tag → milliseconds, or null when the
 * tag is not a timestamp. Fraction digits scale to milliseconds
 * (`.5` is 500 ms); digits past the third truncate.
 */
function parseLrcTimestamp(tag: string): number | null {
  const colon = tag.indexOf(':');
  if (colon < 0) {
    return null;
  }
  const minPart = tag.slice(0, colon).trim();
  const rest = tag.slice(colon + 1);
  const dot = rest.indexOf('.');
  const secPart = (dot < 0 ? rest : rest.slice(0, dot)).trim();
  const fracPart = dot < 0 ? '' : rest.slice(dot + 1).trim();
  if (!/^\d+$/.test(minPart) || !/^\d+$/.test(secPart)) {
    return null;
  }
  let ms = 0;
  if (fracPart.length > 0) {
    if (!/^\d+$/.test(fracPart)) {
      return null;
    }
    ms = Number.parseInt((fracPart + '000').slice(0, 3), 10);
  }
  const tMs =
    Number.parseInt(minPart, 10) * 60_000 +
    Number.parseInt(secPart, 10) * 1_000 +
    ms;
  return isSafeNonNegative(tMs) ? tMs : null;
}

/**
 * Parses LRC text into timed lines: leading `[mm:ss.xx]` tags stamp
 * the line, metadata tags (`[ti:]`, `[ar:]`, …) drop, the first
 * `[offset:±ms]` tag shifts every later timestamp (clamped at zero),
 * and a multi-stamped line emits one line per stamp. Untimed lines
 * contribute nothing; output is stable-sorted by `tMs`. Line text is
 * capped at the wire's 1024 characters.
 */
export function parseLrc(text: string): LyricsLine[] {
  let offsetMs = 0;
  const out: LyricsLine[] = [];
  for (const line of text.split('\n')) {
    let rest = line;
    const stamps: number[] = [];
    for (;;) {
      const tagMatch = /^\[([^\]]*)\]/.exec(rest);
      if (tagMatch === null) {
        break;
      }
      const tag = (tagMatch[1] ?? '').trim();
      if (/^\d/.test(tag)) {
        const ms = parseLrcTimestamp(tag);
        if (ms !== null) {
          stamps.push(ms);
        }
      } else if (/^offset:/i.test(tag)) {
        const value = tag.slice(tag.indexOf(':') + 1).trim();
        if (/^[+-]?\d+$/.test(value)) {
          offsetMs = Number.parseInt(value, 10);
        }
      }
      rest = rest.slice(tagMatch[0].length);
    }
    if (stamps.length === 0) {
      continue;
    }
    const lineText = [...rest.trim()].slice(0, MAX_LRC_LINE_TEXT).join('');
    for (const stamp of stamps) {
      const tMs = stamp + offsetMs;
      out.push({ tMs: tMs < 0 ? 0 : tMs, text: lineText });
    }
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/**
 * Serializes timed lines to `[mm:ss.xxx]` LRC — the storage form the
 * lyrics cache carries. Embedded newlines flatten to spaces so one
 * line can never smuggle extra records; round-trips through
 * {@link parseLrc} preserve `tMs` exactly.
 */
export function linesToLrc(lines: readonly LyricsLine[]): string {
  return lines
    .map((line) => {
      const tMs = Math.max(0, Math.floor(line.tMs));
      const minutes = Math.floor(tMs / 60_000);
      const seconds = Math.floor((tMs % 60_000) / 1_000);
      const millis = tMs % 1_000;
      const stamp =
        `[${String(minutes).padStart(2, '0')}:` +
        `${String(seconds).padStart(2, '0')}.` +
        `${String(millis).padStart(3, '0')}]`;
      return stamp + line.text.replace(/[\r\n]+/g, ' ');
    })
    .join('\n');
}

// ---- lyrics cache -------------------------------------------------------

/**
 * The cacheable form of an *accepted* result. `unavailable` is never
 * cached — absence stays refetchable. `instrumental` has no dedicated
 * cache kind; it persists as a `plain`-kind entry carrying only the
 * flag, the honest encoding the schema allows. A synced entry stores
 * the LRC text plus the joined plain text alongside.
 */
export function lyricsCacheEntry(
  recordingId: string,
  provider: string,
  accepted: LyricsResult,
  fetchedMs: number,
): LyricsCacheEntry | null {
  switch (accepted.kind) {
    case 'unavailable':
      return null;
    case 'instrumental':
      return {
        recordingId,
        provider,
        kind: 'plain',
        payload: {
          plainLyrics: null,
          syncedLyrics: null,
          instrumental: true,
        },
        fetchedMs,
      };
    case 'plain':
      return {
        recordingId,
        provider,
        kind: 'plain',
        payload: {
          plainLyrics: accepted.text,
          syncedLyrics: null,
          instrumental: false,
        },
        fetchedMs,
      };
    case 'synced': {
      const text = joinedText(accepted.lines);
      return {
        recordingId,
        provider,
        kind: 'synced',
        payload: {
          plainLyrics: hasText(text) ? text : null,
          syncedLyrics: linesToLrc(accepted.lines),
          instrumental: false,
        },
        fetchedMs,
      };
    }
  }
}

/**
 * Rebuilds the honest result a cache entry stands for. The same
 * acceptance rules re-run — a cached synced must still parse and
 * order, degrading to its stored plain text or `unavailable`; a
 * cached plain stays plain and is never promoted. `instrumental`
 * wins over any stray text: the flag's claim is the conservative
 * read.
 */
export function lyricsFromCache(
  entry: LyricsCacheEntry,
  context: { durationMs: number | null },
): LyricsResult {
  const payload = entry.payload;
  if (payload.instrumental) {
    return { kind: 'instrumental', matched: null };
  }
  if (entry.kind === 'synced' && payload.syncedLyrics !== null) {
    const accepted = applyAcceptance(
      {
        kind: 'synced',
        lines: parseLrc(payload.syncedLyrics),
        matched: null,
      },
      context,
    );
    if (accepted.kind !== 'unavailable') {
      return accepted;
    }
  }
  if (payload.plainLyrics !== null && hasText(payload.plainLyrics)) {
    return { kind: 'plain', text: payload.plainLyrics, matched: null };
  }
  return { kind: 'unavailable', matched: null };
}

// ---- session result -----------------------------------------------------

/**
 * What the Now-Playing lyrics sheet renders: the accepted kind plus
 * its payload and provenance evidence — which provider produced the
 * record, when it was fetched, and whether it came off the disposable
 * cache (whose `matched` evidence is not persisted).
 */
export type LyricsSheet =
  | {
    readonly kind: 'synced';
    readonly lines: readonly LyricsLine[];
    readonly matched: LyricsMatch | null;
    readonly provider: string;
    readonly fetchedMs: number | null;
    readonly cached: boolean;
  }
  | {
    readonly kind: 'plain';
    readonly text: string;
    readonly matched: LyricsMatch | null;
    readonly provider: string;
    readonly fetchedMs: number | null;
    readonly cached: boolean;
  }
  | {
    readonly kind: 'instrumental';
    readonly matched: LyricsMatch | null;
    readonly provider: string;
    readonly fetchedMs: number | null;
    readonly cached: boolean;
  }
  | {
    readonly kind: 'unavailable';
    readonly matched: LyricsMatch | null;
    readonly provider: string;
    readonly fetchedMs: number | null;
    readonly cached: boolean;
  };

/** Shapes an accepted result for the sheet, preserving evidence. */
export function lyricsSheet(
  accepted: LyricsResult,
  source: {
    provider: string;
    fetchedMs: number | null;
    cached: boolean;
  },
): LyricsSheet {
  switch (accepted.kind) {
    case 'synced':
      return {
        kind: 'synced',
        lines: accepted.lines,
        matched: accepted.matched,
        ...source,
      };
    case 'plain':
      return {
        kind: 'plain',
        text: accepted.text,
        matched: accepted.matched,
        ...source,
      };
    case 'instrumental':
      return { kind: 'instrumental', matched: accepted.matched, ...source };
    case 'unavailable':
      return { kind: 'unavailable', matched: accepted.matched, ...source };
  }
}
