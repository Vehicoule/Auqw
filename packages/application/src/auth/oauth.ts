/**
 * Google OAuth 2.0 device flow + refresh grant — the shared protocol
 * core both apps run (mobile directly, desktop inside its utility
 * process since the renderer CSP admits no remote connect-src). The
 * surface is deliberately narrow: `postForm` is the only HTTP seam,
 * every endpoint reply is shape-validated and bounded, and no token
 * material ever appears in an error message (OAuth `error` slugs are
 * protocol constants — safe to carry; `error_description` is not).
 *
 * Protocol values are the RFC 8628 device flow + the OAuth2 token
 * endpoint; the default client is the embedded YouTube-on-TV device-
 * flow client (`docs/decisions.md` records provenance + the reopen
 * condition). A `client_secret` may accompany a user-supplied
 * confidential client; the default public client sends none.
 */
import { appError, cancelledError, err, ok } from '../errors.ts';
import type { AppError, Result } from '../errors.ts';
import { isRecord } from '../domain.ts';
import type { CancellationSignal } from '../cancellation.ts';

export const OAUTH_DEVICE_CODE_URL =
  'https://oauth2.googleapis.com/device/code';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube';
export const OAUTH_DEVICE_GRANT =
  'urn:ietf:params:oauth:grant-type:device_code';
export const OAUTH_REFRESH_GRANT = 'refresh_token';
/** Reply fallback when `verification_url` is absent/malformed. */
export const OAUTH_VERIFICATION_URL = 'https://www.google.com/device';

/**
 * The YouTube-on-TV embedded device-flow client — the same public
 * client yt-dlp's youtube path uses (registered for the `youtube`
 * scope + device grant). Google requires this client's published
 * `client_secret` on `/token` even though it is not confidential —
 * the pair ships in yt-dlp/pytube source, so the default credential
 * carries both halves. The advanced `clientId`/`clientSecret`
 * override covers deployments that register their own.
 */
export const DEFAULT_OAUTH_CLIENT_ID =
  '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
export const DEFAULT_OAUTH_CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';

/**
 * The one HTTP seam — POST a form body, return the status + parsed
 * body. Implementations bound the body before parsing; a non-JSON or
 * oversized body resolves `body: null` rather than throwing.
 */
export interface OAuthHttp {
  postForm(
    url: string,
    pairs: Record<string, string>,
    req?: OAuthRequestOptions,
  ): Promise<Result<OAuthHttpResponse>>;
}

/**
 * Per-call bounds — every exchange is deadline-capped so a hung
 * endpoint can't stall a flow past its own expiry, and a flow's
 * cancellation aborts the in-flight request instead of leaving it
 * outstanding after dismissal.
 */
export type OAuthRequestOptions = {
  readonly timeoutMs?: number;
  readonly signal?: CancellationSignal;
};

export type OAuthHttpResponse = {
  readonly status: number;
  readonly body: unknown;
};

const OAUTH_BODY_CAP = 64 * 1024;

/**
 * The fetch seam's minimal surface — declared ambiently like
 * runtime-impls.ts (this package's own typecheck is lib-free; every
 * shipped runtime supplies `fetch`).
 */
export type OAuthFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal?: AbortSignalLike;
  },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

declare const fetch: OAuthFetch;

/**
 * Minimal abort surface — lib-free like the fetch declaration. A
 * runtime `AbortSignal` carries `addEventListener('abort', ...)`;
 * naming it here lets the fetch seam (and tests) observe the abort
 * instead of only polling `aborted`.
 */
export type AbortSignalLike = {
  readonly aborted: boolean;
  addEventListener?(name: 'abort', listener: () => void): void;
};
declare const AbortController: {
  new (): { readonly signal: AbortSignalLike; abort(): void };
};

declare const setTimeout: (
  callback: () => void,
  ms: number,
) => { unref?(): void };
declare const clearTimeout: (timer: unknown) => void;

