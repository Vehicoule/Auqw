/**
 * `createAuthSession` against faked custody/oauth/clock — the whole
 * lifecycle without a network: boot restore, device sign-in (grant,
 * denial, expiry, cancellation, missing refresh_token), custody
 * round-trips and corruption, sign-out ordering (host slot cleared
 * before custody), the client-id override's persistence across
 * sign-out, and the expiry renew lane (success, transient backoff,
 * revoked-grant drop). No token material is asserted into messages.
 */
import { appError, err, ok } from '../errors.ts';
import type { AppError, Result } from '../errors.ts';
import type { CancellationSignal } from '../cancellation.ts';
import { assert, assertDeepEqual, assertEqual } from '../testing/assert.ts';
import {
  EMPTY_AUTH_CUSTODY,
  createAuthSession,
  isAuthCustodyRecord,
} from './session.ts';
import type {
  AuthClock,
  AuthCustody,
  AuthCustodyRecord,
  AuthPendingFlow,
  AuthSnapshot,
} from './session.ts';
import type {
  DeviceGrant,
  DevicePollVerdict,
  OAuthClient,
  OAuthCredentials,
  TokenGrant,
} from './oauth.ts';

// ------------------------------------------------------------------
// Fakes
// ------------------------------------------------------------------

function fakeCustody(initial: AuthCustodyRecord | null | AppError) {
  const record: { current: AuthCustodyRecord | null } = {
    current: initial !== null && 'kind' in initial ? null : initial,
  };
  const reads = { value: initial };
  const writes: AuthCustodyRecord[] = [];
  let cleared = 0;
  const custody: AuthCustody = {
    read() {
      if (reads.value !== null && 'kind' in reads.value) {
        return Promise.resolve(err(reads.value));
      }
      return Promise.resolve(ok(record.current));
    },
    write(next) {
      writes.push(next);
      record.current = next;
      return Promise.resolve(ok(undefined));
    },
    clear() {
      cleared += 1;
      record.current = null;
      return Promise.resolve(ok(undefined));
    },
  };
  return { custody, record, writes, cleared: () => cleared };
}

type PollReply = Result<DevicePollVerdict>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeOAuth() {
  const calls: {
    kind: 'begin' | 'poll' | 'refresh';
    creds: OAuthCredentials;
  }[] = [];
  const begins: Result<DeviceGrant>[] = [];
  const polls: PollReply[] = [];
  const pollDeferreds: ReturnType<typeof deferred<PollReply>>[] = [];
  const refreshes: Result<TokenGrant>[] = [];
  const oauth: OAuthClient = {
    beginDeviceFlow(creds) {
      calls.push({ kind: 'begin', creds });
      const next = begins.shift();
      assert(next !== undefined, 'oauth: unscripted beginDeviceFlow');
      return Promise.resolve(next);
    },
    pollDeviceGrant(creds, _grant) {
      calls.push({ kind: 'poll', creds });
      const next = polls.shift();
      if (next !== undefined) {
        return Promise.resolve(next);
      }
      // Verdict exhaustion parks on a deferred — the test resolves it
      // (or cancels the flow) explicitly.
      const d = deferred<PollReply>();
      pollDeferreds.push(d);
      return d.promise;
    },
    refreshAccessToken(creds, _token) {
      calls.push({ kind: 'refresh', creds });
      const next = refreshes.shift();
      assert(next !== undefined, 'oauth: unscripted refreshAccessToken');
      return Promise.resolve(next);
    },
  };
  return { oauth, calls, begins, polls, pollDeferreds, refreshes };
}

function deviceGrant(over: Partial<DeviceGrant> = {}): DeviceGrant {
  return {
    deviceCode: 'dev-code',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://www.google.com/device',
    intervalMs: 1_000,
    expiresAtMs: 60_000,
    ...over,
  };
}

function tokenGrant(over: Partial<TokenGrant> = {}): TokenGrant {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: 3_610_000,
    ...over,
  };
}

