/**
 * The protocol client against a scripted `OAuthHttp` — no live Google
 * calls. Covers: device-code parsing (fallback verification URL,
 * malformed replies), the poll verdict ladder (pending → slow_down →
 * granted/denied/expired), refresh verdicts (invalid_grant →
 * auth-expired), and the two hygiene invariants — the secret only
 * ships with a confidential client, and `error_description` never
 * reaches an error message.
 */
import { appError, err, ok } from '../errors.ts';
import { assert, assertEqual } from '../testing/assert.ts';
import { createOAuthClient } from './oauth.ts';
import type { OAuthHttpResponse } from './oauth.ts';
import type { OAuthHttp } from './oauth.ts';

const CREDS = { clientId: 'test-client' } as const;

type Posted = { url: string; pairs: Record<string, string> };

function scriptedHttp(
  steps: readonly ({ status: number; body: unknown } | Error)[],
): { http: OAuthHttp; calls: Posted[] } {
  const calls: Posted[] = [];
  let i = 0;
  return {
    calls,
    http: {
      postForm(url, pairs) {
        calls.push({ url, pairs });
        const step = i < steps.length ? steps[i++] : undefined;
        if (step === undefined) {
          return Promise.resolve(
            err(appError('internal', 'oauth: unscripted call')),
          );
        }
        if (step instanceof Error) {
          return Promise.resolve(
            err(appError('unavailable', 'oauth: network failure')),
          );
        }
        const resp: OAuthHttpResponse = { status: step.status, body: step.body };
        return Promise.resolve(ok(resp));
      },
    },
  };
}

async function testDeviceBegin(): Promise<void> {
  const { http, calls } = scriptedHttp([
    {
      status: 200,
      body: {
        device_code: 'dev-code-1',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://www.google.com/device',
        expires_in: 1_800,
        interval: 5,
      },
    },
  ]);
  const oauth = createOAuthClient({ http, now: () => 1_000 });
  const begun = await oauth.beginDeviceFlow(CREDS);
  assert(begun.ok, 'device begin failed');
  assertEqual(begun.value.userCode, 'ABCD-EFGH');
  assertEqual(begun.value.verificationUrl, 'https://www.google.com/device');
  assertEqual(begun.value.expiresAtMs, 1_000 + 1_800_000);
  assertEqual(begun.value.intervalMs, 5_000);
  assertEqual(calls.length, 1);
  assertEqual(calls[0]?.pairs['client_id'], 'test-client');
  assertEqual(calls[0]?.pairs['scope'], 'https://www.googleapis.com/auth/youtube');
}

async function testDeviceBeginFallbackUrl(): Promise<void> {
  // A downgraded/absent verification_url falls back — the sheet must
  // never render (or open) a non-HTTPS link from a reply.
  for (const verification_url of [
    'http://evil.example/x',
    undefined,
    42,
  ] as const) {
    const { http } = scriptedHttp([
      {
        status: 200,
        body: {
          device_code: 'd',
          user_code: 'U',
          ...(verification_url === undefined
            ? {}
            : { verification_url }),
          expires_in: 60,
          interval: 1,
        },
      },
    ]);
    const oauth = createOAuthClient({ http, now: () => 0 });
    const begun = await oauth.beginDeviceFlow(CREDS);
    assert(begun.ok, 'begin should succeed with fallback url');
    assertEqual(begun.value.verificationUrl, 'https://www.google.com/device');
  }
}

async function testDeviceBeginMalformed(): Promise<void> {
  for (const body of [
    null,
    { device_code: 'd' },
    { device_code: 'd', user_code: '' },
    { device_code: 'x'.repeat(5000), user_code: 'u' },
  ]) {
    const { http } = scriptedHttp([{ status: 200, body }]);
    const oauth = createOAuthClient({ http, now: () => 0 });
    const begun = await oauth.beginDeviceFlow(CREDS);
    assert(!begun.ok, `malformed device reply accepted: ${JSON.stringify(body)}`);
    assertEqual(begun.error.kind, 'invalid-response');
  }
  // Error-slugged replies (e.g. invalid_client) surface typed.
  const { http } = scriptedHttp([
    { status: 401, body: { error: 'unauthorized_client' } },
  ]);
  const oauth = createOAuthClient({ http, now: () => 0 });
  const begun = await oauth.beginDeviceFlow(CREDS);
  assert(!begun.ok);
  assertEqual(begun.error.kind, 'invalid-response');
}

async function testPollLadder(): Promise<void> {
  const grant = {
    deviceCode: 'dev-code',
    userCode: 'U',
    verificationUrl: 'https://www.google.com/device',
    intervalMs: 1_000,
    expiresAtMs: 60_000,
  };
  const cases = [
    [{ error: 'authorization_pending' }, 'pending'],
    [{ error: 'slow_down' }, 'slowDown'],
    [{ error: 'access_denied' }, 'denied'],
    [{ error: 'expired_token' }, 'expired'],
    [{ error: 'invalid_grant' }, 'expired'],
  ] as const;
  for (const [body, want] of cases) {
    const { http } = scriptedHttp([{ status: 400, body }]);
    const oauth = createOAuthClient({ http, now: () => 0 });
    const verdict = await oauth.pollDeviceGrant(CREDS, grant);
    assert(verdict.ok, `poll for ${JSON.stringify(body)} errored`);
    assertEqual(verdict.value.type, want);
  }
}