export function createFetchOAuthHttp(
  fetchFn: OAuthFetch = fetch,
): OAuthHttp {
  return {
    async postForm(url, pairs, req) {
      const body = Object.entries(pairs)
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
        )
        .join('&');
      // One controller per request — the deadline and the caller's
      // cancellation signal both abort the same fetch, and the first
      // one to fire owns the cause: a deadline lapse is a timeout, a
      // caller dismissal is a cancellation — neither may wear the
      // network-failure kind the retry ladder treats as available.
      const timeoutMs = req?.timeoutMs;
      const ctrl =
        timeoutMs !== undefined || req?.signal !== undefined
          ? new AbortController()
          : null;
      let abortCause: 'timeout' | 'cancelled' | null = null;
      const off =
        req?.signal?.subscribe(() => {
          abortCause ??= 'cancelled';
          ctrl?.abort();
        }) ?? null;
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              abortCause ??= 'timeout';
              ctrl?.abort();
            }, timeoutMs)
          : null;
      try {
        let resp: { readonly status: number; text(): Promise<string> };
        try {
          resp = await fetchFn(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
            ...(ctrl !== null ? { signal: ctrl.signal } : {}),
          });
        } catch {
          if (abortCause === 'timeout') {
            return err(appError('timeout', 'oauth: request timed out'));
          }
          if (abortCause === 'cancelled') {
            return err(cancelledError());
          }
          return err(appError('unavailable', 'oauth: network failure'));
        }
        // The deadline must cover the BODY too — fetch resolves on
        // headers; a peer stalling the body would otherwise hang past
        // the timeout with no abort armed.
        const text = await resp.text().catch(() => null);
        // The abort may have landed mid-body — the swallowed rejection
        // must not read as a null-body ok, or a deadline lapse would
        // classify as 'unavailable' where 'timeout' stays retryable
        // and a dismissal as a server fault where it is user intent.
        if (abortCause === 'timeout') {
          return err(appError('timeout', 'oauth: request timed out'));
        }
        if (abortCause === 'cancelled') {
          return err(cancelledError());
        }
        if (text === null || text.length > OAUTH_BODY_CAP) {
          return ok({ status: resp.status, body: null });
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        return ok({ status: resp.status, body: parsed });
      } finally {
        if (timer !== null) {
          clearTimeout(timer);
        }
        off?.();
      }
    },
  };
}

// ------------------------------------------------------------------
// Reply shapes — bounded reads off an untrusted JSON body. Field caps
// mirror the seams they feed: access_token rides the host's 8192-char
// slot; user_code is printed on screen; device_code is a credential
// that lives only inside the in-flight flow record.
// ------------------------------------------------------------------

export type OAuthCredentials = {
  readonly clientId: string;
  /** Present only for a user-supplied confidential client. */
  readonly clientSecret?: string | null;
};

export type DeviceGrant = {
  /** Credential — never logged, never persisted. */
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly intervalMs: number;
  readonly expiresAtMs: number;
};

export type TokenGrant = {
  /** Credential — memory + host slot only, never persisted. */
  readonly accessToken: string;
  /** Present on device-grant completion; refresh exchanges don't rotate. */
  readonly refreshToken: string | null;
  readonly expiresAtMs: number;
};

/**
 * Terminal-vs-continuing poll answers, kept distinct for honest copy:
 * `denied`/`expired` get their own strings; transport failures stay
 * `err` Results so the caller's error machinery humanizes them.
 */
export type DevicePollVerdict =
  | { readonly type: 'pending' }
  | { readonly type: 'slowDown' }
  | { readonly type: 'granted'; readonly grant: TokenGrant }
  | { readonly type: 'denied' }
  | { readonly type: 'expired' };

function bounded(
  value: unknown,
  max: number,
): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max
    ? value
    : null;
}

function boundedInt(
  value: unknown,
  lo: number,
  hi: number,
): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= lo &&
    value <= hi
    ? value
    : null;
}

/** The OAuth `error` slug off a reply body — protocol constants only. */
function errorSlug(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const slug = body['error'];
  return typeof slug === 'string' && /^[a-z_]+$/.test(slug) && slug.length <= 64
    ? slug
    : null;
}

/** Non-2xx (or error-slugged) replies → the typed error the op returns. */
function endpointError(
  resp: OAuthHttpResponse,
  what: string,
): Result<never> {
  const slug = errorSlug(resp.body);
  if (slug !== null) {
    return err(appError('invalid-response', `oauth: ${what} ${slug}`));
  }
  return err(
    appError(
      'unavailable',
      `oauth: ${what} http ${resp.status}`,
    ),
  );
}

function readTokenGrant(body: unknown, now: number): TokenGrant | null {
  if (!isRecord(body)) {
    return null;
  }
  const accessToken = bounded(body['access_token'], 8192);
  if (accessToken === null) {
    return null;
  }
  // expires_in is advisory — absent replies get the documented 3600s
  // so expiry math stays well-formed rather than disabling refresh.
  const expiresIn = boundedInt(body['expires_in'], 1, 86_400) ?? 3_600;
  const refresh = bounded(body['refresh_token'], 4096);
  return {
    accessToken,
    refreshToken: refresh,
    expiresAtMs: now + expiresIn * 1_000,
  };
}

export interface OAuthClient {
  /** Start a device flow — the user-facing pair rides the grant. */
  beginDeviceFlow(
    creds: OAuthCredentials,
    req?: OAuthRequestOptions,
  ): Promise<Result<DeviceGrant>>;
  /**
   * One poll of the token endpoint against an in-flight grant.
   * Non-terminal protocol answers return verdicts; transport and
   * unexpected-terminal failures return `err`.
   */
  pollDeviceGrant(
    creds: OAuthCredentials,
    grant: DeviceGrant,
    req?: OAuthRequestOptions,
  ): Promise<Result<DevicePollVerdict>>;
  /** `grant_type=refresh_token` — `invalid_grant` maps to auth-expired. */
  refreshAccessToken(
    creds: OAuthCredentials,
    refreshToken: string,
    req?: OAuthRequestOptions,
  ): Promise<Result<TokenGrant>>;
}