function fakeClock(start = 0) {
  let now = start;
  const armed: { ms: number; fire: () => void }[] = [];
  const clock: AuthClock = {
    now: () => now,
    sleep(_ms, signal?: CancellationSignal) {
      return Promise.resolve(!(signal?.cancelled ?? false));
    },
    arm(ms, fire) {
      const entry = { ms, fire };
      armed.push(entry);
      let live = true;
      return () => {
        live = false;
        const i = armed.indexOf(entry);
        if (i >= 0) {
          armed.splice(i, 1);
        }
      };
    },
  };
  return {
    clock,
    armed,
    setNow: (v: number) => (now = v),
    fireNext() {
      const entry = armed.shift();
      assert(entry !== undefined, 'clock: nothing armed');
      entry.fire();
    },
  };
}

/** Pump microtasks until the session settles (poll chains + custody). */
async function flush(hops = 60): Promise<void> {
  for (let i = 0; i < hops; i++) {
    await Promise.resolve();
  }
}

function collector(session: {
  subscribe(l: () => void): () => void;
  snapshot(): AuthSnapshot;
}) {
  const seen: AuthSnapshot['status']['state'][] = [];
  session.subscribe(() => seen.push(session.snapshot().status.state));
  return seen;
}

// ------------------------------------------------------------------
// Custody record shape
// ------------------------------------------------------------------

function testCustodyValidator(): void {
  assert(isAuthCustodyRecord(EMPTY_AUTH_CUSTODY), 'empty record rejected');
  assert(
    isAuthCustodyRecord({
      v: 1,
      refreshToken: 'r',
      clientId: 'c',
      grantClientId: 'c',
    }),
    'full record rejected',
  );
  assert(
    isAuthCustodyRecord({
      v: 1,
      refreshToken: null,
      clientId: null,
      grantClientId: null,
      pendingFlow: {
        deviceCode: 'dev-code',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'https://www.google.com/device',
        intervalMs: 1_000,
        expiresAtMs: 60_000,
        clientId: 'client-1',
      },
    }),
    'pending-flow record rejected',
  );
  for (const bad of [
    null,
    { v: 1 },
    { v: 2, refreshToken: null, clientId: null },
    { v: 1, refreshToken: 'r' },
    { v: 1, refreshToken: 'r', clientId: 'c' },
    { v: 1, refreshToken: '', clientId: null },
    { v: 1, refreshToken: null, clientId: null, extra: 1 },
    { v: 1, refreshToken: 'x'.repeat(5000), clientId: null },
    {
      v: 1,
      refreshToken: null,
      clientId: null,
      grantClientId: null,
      pendingFlow: { deviceCode: 'dev-code' },
    },
    {
      v: 1,
      refreshToken: null,
      clientId: null,
      grantClientId: null,
      pendingFlow: 'dev-code',
    },
    {
      v: 1,
      refreshToken: null,
      clientId: null,
      grantClientId: null,
      pendingFlow: {
        deviceCode: 'dev-code',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'https://www.google.com/device',
        intervalMs: 1_000,
        expiresAtMs: 60_000,
        clientId: 'client-1',
        extra: 1,
      },
    },
  ]) {
    assert(
      !isAuthCustodyRecord(bad),
      `record accepted: ${JSON.stringify(bad)}`,
    );
  }
}

// ------------------------------------------------------------------
// Restore
// ------------------------------------------------------------------

async function testRestoreEmpty(): Promise<void> {
  const { custody } = fakeCustody(null);
  const { oauth, calls } = fakeOAuth();
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: fakeClock().clock,
  });
  await session.restore();
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(calls.length, 0);
  assertEqual(applied.length, 0);
}

async function testRestoreCorrupt(): Promise<void> {
  const { custody } = fakeCustody(
    appError('invalid-response', 'auth: corrupt custody record'),
  );
  const { oauth, calls } = fakeOAuth();
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  await session.restore();
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(calls.length, 0);
}

