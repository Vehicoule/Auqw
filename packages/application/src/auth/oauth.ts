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
import { appError, err, ok } from '../errors.ts';
import type { AppError, Result } from '../errors.ts';
import { isRecord } from '../domain.ts';

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
  ): Promise<Result<OAuthHttpResponse>>;
}

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
type OAuthFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

declare const fetch: OAuthFetch;

export function createFetchOAuthHttp(
  fetchFn: OAuthFetch = fetch,
): OAuthHttp {
  return {
    async postForm(url, pairs) {
      const body = Object.entries(pairs)
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
        )
        .join('&');
      let resp: { readonly status: number; text(): Promise<string> };
      try {
        resp = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
      } catch {
        return err(appError('unavailable', 'oauth: network failure'));
      }
      // Device-flow errors answer HTTP 400 with a JSON `error` body —
      // parse before judging so pending/denied/expired surface
      // distinctly instead of collapsing into a bare status.
      const text = await resp.text().catch(() => null);
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
  ): Promise<Result<DeviceGrant>>;
  /**
   * One poll of the token endpoint against an in-flight grant.
   * Non-terminal protocol answers return verdicts; transport and
   * unexpected-terminal failures return `err`.
   */
  pollDeviceGrant(
    creds: OAuthCredentials,
    grant: DeviceGrant,
  ): Promise<Result<DevicePollVerdict>>;
  /** `grant_type=refresh_token` — `invalid_grant` maps to auth-expired. */
  refreshAccessToken(
    creds: OAuthCredentials,
    refreshToken: string,
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
    async beginDeviceFlow(creds) {
      const resp = await http.postForm(OAUTH_DEVICE_CODE_URL, {
        client_id: creds.clientId,
        scope: OAUTH_SCOPE,
      });
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
      const verificationUrl =
        rawUrl !== null && rawUrl.startsWith('https://')
          ? rawUrl
          : OAUTH_VERIFICATION_URL;
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

    async pollDeviceGrant(creds, grant) {
      const resp = await http.postForm(
        OAUTH_TOKEN_URL,
        credentialPairs(creds, {
          device_code: grant.deviceCode,
          grant_type: OAUTH_DEVICE_GRANT,
        }),
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

    async refreshAccessToken(creds, refreshToken) {
      const resp = await http.postForm(
        OAUTH_TOKEN_URL,
        credentialPairs(creds, {
          refresh_token: refreshToken,
          grant_type: OAUTH_REFRESH_GRANT,
        }),
      );
      if (!resp.ok) {
        return resp;
      }
      const { status, body } = resp.value;
      const slug = errorSlug(body);
      if (status >= 200 && status < 300 && slug === null) {
        const grant = readTokenGrant(body, now());
        if (grant !== null) {
          // Refresh replies never carry a new refresh_token — the
          // stored grant stays authoritative.
          return ok({ ...grant, refreshToken: null });
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
