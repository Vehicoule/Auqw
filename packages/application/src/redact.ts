// Mask credential-shaped text before it reaches a local log.
//
// The house rule is "no tokens, cookies, signed URLs, or response bodies
// in logs", and a fatal startup error is exactly where one turns up
// uninvited — a request URL carrying a signed query, an Authorization
// header echoed into a message, a token interpolated into a string.
//
// This is pattern masking, not a proof. It catches the shapes
// credentials actually take; an arbitrary opaque secret with no
// recognisable shape is still invisible to it. Callers therefore bound
// the length as well, and should prefer a typed error's `kind` over free
// text when either would do. Masked spans collapse to `…` so the shape
// of the failure survives — the point is to lose the secret, not the
// diagnosis.

/** Any scheme's URL, not just http(s): `ws://`, `wss://`, `file://`. */
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi;

/**
 * Header-style secrets. The value runs to the end of the line, because
 * that is what a header carries — masking only the first word would
 * leave `Bearer abc123` or the tail of a cookie list behind.
 */
const HEADER_SECRET =
  /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|X-Amz-Security-Token)(\s*:\s*)[^\r\n]*/gi;

/**
 * Bare auth schemes. Case-insensitive and with no length floor:
 * `bearer abc123` and `Token abc` are credentials whatever their case
 * or length. The cost is that prose which merely mentions a scheme word
 * gets its next word masked — "the token was set" reads "the token …
 * set". That is the right way round: over-masking a log line is
 * cosmetic, under-masking one is a leak, and only one of those is a
 * security failure.
 */
const CREDENTIAL =
  /\b(Bearer|Basic|Token|ApiKey|OAuth|Negotiate|Digest|DPoP|HOBA)(\s+)("[^"]*"|'[^']*'|[^\s;,]+)/gi;

/**
 * `key=value` / `key: value`; the key decides whether it is a secret.
 * The key may itself be quoted — `{"token":"abc"}` in a JSON fragment
 * carries the same credential a bare `token=abc` does.
 */
const KEYED =
  /("([^"\n]{1,128})"|'([^'\n]{1,128})'|\b[A-Za-z0-9_-]{1,128})(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;

/** Long key-shaped runs: 20+ chars of key charset. */
const OPAQUE_RUN = /[A-Za-z0-9+/_-]{20,}/g;

/**
 * Secret key names, matched as whole segments of the key or as its
 * suffix. Segment-aware on purpose: `access_token_v2` carries `token`
 * as a segment and is a credential, while `author` merely starts with
 * `auth` and is not.
 */
const SECRET_KEYWORDS = [
  'signature',
  'authorization',
  'password',
  'passwd',
  'token',
  'secret',
  'pwd',
  'apikey',
  'api_key',
  'auth',
  'sig',
  'session',
  'cookie',
] as const;

function looksLikeSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  // `api-key` and `api_key` are the same name — squash separators for
  // the suffix test so either spelling still lands.
  const squashed = lower.replace(/[-_]/g, '');
  return (
    lower.split(/[_-]/).some((part) =>
      (SECRET_KEYWORDS as readonly string[]).includes(part),
    ) ||
    SECRET_KEYWORDS.some((keyword) =>
      squashed.endsWith(keyword.replace(/[-_]/g, '')),
    )
  );
}

function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const head = cut === -1 ? url : url.slice(0, cut);
  const withoutUserinfo = head.replace(/\/\/[^/@]*@/, '//…@');
  return cut === -1 ? withoutUserinfo : `${withoutUserinfo}?…`;
}

/**
 * `/` is the one signal that separates a filesystem location from a
 * base64 key — both contain it, and losing the failing file's path from
 * a startup log costs more than the reverse. So a slash-bearing run is
 * kept only when the surrounding text says "path": it starts one
 * (`/Users/…`) or carries a file extension after it (`…state-2024.db`).
 */
function isPathContext(run: string, offset: number, whole: string): boolean {
  if (!run.includes('/')) return false;
  const before = offset > 0 ? whole[offset - 1] : undefined;
  const tail = whole.slice(offset + run.length);
  // A leading `/` alone proves nothing — a base64 run starts with one
  // about 1/64 of the time — so a self-starting absolute path must
  // continue past its first segment. `~` before the run is a home
  // path, and a file extension right after it ends one.
  return (
    (run.startsWith('/') && run.indexOf('/', 1) > 0) ||
    before === '~' ||
    /^\.[A-Za-z0-9]{1,8}\b/.test(tail)
  );
}

export function redactSensitive(text: string): string {
  return text
    .replace(URL_LIKE, redactUrl)
    .replace(HEADER_SECRET, (_m: string, name: string, sep: string) => `${name}${sep}…`)
    .replace(CREDENTIAL, (_m: string, scheme: string, gap: string) => `${scheme}${gap}…`)
    .replace(
      KEYED,
      (
        match: string,
        keyToken: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        sep: string,
      ) =>
        looksLikeSecretKey(doubleQuoted ?? singleQuoted ?? keyToken)
          ? `${keyToken}${sep}…`
          : match,
    )
    .replace(
      OPAQUE_RUN,
      (run: string, offset: number, whole: string) =>
        isPathContext(run, offset, whole) || !/\d|[_+-]/.test(run) ? run : '…',
    );
}