async function testRestoreGrant(): Promise<void> {
  const { custody } = fakeCustody({
    v: 1,
    refreshToken: 'stored-refresh',
    clientId: 'stored-client',
    grantClientId: 'issuer-client',
  });
  const { oauth, calls, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ accessToken: 'fresh-access', refreshToken: null })));
  const applied: (string | null)[] = [];
  const clock = fakeClock();
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: clock.clock,
  });
  const seen = collector(session);
  await session.restore();
  // Stored grant → signed-in is published optimistically, but no
  // bearer has reached the host slot yet.
  assertEqual(session.snapshot().bearerLive, false);
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
  assertEqual(session.snapshot().bearerLive, true);
  // The boot refresh rode the stored grant under its ISSUING client —
  // the override preference ('stored-client') must not leak in.
  assertEqual(calls.length, 1);
  assertEqual(calls[0]?.kind, 'refresh');
  assertEqual(calls[0]?.creds.clientId, 'issuer-client');
  assertDeepEqual(applied, ['fresh-access']);
  // The stored grant published signed-in optimistically before the
  // exchange resolved — a cold/offline boot renders honestly.
  assert(seen.includes('signed-in'), 'signed-in never published');
  // The renew timer is armed near the provider-stated expiry.
  assertEqual(clock.armed.length, 1);
  assert(clock.armed[0]!.ms <= 3_610_000 - 60_000 - 0);
}

// ------------------------------------------------------------------
// Device sign-in
// ------------------------------------------------------------------

async function testSignInFlow(): Promise<void> {
  const { custody, writes } = fakeCustody(null);
  const { oauth, begins, polls, calls } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'pending' }), ok({ type: 'slowDown' }));
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: fakeClock().clock,
  });
  const seen = collector(session);
  session.beginSignIn();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
  assert(seen.includes('starting'), 'starting never published');
  assert(seen.includes('authorizing'), 'authorizing never published');
  assertDeepEqual(applied, ['access-1']);
  // The minted flow persisted first (resume hook), then the refresh
  // grant BEFORE signed-in published.
  assertEqual(writes.length, 2);
  assertEqual(writes[0]?.pendingFlow?.deviceCode, 'dev-code');
  assertEqual(writes[1]?.refreshToken, 'refresh-1');
  // begin → 3 polls (pending, slowDown, granted)
  assertEqual(calls.length, 4);
}

async function testSignInCancelMidPoll(): Promise<void> {
  const { custody, writes } = fakeCustody(null);
  const { oauth, begins, pollDeferreds } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  await flush();
  const status = session.snapshot().status;
  assert(status.state === 'authorizing', 'never reached authorizing');
  assertEqual(status.userCode, 'ABCD-EFGH');
  assertEqual(pollDeferreds.length, 1);
  // Sheet closes mid-poll: the in-flight verdict resolves granted —
  // it must not apply anything.
  session.cancelSignIn();
  pollDeferreds[0]!.resolve(ok({ type: 'granted', grant: tokenGrant() }));
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(applied.length, 0);
  // The pending record survives dismissal — that's the resume hook.
  assertEqual(writes.length, 1);
  assertEqual(writes[0]?.pendingFlow?.deviceCode, 'dev-code');
}

async function testSignInDenied(): Promise<void> {
  const { custody, writes } = fakeCustody(null);
  const { oauth, begins, polls } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'denied' }));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  await flush();
  const status = session.snapshot().status;
  assert(status.state === 'failed', 'denied did not fail');
  assertEqual(status.error.kind, 'permission-denied');
  // pending write + denial clear — the dead code can't be resumed.
  assertEqual(writes.length, 2);
  assertEqual(writes[1]?.pendingFlow, undefined);
  // A failed flow is re-beginnable — the sheet's retry row works.
  session.cancelSignIn();
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  session.beginSignIn();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
}

async function testSignInExpiry(): Promise<void> {
  const { custody } = fakeCustody(null);
  const { oauth, begins, polls } = fakeOAuth();
  // expiresAtMs already in the past when the first poll sleeps.
  begins.push(ok(deviceGrant({ expiresAtMs: 0 })));
  const clock = fakeClock(10_000);
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: clock.clock,
  });
  session.beginSignIn();
  await flush();
  const status = session.snapshot().status;
  assert(status.state === 'failed', 'expiry did not fail');
  assertEqual(status.error.kind, 'expired');
  assertEqual(polls.length, 0);
}