async function testPollGranted(): Promise<void> {
  const grant = {
    deviceCode: 'dev-code',
    userCode: 'U',
    verificationUrl: 'https://www.google.com/device',
    intervalMs: 1_000,
    expiresAtMs: 60_000,
  };
  const { http, calls } = scriptedHttp([
    {
      status: 200,
      body: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3_600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/youtube',
      },
    },
  ]);
  const oauth = createOAuthClient({ http, now: () => 5_000 });
  const verdict = await oauth.pollDeviceGrant(CREDS, grant);
  assert(verdict.ok && verdict.value.type === 'granted', 'grant expected');
  const token = verdict.value.grant;
  assertEqual(token.accessToken, 'access-1');
  assertEqual(token.refreshToken, 'refresh-1');
  assertEqual(token.expiresAtMs, 5_000 + 3_600_000);
  // The device grant rides the token endpoint with the flow's
  // credentials — never a scope or a second secret.
  assertEqual(
    calls[0]?.pairs['grant_type'],
    'urn:ietf:params:oauth:grant-type:device_code',
  );
  assertEqual(calls[0]?.pairs['device_code'], 'dev-code');
}

async function testPollNoErrorDescriptionLeak(): Promise<void> {
  // RFC 6749 error_description is provider prose — potentially
  // hostile; the slug is a protocol constant and the only field that
  // may reach a message.
  const { http } = scriptedHttp([
    {
      status: 400,
      body: {
        error: 'quota_project_not_found',
        error_description: 'token abc123 leak https://x.test/?secret=zzz',
      },
    },
  ]);
  const oauth = createOAuthClient({ http, now: () => 0 });
  const verdict = await oauth.pollDeviceGrant(CREDS, {
    deviceCode: 'd',
    userCode: 'u',
    verificationUrl: 'https://www.google.com/device',
    intervalMs: 1_000,
    expiresAtMs: 60_000,
  });
  assert(!verdict.ok, 'unknown slug should be an error');
  assert(
    !verdict.error.message.includes('abc123') &&
      !verdict.error.message.includes('secret=zzz'),
    `error_description leaked: ${verdict.error.message}`,
  );
}

async function testRefresh(): Promise<void> {
  const { http, calls } = scriptedHttp([
    {
      status: 200,
      body: {
        access_token: 'access-2',
        expires_in: 3_600,
        // RFC 6749 §6 rotation — the replacement grant is preserved;
        // the session layer persists it before the next renewal.
        refresh_token: 'rotated-2',
      },
    },
  ]);
  const oauth = createOAuthClient({ http, now: () => 9_000 });
  const refreshed = await oauth.refreshAccessToken(CREDS, 'refresh-1');
  assert(refreshed.ok, 'refresh failed');
  assertEqual(refreshed.value.accessToken, 'access-2');
  assertEqual(refreshed.value.refreshToken, 'rotated-2');
  assertEqual(calls[0]?.pairs['grant_type'], 'refresh_token');
  assertEqual(calls[0]?.pairs['refresh_token'], 'refresh-1');
}

async function testRefreshDeadGrant(): Promise<void> {
  for (const slug of ['invalid_grant', 'unauthorized_client']) {
    const { http } = scriptedHttp([{ status: 400, body: { error: slug } }]);
    const oauth = createOAuthClient({ http, now: () => 0 });
    const refreshed = await oauth.refreshAccessToken(CREDS, 'dead');
    assert(!refreshed.ok);
    assertEqual(
      refreshed.error.kind,
      'auth-expired',
      `${slug} must map to auth-expired`,
    );
  }
  // A transport/unknown failure stays retryable — the grant may be
  // fine; the session re-arms rather than dropping custody.
  const { http } = scriptedHttp([
    { status: 500, body: { error: 'internal_failure' } },
  ]);
  const oauth = createOAuthClient({ http, now: () => 0 });
  const refreshed = await oauth.refreshAccessToken(CREDS, 'ok-token');
  assert(!refreshed.ok);
  assert(refreshed.error.kind !== 'auth-expired');
}

async function testClientSecret(): Promise<void> {
  const grant = {
    deviceCode: 'd',
    userCode: 'u',
    verificationUrl: 'https://www.google.com/device',
    intervalMs: 1_000,
    expiresAtMs: 60_000,
  };
  const { http, calls } = scriptedHttp([
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'authorization_pending' } },
  ]);
  const oauth = createOAuthClient({ http, now: () => 0 });
  // Public client — no secret field at all.
  await oauth.pollDeviceGrant(CREDS, grant);
  assert(!('client_secret' in (calls[0]?.pairs ?? {})), 'public client leaked a secret field');
  // Confidential override — the secret ships.
  await oauth.pollDeviceGrant(
    { clientId: 'custom', clientSecret: 'shh' },
    grant,
  );
  assertEqual(calls[1]?.pairs['client_secret'], 'shh');
  assertEqual(calls[1]?.pairs['client_id'], 'custom');
}

export async function run(): Promise<void> {
  await testDeviceBegin();
  await testDeviceBeginFallbackUrl();
  await testDeviceBeginMalformed();
  await testPollLadder();
  await testPollGranted();
  await testPollNoErrorDescriptionLeak();
  await testRefresh();
  await testRefreshDeadGrant();
  await testClientSecret();
}