export function createOAuthClient(deps: {
  readonly http: OAuthHttp;
  /** Wall clock — injected so tests pin expiry math. */
  readonly now?: () => number;
}): OAuthClient {
  const http = deps.http;
  const now = deps.now ?? (() => Date.now());

  function credentialPairs(
    creds: OAuthCredentials,
    pairs: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {
      ...pairs,
      client_id: creds.clientId,
    };
    // Only a user-supplied confidential client carries a secret; the
    // default public client sends none rather than an empty field.
    if (
      creds.clientSecret !== undefined &&
      creds.clientSecret !== null &&
      creds.clientSecret !== ''
    ) {
      out['client_secret'] = creds.clientSecret;
    }
    return out;
  }

  return {
    async beginDeviceFlow(creds, req) {
      const resp = await http.postForm(
        OAUTH_DEVICE_CODE_URL,
        {
          client_id: creds.clientId,
          scope: OAUTH_SCOPE,
        },
        req,
      );
      if (!resp.ok) {
        return resp;
      }
      const { status, body } = resp.value;
      if (status < 200 || status >= 300 || errorSlug(body) !== null) {
        return endpointError(resp.value, 'device/code');
      }
      if (!isRecord(body)) {
        return err(
          appError('invalid-response', 'oauth: malformed device reply'),
        );
      }
      const deviceCode = bounded(body['device_code'], 4096);
      const userCode = bounded(body['user_code'], 64);
      if (deviceCode === null || userCode === null) {
        return err(
          appError('invalid-response', 'oauth: malformed device reply'),
        );
      }
      const rawUrl = bounded(body['verification_url'], 512);
      // The reply rides TLS from oauth2.googleapis.com, but the URL
      // is what the user opens to type the code — pin it to a real
      // Google host anyway (no userinfo/port spoofing) so a mangled
      // reply can never send the user elsewhere.
      const urlHost =
        rawUrl !== null && rawUrl.startsWith('https://')
          ? (rawUrl.slice(8).split('/')[0]?.toLowerCase() ?? '')
          : '';
      const googleHost =
        urlHost !== '' &&
        !urlHost.includes('@') &&
        !urlHost.includes(':') &&
        (urlHost === 'google.com' || urlHost.endsWith('.google.com'));
      const verificationUrl =
        googleHost && rawUrl !== null ? rawUrl : OAUTH_VERIFICATION_URL;
      const expiresIn = boundedInt(body['expires_in'], 1, 86_400) ?? 1_800;
      const intervalS = boundedInt(body['interval'], 1, 300) ?? 5;
      return ok({
        deviceCode,
        userCode,
        verificationUrl,
        intervalMs: intervalS * 1_000,
        expiresAtMs: now() + expiresIn * 1_000,
      });
    },

    async pollDeviceGrant(creds, grant, req) {
      const resp = await http.postForm(
        OAUTH_TOKEN_URL,
        credentialPairs(creds, {
          device_code: grant.deviceCode,
          grant_type: OAUTH_DEVICE_GRANT,
        }),
        req,
      );
      if (!resp.ok) {
        return resp;
      }
      const { status, body } = resp.value;
      const slug = errorSlug(body);
      if (slug === 'authorization_pending') {
        return ok({ type: 'pending' });
      }
      if (slug === 'slow_down') {
        return ok({ type: 'slowDown' });
      }
      if (slug === 'access_denied') {
        return ok({ type: 'denied' });
      }
      // `expired_token` is the poll's answer to a stale device code —
      // invalid_grant here means a malformed flow, equally terminal.
      if (slug === 'expired_token' || slug === 'invalid_grant') {
        return ok({ type: 'expired' });
      }
      if (
        status >= 200 &&
        status < 300 &&
        slug === null &&
        isRecord(body)
      ) {
        const grant = readTokenGrant(body, now());
        if (grant !== null) {
          return ok({ type: 'granted', grant });
        }
      }
      return endpointError(resp.value, 'token');
    },

    async refreshAccessToken(creds, refreshToken, req) {
      const resp = await http.postForm(
        OAUTH_TOKEN_URL,
        credentialPairs(creds, {
          refresh_token: refreshToken,
          grant_type: OAUTH_REFRESH_GRANT,
        }),
        req,
      );
      if (!resp.ok) {
        return resp;
      }
      const { status, body } = resp.value;
      const slug = errorSlug(body);
      if (status >= 200 && status < 300 && slug === null) {
        const grant = readTokenGrant(body, now());
        if (grant !== null) {
          // A rotated refresh_token rides the reply — RFC 6749 §6;
          // the session persists the replacement before applying.
          return ok(grant);
        }
      }
      // A dead grant (revoked, rotated, expired server-side) is
      // permanent — 'auth-expired' tells the caller to drop custody
      // rather than retry forever.
      if (slug === 'invalid_grant' || slug === 'unauthorized_client') {
        return err(
          appError('auth-expired', `oauth: refresh ${slug}`),
        );
      }
      return endpointError(resp.value, 'refresh');
    },
  };
}