async function testSignInNoRefreshToken(): Promise<void> {
  const { custody, writes } = fakeCustody(null);
  const { oauth, begins, polls } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  polls.push(
    ok({
      type: 'granted',
      grant: tokenGrant({ refreshToken: null }),
    }),
  );
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  await flush();
  const status = session.snapshot().status;
  // A grant that can't outlive its ~1h access token is a failure,
  // not a silent half-link — no grant write, no host bearer; the
  // persisted pending is cleared (its custody write + the clear).
  assert(status.state === 'failed', 'missing refresh token signed in');
  assertEqual(status.error.kind, 'invalid-response');
  assertEqual(writes.length, 2);
  assertEqual(writes[1]?.pendingFlow, undefined);
  assertEqual(applied.length, 0);
}

async function testSignInCustodyFailure(): Promise<void> {
  // Writes fail — sign-in must NOT claim success.
  const failing: AuthCustody = {
    read: () => Promise.resolve(ok(null)),
    write: () =>
      Promise.resolve(err(appError('unavailable', 'seal failed'))),
    clear: () => Promise.resolve(ok(undefined)),
  };
  const { oauth, begins, polls } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody: failing,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  await flush();
  const status = session.snapshot().status;
  assert(status.state === 'failed', 'custody failure signed in');
  assertEqual(status.error.kind, 'unavailable');
  assertEqual(applied.length, 0);
}

// ------------------------------------------------------------------
// Sign-out ordering
// ------------------------------------------------------------------

async function testSignOut(): Promise<void> {
  const { custody, record } = fakeCustody({
    v: 1,
    refreshToken: 'stored-refresh',
    clientId: 'kept-client',
    grantClientId: 'kept-client',
  });
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ refreshToken: null })));
  const order: string[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      order.push(`token:${t === null ? 'null' : 'set'}`);
    },
    clock: fakeClock().clock,
  });
  const origWrite = custody.write;
  custody.write = (next) => {
    order.push('custody-write');
    return origWrite(next);
  };
  await session.restore();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
  const out = await session.signOut();
  assert(out.ok, 'signOut failed');
  // The host slot cleared BEFORE the custody write — a write failure
  // can never leave a live bearer behind.
  const tokenNullIdx = order.indexOf('token:null');
  const writeIdx = order.indexOf('custody-write');
  assert(tokenNullIdx >= 0 && writeIdx > tokenNullIdx, 'wrong ordering');
  assertEqual(session.snapshot().status.state, 'signed-out');
  // Override preserved — it's a preference, not a credential.
  assertEqual(record.current?.refreshToken, null);
  assertEqual(record.current?.clientId, 'kept-client');
}

async function testSignOutWhileAuthorizing(): Promise<void> {
  const { custody } = fakeCustody(null);
  const { oauth, begins, pollDeferreds } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  await flush();
  assertEqual(session.snapshot().status.state, 'authorizing');
  const out = await session.signOut();
  assert(out.ok);
  assertEqual(session.snapshot().status.state, 'signed-out');
  // A late grant on the torn-down flow applies nothing.
  pollDeferreds[0]?.resolve(ok({ type: 'granted', grant: tokenGrant() }));
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-out');
}

// ------------------------------------------------------------------
// Client-id override
// ------------------------------------------------------------------

async function testClientOverride(): Promise<void> {
  const { custody, record } = fakeCustody(null);
  const { oauth, calls, begins, polls } = fakeOAuth();
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  const set = await session.setClientOverride('custom-client');
  assert(set.ok, 'override failed');
  assertEqual(record.current?.clientId, 'custom-client');
  assertEqual(session.snapshot().clientId, 'custom-client');
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  session.beginSignIn();
  await flush();
  // The flow ran under the override.
  assertEqual(calls[0]?.creds.clientId, 'custom-client');
  // Clearing restores the default snapshot.
  const cleared = await session.setClientOverride(null);
  assert(cleared.ok);
  assertEqual(session.snapshot().clientId, null);
  // Overlength input is rejected before any custody write.
  const tooLong = await session.setClientOverride('x'.repeat(600));
  assert(!tooLong.ok);
  assertEqual(tooLong.error.kind, 'invalid-message');
}

// ------------------------------------------------------------------
// Expiry renew lane
// ------------------------------------------------------------------

