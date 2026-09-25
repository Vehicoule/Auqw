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

/** `Bearer x` / `Basic x` anywhere — no length floor on `x`. */
const CREDENTIAL = /\b(Bearer|Basic)(\s+)([^\s;,]+)/gi;

/**
 * `Token x` / `ApiKey x` outside a header. Unlike Bearer these are
 * ordinary English words too, so the value has to look token-ish before
 * anything is masked.
 */
const LOOSE_CREDENTIAL =
  /\b(Token|ApiKey)(\s+)([A-Za-z0-9._~+/=-]{2,})/gi;

/**
 * `token=…`, `api_key=…`, `session: …` — the key name says what it is,
 * so the value goes without guessing at its shape. The keyword must end
 * the key (`\b`), or `author:` would read as `auth`.
 */
const KEYED_SECRET =
  /\b[A-Za-z0-9_-]*(?:signature|authorization|password|passwd|token|secret|pwd|api_key|apikey|auth|sig|session|cookie)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;

/** Long key-shaped runs: 20+ chars of key charset. */
const OPAQUE_RUN = /[A-Za-z0-9+/_-]{20,}/g;

function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const head = cut === -1 ? url : url.slice(0, cut);
  const withoutUserinfo = head.replace(/\/\/[^/@]*@/, '//…@');
  return cut === -1 ? withoutUserinfo : `${withoutUserinfo}?…`;
}

export function redactSensitive(text: string): string {
  return text
    .replace(URL_LIKE, redactUrl)
    .replace(HEADER_SECRET, (_m: string, name: string, sep: string) => `${name}${sep}…`)
    .replace(CREDENTIAL, (_m: string, scheme: string, gap: string) => `${scheme}${gap}…`)
    .replace(
      LOOSE_CREDENTIAL,
      (_m: string, scheme: string, gap: string, value: string) =>
        /\d|[_+/=-]/.test(value) ? `${scheme}${gap}…` : `${scheme}${gap}${value}`,
    )
    .replace(KEYED_SECRET, (_m: string, sep: string) => `${sep}…`)
    .replace(OPAQUE_RUN, (run: string) =>
      // A `/` means a filesystem location, not a credential: a startup
      // failure's single most useful fact is which file it died on, so
      // paths are never masked however long or digit-bearing they are.
      // Digit-bearing key-shaped runs without a slash are masked.
      run.includes('/') || !/\d|[_+-]/.test(run) ? run : '…',
    );
}
