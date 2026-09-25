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

/** `https://user:pass@host/path?sig=…` keeps host+path, loses the rest. */
const URL_LIKE = /https?:\/\/[^\s]*/g;

/** `Bearer x`, `Basic x`, `Token x`, `ApiKey x`. */
const CREDENTIAL = /\b(?:Bearer|Basic|Token|ApiKey)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `token=…`, `Authorization: …`, `api_key=…` — a key whose name says
 * what it is, so the value can go without guessing at its shape.
 */
const KEYED_SECRET =
  /\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|authorization|signature|sig|cookie|session)[A-Za-z0-9_-]*(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;

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
    .replace(CREDENTIAL, '…')
    .replace(KEYED_SECRET, (_match: string, sep: string) => `${sep}…`)
    .replace(OPAQUE_RUN, (run: string) =>
      // A digit or a key separator is what sets a credential apart from
      // `createSecureStore` or a file path: long plain words and paths
      // survive so the message stays readable. `/` is deliberately not
      // a trigger — base64 keys and filesystem paths both contain it,
      // and mangling every path in a startup log costs more than the
      // occasional `/`-bearing key is worth.
      /\d|[_+-]/.test(run) ? '…' : run,
    );
}