async function testRenewLane(): Promise<void> {
  const { custody, record } = fakeCustody({
    v: 1,
    refreshToken: 'stored-refresh',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes, calls } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ accessToken: 'access-a', refreshToken: null })));
  const applied: (string | null)[] = [];
  const clock = fakeClock();
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: clock.clock,
  });
  await session.restore();
  await flush();
  assertDeepEqual(applied, ['access-a']);
  // Expiry approaches — the armed timer fires a refresh.
  refreshes.push(ok(tokenGrant({ accessToken: 'access-b', refreshToken: null })));
  clock.setNow(3_550_000);
  clock.fireNext();
  await flush();
  assertDeepEqual(applied, ['access-a', 'access-b']);
  assertEqual(session.snapshot().status.state, 'signed-in');
  // A revoked grant drops custody + the host bearer — once.
  refreshes.push(err(appError('auth-expired', 'oauth: refresh invalid_grant')));
  clock.setNow(3_560_000);
  clock.fireNext();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(applied.at(-1), null);
  assertEqual(record.current?.refreshToken, null);
  // No further refresh calls are armed on a dead grant.
  const refreshCalls = calls.filter((c) => c.kind === 'refresh').length;
  assertEqual(refreshCalls, 3);
}

async function testRenewTransientBackoff(): Promise<void> {
  const { custody } = fakeCustody({
    v: 1,
    refreshToken: 'stored-refresh',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ refreshToken: null })));
  const applied: (string | null)[] = [];
  const clock = fakeClock();
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: clock.clock,
  });
  await session.restore();
  await flush();
  // A transient failure re-arms rather than dropping the grant.
  refreshes.push(err(appError('unavailable', 'oauth: refresh http 500')));
  clock.fireNext();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
  assert(clock.armed.length === 1, 'retry not re-armed');
  assert(clock.armed[0]!.ms >= 30_000, 'retry armed too soon');
  // The retry succeeds — the slot gets the new bearer.
  refreshes.push(ok(tokenGrant({ accessToken: 'access-c', refreshToken: null })));
  clock.fireNext();
  await flush();
  assertEqual(applied.at(-1), 'access-c');
}

async function testSignOutDuringRenew(): Promise<void> {
  // A refresh mint that resolves AFTER sign-out cleared the slot
  // must not resurrect the bearer.
  const { custody, record } = fakeCustody({
    v: 1,
    refreshToken: 'stored-refresh',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ accessToken: 'access-a', refreshToken: null })));
  const applied: (string | null)[] = [];
  const clock = fakeClock();
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: clock.clock,
  });
  await session.restore();
  await flush();
  assertDeepEqual(applied, ['access-a']);
  // Park the next refresh in flight, then sign out while it is.
  const late = deferred<Result<TokenGrant>>();
  oauth.refreshAccessToken = () => late.promise;
  clock.setNow(3_550_000);
  clock.fireNext();
  await flush();
  const out = session.signOut();
  await out;
  assertDeepEqual(applied, ['access-a', null]);
  // The late mint resolves — the stale grant identity drops it.
  late.resolve(ok(tokenGrant({ accessToken: 'access-late' })));
  await flush();
  assertDeepEqual(applied, ['access-a', null]);
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(record.current?.refreshToken, null);
}

async function testSignOutDuringGrantPersist(): Promise<void> {
  // Sign-out inside the sign-in custody-persist window: the granted
  // write lands first (serialized), sign-out's null write ends the
  // chain, and the parked sign-in never applies its mint.
  const gate = deferred<Result<void>>();
  const { custody, record } = fakeCustody(null);
  const origWrite = custody.write;
  let gated = true;
  custody.write = (next) => {
    if (gated) {
      gated = false;
      return gate.promise;
    }
    return origWrite(next);
  };
  const { oauth, begins, polls } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: fakeClock().clock,
  });
  await session.restore();
  session.beginSignIn();
  await flush();
  // The grant is parked inside its (deferred) custody write.
  const out = session.signOut();
  await flush();
  gate.resolve(ok(undefined));
  await out;
  await flush();
  assertDeepEqual(applied, [null]);
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(record.current?.refreshToken, null);
}

async function testRefreshRotation(): Promise<void> {
  // A rotated refresh grant in the reply is persisted atomically and
  // the next renewal rides the replacement.
  const { custody, record } = fakeCustody({
    v: 1,
    refreshToken: 'stored-refresh',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(
    ok(tokenGrant({ accessToken: 'access-a', refreshToken: 'rotated-2' })),
  );
  let seenToken: string | null = null;
  const orig = oauth.refreshAccessToken;
  oauth.refreshAccessToken = (c, t) => {
    seenToken = t;
    return orig(c, t);
  };
  const clock = fakeClock();
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: clock.clock,
  });
  await session.restore();
  await flush();
  assertEqual(record.current?.refreshToken, 'rotated-2');
  // The next renewal presents the rotated grant, not the stored one.
  refreshes.push(ok(tokenGrant({ accessToken: 'access-b', refreshToken: null })));
  clock.setNow(3_550_000);
  clock.fireNext();
  await flush();
  assertEqual(seenToken, 'rotated-2');
}

async function testStaleBeginCannotClobber(): Promise<void> {
  // A late-resolving beginDeviceFlow must not erase the newer
  // sign-in attempt started after the old one was dismissed.
  const { custody } = fakeCustody(null);
  const { oauth } = fakeOAuth();
  const b1 = deferred<Result<DeviceGrant>>();
  const b2 = deferred<Result<DeviceGrant>>();
  const queue = [b1, b2];
  oauth.beginDeviceFlow = () => {
    const next = queue.shift();
    assert(next !== undefined, 'oauth: unscripted beginDeviceFlow');
    return next.promise;
  };
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  await session.restore();
  session.beginSignIn();
  await flush();
  session.cancelSignIn();
  session.beginSignIn();
  await flush();
  // Attempt A's begin resolves late — attempt B stays untouched.
  b1.resolve(ok(deviceGrant({ userCode: 'AAAA-AAAA' })));
  await flush();
  assertEqual(session.snapshot().status.state, 'starting');
  b2.resolve(ok(deviceGrant({ userCode: 'BBBB-BBBB' })));
  await flush();
  const st = session.snapshot().status;
  assert(
    st.state === 'authorizing' && st.userCode === 'BBBB-BBBB',
    'newer sign-in clobbered by stale begin',
  );
  session.cancelSignIn();
}

async function testBearerLiveExpires(): Promise<void> {
  // Renewals failing past the access expiry flip the liveness flag
  // off and clear the stale token from the host slot.
  const { custody } = fakeCustody({
    v: 1,
    refreshToken: 'r1',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ refreshToken: null })));
  const clock = fakeClock(0);
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: clock.clock,
  });
  await session.restore();
  await flush();
  assertEqual(session.snapshot().bearerLive, true);
  refreshes.push(err(appError('unavailable', 'oauth: refresh 500')));
  clock.setNow(3_610_001);
  clock.fireNext();
  await flush();
  assertEqual(session.snapshot().bearerLive, false);
  assert(applied.includes(null), 'stale bearer never cleared');
}

async function testCustodyReadFailGatesVerbs(): Promise<void> {
  // A failed custody read must not become an empty record — verbs
  // that would write the unloaded view refuse until a read succeeds.
  const { custody, record } = fakeCustody({
    v: 1,
    refreshToken: 'r-stored',
    clientId: 'kept',
    grantClientId: null,
  });
  const origRead = custody.read;
  custody.read = () =>
    Promise.resolve(err(appError('unavailable', 'store: io')));
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ accessToken: 'a1', refreshToken: null })));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  await session.restore();
  const denied = await session.setClientOverride('other');
  assert(!denied.ok, 'override accepted despite unread custody');
  assertEqual(denied.error.kind, 'unavailable');
  // Nothing was written over the unread record.
  assertEqual(record.current?.refreshToken, 'r-stored');
  // The store heals — the next restore retries and recovers.
  custody.read = origRead;
  await session.restore();
  assertEqual(session.snapshot().status.state, 'signed-in');
}

async function testRotationPersistRetry(): Promise<void> {
  // A failed rotation write keeps retrying on the persist lane —
  // the in-memory grant rides the replacement meanwhile.
  const { custody, record } = fakeCustody({
    v: 1,
    refreshToken: 'r1',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ accessToken: 'a1', refreshToken: 'r2' })));
  const origWrite = custody.write;
  let failNext = 1;
  custody.write = (rec) => {
    if (failNext > 0) {
      failNext -= 1;
      return Promise.resolve(err(appError('unavailable', 'store: io')));
    }
    return origWrite(rec);
  };
  const clock = fakeClock(0);
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: clock.clock,
  });
  await session.restore();
  await flush();
  // The immediate write failed — record still holds r1; a persist
  // retry is armed alongside the renew retry.
  assertEqual(record.current?.refreshToken, 'r1');
  clock.fireNext(); // fires the persist retry (armed first)
  await flush();
  assertEqual(record.current?.refreshToken, 'r2');
}

async function testApplyRacingSignOut(): Promise<void> {
  // A pending access apply finishing after sign-out must not
  // resurrect the bearer — serialized writes land null last and
  // the owner check drops the late flag.
  const { custody } = fakeCustody({
    v: 1,
    refreshToken: 'r1',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ refreshToken: null })));
  const pending = deferred<void>();
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
      if (t === 'access-1') {
        return pending.promise;
      }
      return Promise.resolve();
    },
    clock: fakeClock().clock,
  });
  await session.restore();
  await flush();
  // The mint's apply is parked; sign-out queues its null behind it.
  const out = session.signOut();
  pending.resolve();
  await out;
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(session.snapshot().bearerLive, false);
  assertEqual(applied[applied.length - 1], null);
}

async function testBeginRacesRestore(): Promise<void> {
  // A sign-in tap while the custody read is still in flight must
  // not mint a second device code once a stored grant lands.
  const seed = {
    v: 1 as const,
    refreshToken: 'r-stored',
    clientId: 'kept',
    grantClientId: null,
  };
  const { custody } = fakeCustody(seed);
  const pendingRead = deferred<Result<AuthCustodyRecord | null>>();
  custody.read = () => pendingRead.promise;
  const { oauth, calls, refreshes } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ refreshToken: null })));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  pendingRead.resolve(ok(seed));
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
  assert(
    calls.every((c) => c.kind !== 'begin'),
    'device flow minted despite a restored grant',
  );
}

async function testRetryNow(): Promise<void> {
  // The recovery verb bypasses the renewal backoff — the refresh
  // fires on the next tick, not after the retry timer.
  const { custody } = fakeCustody({
    v: 1,
    refreshToken: 'r1',
    clientId: null,
    grantClientId: null,
  });
  const { oauth, refreshes, calls } = fakeOAuth();
  refreshes.push(ok(tokenGrant({ refreshToken: null })));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  await session.restore();
  await flush();
  const before = calls.filter((c) => c.kind === 'refresh').length;
  refreshes.push(
    ok(tokenGrant({ accessToken: 'a2', refreshToken: null })),
  );
  session.retryNow();
  await flush();
  assertEqual(
    calls.filter((c) => c.kind === 'refresh').length,
    before + 1,
  );
}

async function testDuplicateBegin(): Promise<void> {
  const { custody } = fakeCustody(null);
  const { oauth, begins, pollDeferreds } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  session.beginSignIn();
  session.beginSignIn();
  await flush();
  // One beginDeviceFlow call, one deferred poll — the duplicate
  // taps are no-ops.
  assertEqual(pollDeferreds.length, 1);
  session.cancelSignIn();
}

// ------------------------------------------------------------------
// Persisted device flow — interrupted approvals resume
// ------------------------------------------------------------------

function pendingFlow(over: Partial<AuthPendingFlow> = {}): AuthPendingFlow {
  return {
    deviceCode: 'dev-code',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://www.google.com/device',
    intervalMs: 1_000,
    expiresAtMs: 60_000,
    clientId: 'minted-client',
    ...over,
  };
}

async function testResumeAfterDismissal(): Promise<void> {
  const { custody, record, writes } = fakeCustody(null);
  const { oauth, begins, polls, calls } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  const applied: (string | null)[] = [];
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: (t) => {
      applied.push(t);
    },
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  await flush();
  assert(
    session.snapshot().status.state === 'authorizing',
    'never reached authorizing',
  );
  // Sheet dismissed mid-approve — the poll dies but the record
  // keeps the code Google may have already granted.
  session.cancelSignIn();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-out');
  const saved = record.current?.pendingFlow;
  assert(saved !== undefined && saved !== null, 'pending not persisted');
  assertEqual(saved.deviceCode, 'dev-code');
  // Reopening resumes on the SAME code — no second mint.
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  session.beginSignIn();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
  assertEqual(
    calls.filter((c) => c.kind === 'begin').length,
    1,
    'resume minted a second device code',
  );
  // The resumed poll rides the client_id the code was minted under.
  const lastPoll = [...calls].reverse().find((c) => c.kind === 'poll');
  assertEqual(lastPoll?.creds.clientId, saved.clientId);
  // The grant write consumed the pending record.
  assertEqual(record.current?.refreshToken, 'refresh-1');
  assertEqual(record.current?.pendingFlow, undefined);
  assertDeepEqual(applied, ['access-1']);
  assertEqual(writes[writes.length - 1]?.refreshToken, 'refresh-1');
}

async function testBootResumesPendingFlow(): Promise<void> {
  const { custody, record } = fakeCustody({
    v: 1,
    refreshToken: null,
    clientId: null,
    grantClientId: null,
    pendingFlow: pendingFlow(),
  });
  const { oauth, polls, calls } = fakeOAuth();
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  // Process died while the user approved in the browser — boot
  // re-arms the same poll; the landed grant applies itself.
  await session.restore();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
  assertEqual(
    calls.filter((c) => c.kind === 'begin').length,
    0,
    'boot resume minted a code',
  );
  const poll = calls.find((c) => c.kind === 'poll');
  assertEqual(poll?.creds.clientId, 'minted-client');
  assertEqual(record.current?.refreshToken, 'refresh-1');
}

async function testExpiredPendingMintsFresh(): Promise<void> {
  const { custody } = fakeCustody({
    v: 1,
    refreshToken: null,
    clientId: null,
    grantClientId: null,
    pendingFlow: pendingFlow({ expiresAtMs: 1_000 }),
  });
  const { oauth, begins, polls, calls } = fakeOAuth();
  const clock = fakeClock(10_000);
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: clock.clock,
  });
  await session.restore();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-out');
  assertEqual(calls.length, 0, 'expired pending resumed');
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'granted', grant: tokenGrant() }));
  session.beginSignIn();
  await flush();
  assertEqual(session.snapshot().status.state, 'signed-in');
}

async function testDeniedClearsPendingRecord(): Promise<void> {
  const { custody, record } = fakeCustody(null);
  const { oauth, begins, polls } = fakeOAuth();
  begins.push(ok(deviceGrant()));
  polls.push(ok({ type: 'denied' }));
  const session = createAuthSession({
    custody,
    oauth,
    applyToken: () => {},
    clock: fakeClock().clock,
  });
  session.beginSignIn();
  await flush();
  assert(
    session.snapshot().status.state === 'failed',
    'denied did not fail',
  );
  assertEqual(record.current?.refreshToken, null);
  assertEqual(record.current?.pendingFlow, undefined);
}

export async function run(): Promise<void> {
  testCustodyValidator();
  await testRestoreEmpty();
  await testRestoreCorrupt();
  await testRestoreGrant();
  await testSignInFlow();
  await testSignInCancelMidPoll();
  await testSignInDenied();
  await testSignInExpiry();
  await testSignInNoRefreshToken();
  await testSignInCustodyFailure();
  await testSignOut();
  await testSignOutWhileAuthorizing();
  await testClientOverride();
  await testRenewLane();
  await testRenewTransientBackoff();
  await testSignOutDuringRenew();
  await testSignOutDuringGrantPersist();
  await testRefreshRotation();
  await testStaleBeginCannotClobber();
  await testBearerLiveExpires();
  await testCustodyReadFailGatesVerbs();
  await testRotationPersistRetry();
  await testApplyRacingSignOut();
  await testBeginRacesRestore();
  await testRetryNow();
  await testDuplicateBegin();
  await testResumeAfterDismissal();
  await testBootResumesPendingFlow();
  await testExpiredPendingMintsFresh();
  await testDeniedClearsPendingRecord();
}
