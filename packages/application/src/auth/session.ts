/**
 * `createAuthSession` — the application-level owner of OAuth session
 * trust. It wraps the protocol client ({@link createOAuthClient})
 * around the two platform seams that differ: `custody` (a refresh
 * grant is a credential — desktop seals it under Electron safeStorage,
 * mobile under Keystore/Keychain) and `applyToken` (pushes the
 * short-lived access token into the host's auth slot).
 *
 * Custody rules:
 *  - The refresh grant is the only persisted credential. Access
 *    tokens live in memory + the host slot, never on disk.
 *  - The user-supplied `clientId` override is a preference — it rides
 *    the same sealed record so custody writes stay atomic, and
 *    sign-out preserves it while dropping the grant.
 *  - No token material is ever logged or carried in an error message.
 *
 * Lifecycle: `restore()` once at boot (memoized — a utility respawn
 * or retry re-runs it harmlessly); `beginSignIn`/`cancelSignIn`/
 * `signOut`/`setClientOverride` are the UI verbs; access-token expiry
 * self-arms a refresh timer at expiry − margin and retries a failed
 * renew on a bounded backoff.
 */
import { CancellationSource } from '../cancellation.ts';
import type { CancellationSignal } from '../cancellation.ts';
import { appError, err, fromUnknown, ok } from '../errors.ts';
import { hasExactKeys, isRecord } from '../domain.ts';
import type { AppError, Result } from '../errors.ts';
import {
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_CLIENT_SECRET,
  createFetchOAuthHttp,
  createOAuthClient,
} from './oauth.ts';
import type {
  DeviceGrant,
  OAuthClient,
  OAuthCredentials,
  TokenGrant,
} from './oauth.ts';

// ------------------------------------------------------------------
// State surface — the wire/UI-facing snapshot. The status union is a
// closed set so a validator can certify pushes crossing the desktop
// utility→main→renderer hop.
// ------------------------------------------------------------------

export type AuthStatus =
  | { readonly state: 'signed-out' }
  | { readonly state: 'starting' }
  | {
      readonly state: 'authorizing';
      readonly userCode: string;
      readonly verificationUrl: string;
      readonly expiresAtMs: number;
    }
  | { readonly state: 'signed-in' }
  | { readonly state: 'failed'; readonly error: AppError };

export type AuthSnapshot = {
  readonly status: AuthStatus;
  /** The effective client_id override — null selects the default. */
  readonly clientId: string | null;
};

/**
 * The sealed record — one JSON blob per install. `refreshToken` is
 * the credential half; `clientId` is the advanced override. Fields
 * are nullable (never absent) so a partial record can't smuggle an
 * undeclared shape through JSON.parse.
 */
export type AuthCustodyRecord = {
  readonly v: 1;
  readonly refreshToken: string | null;
  readonly clientId: string | null;
};

export const EMPTY_AUTH_CUSTODY: AuthCustodyRecord = {
  v: 1,
  refreshToken: null,
  clientId: null,
};

export function isAuthCustodyRecord(
  value: unknown,
): value is AuthCustodyRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['v', 'refreshToken', 'clientId']) &&
    value['v'] === 1 &&
    (value['refreshToken'] === null ||
      (typeof value['refreshToken'] === 'string' &&
        value['refreshToken'].length > 0 &&
        value['refreshToken'].length <= 4096)) &&
    (value['clientId'] === null ||
      (typeof value['clientId'] === 'string' &&
        value['clientId'].length > 0 &&
        value['clientId'].length <= 512))
  );
}

/** Storage seam — the platform's OS-backed credential store. */
export interface AuthCustody {
  /** null = absent; a corrupt payload resolves `err`, never silently null. */
  read(): Promise<Result<AuthCustodyRecord | null>>;
  write(record: AuthCustodyRecord): Promise<Result<void>>;
  clear(): Promise<Result<void>>;
}

// This package's own typecheck is lib-free — the timer globals exist
// on every runtime (Node, Electron, Hermes), so like runtime-impls.ts
// they are declared module-scoped rather than pulling in DOM types.
declare const setTimeout: (
  callback: () => void,
  ms: number,
) => { unref?(): void };
declare const clearTimeout: (timer: unknown) => void;

/** Timer seam — tests inject a fake clock; production uses realAuthClock. */
export interface AuthClock {
  now(): number;
  /** Resolves false when the signal fires first — cancellable sleeps. */
  sleep(ms: number, signal?: CancellationSignal): Promise<boolean>;
  /** Arms a one-shot timer; the return disarms. */
  arm(ms: number, fire: () => void): () => void;
}

export function realAuthClock(): AuthClock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<boolean>((resolve) => {
        if (signal !== undefined && signal.cancelled) {
          resolve(false);
          return;
        }
        let done = false;
        const timer = setTimeout(() => {
          done = true;
          unsub?.();
          resolve(true);
        }, ms);
        const unsub =
          signal === undefined
            ? null
            : signal.subscribe(() => {
                if (done) {
                  return;
                }
                done = true;
                clearTimeout(timer);
                resolve(false);
              });
      }),
    arm: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}

export interface AuthSessionDeps {
  readonly custody: AuthCustody;
  /**
   * Pushes the access token into the host slot (null clears). May
   * throw/reject — a failed apply surfaces as a typed failure rather
   * than claiming sign-in without a live bearer.
   */
  readonly applyToken: (token: string | null) => void | Promise<void>;
  readonly oauth?: OAuthClient | undefined;
  /**
   * Platform default client id (e.g. a desktop env override) — the
   * custody-recorded override still beats it.
   */
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | null | undefined;
  readonly clock?: AuthClock | undefined;
}

export interface AuthSession {
  /** The current published snapshot — stable ref between publishes. */
  snapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  /** Boot path — memoized; the custody read runs once. */
  restore(): Promise<void>;
  /** No-op while signed in or a flow is in flight (duplicate guard). */
  beginSignIn(): void;
  /** Sheet dismissal — cancels an in-flight flow, resets a transient failure. */
  cancelSignIn(): void;
  /**
   * Drops the grant: memory, host slot, and custody — in that order,
   * so a custody failure can never leave a live bearer behind.
   */
  signOut(): Promise<Result<void>>;
  setClientOverride(clientId: string | null): Promise<Result<void>>;
}

const RENEW_MARGIN_MS = 60_000;
const RENEW_MIN_DELAY_MS = 5_000;
const RENEW_RETRY_BASE_MS = 30_000;
const RENEW_RETRY_MAX_MS = 600_000;
const SLOWDOWN_STEP_MS = 5_000;

export function createAuthSession(deps: AuthSessionDeps): AuthSession {
  const clock = deps.clock ?? realAuthClock();
  const oauth =
    deps.oauth ??
    createOAuthClient({ http: createFetchOAuthHttp() });
  const custody = deps.custody;

  let status: AuthStatus = { state: 'signed-out' };
  let clientIdOverride: string | null = null;
  let refreshToken: string | null = null;
  let accessExpiresAtMs = 0;
  let renewDisarm: (() => void) | null = null;
  let renewFails = 0;
  let flow: {
    source: CancellationSource;
    grant: DeviceGrant;
    intervalMs: number;
  } | null = null;
  let pendingBegin: CancellationSource | null = null;
  let restored: Promise<void> | null = null;
  let renewChain: Promise<void> = Promise.resolve();
  let custodyChain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  let current: AuthSnapshot = { status, clientId: null };

  function publish(): void {
    current = { status, clientId: clientIdOverride };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing subscriber must not wedge the publisher.
      }
    }
  }

  function creds(): OAuthCredentials {
    const clientId =
      clientIdOverride ?? deps.clientId ?? DEFAULT_OAUTH_CLIENT_ID;
    // Secret resolution: an explicit env/dep secret always wins; the
    // default client's published secret applies only when the
    // effective id IS the default — pairing it with an override id
    // would be an invalid credential pair.
    const clientSecret =
      deps.clientSecret ??
      (clientId === DEFAULT_OAUTH_CLIENT_ID
        ? DEFAULT_OAUTH_CLIENT_SECRET
        : null);
    return {
      clientId,
      ...(clientSecret !== null && clientSecret !== undefined
        ? { clientSecret }
        : {}),
    };
  }

  /** Every custody write is serialized — a RMW pair can interleave. */
  function writeCustody(
    record: AuthCustodyRecord,
  ): Promise<Result<void>> {
    const next = custodyChain.then(() => custody.write(record));
    custodyChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function clearCustody(): Promise<Result<void>> {
    const next = custodyChain.then(() => custody.clear());
    custodyChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function disarmRenew(): void {
    if (renewDisarm !== null) {
      renewDisarm();
      renewDisarm = null;
    }
  }

  /**
   * The simple-timer refresh policy: re-mint 60 s before the
   * provider-stated expiry (min 5 s out), and on a transient failure
   * retry on a 30 s→10 min backoff. A dead grant drops to signed-out
   * once — no infinite retry of a revoked credential.
   */
  function armRenew(): void {
    disarmRenew();
    if (refreshToken === null || accessExpiresAtMs === 0) {
      return;
    }
    const delay = Math.max(
      accessExpiresAtMs - RENEW_MARGIN_MS - clock.now(),
      RENEW_MIN_DELAY_MS,
    );
    renewDisarm = clock.arm(delay, () => {
      renewDisarm = null;
      renewQueued();
    });
  }

  function armRenewRetry(): void {
    disarmRenew();
    renewDisarm = clock.arm(
      Math.min(
        RENEW_RETRY_BASE_MS * 2 ** Math.min(renewFails, 5),
        RENEW_RETRY_MAX_MS,
      ),
      () => {
        renewDisarm = null;
        renewQueued();
      },
    );
  }

  /** Serializes renews — the timer, restore, and a wall nudge share one lane. */
  function renewQueued(): void {
    renewChain = renewChain.then(() => renew()).then(
      () => undefined,
      () => undefined,
    );
  }

  async function applyAccess(grant: TokenGrant): Promise<void> {
    await Promise.resolve(deps.applyToken(grant.accessToken));
    accessExpiresAtMs = grant.expiresAtMs;
    renewFails = 0;
    armRenew();
  }

  /**
   * A dead refresh grant: drop the credential everywhere. Custody is
   * rewritten (override preserved) rather than cleared so the
   * clientId preference survives re-pairing.
   */
  async function dropGrant(): Promise<void> {
    refreshToken = null;
    accessExpiresAtMs = 0;
    disarmRenew();
    renewFails = 0;
    try {
      await deps.applyToken(null);
    } catch {
      // A dead host still loses the bearer — custody clearing proceeds.
    }
    await writeCustody({
      v: 1,
      refreshToken: null,
      clientId: clientIdOverride,
    }).then(
      () => undefined,
      () => undefined,
    );
    // A live sign-in flow owns the status — the dropped grant was the
    // stale one; clobbering 'authorizing' mid-poll would lie about the
    // flow the user is looking at.
    if (
      status.state !== 'starting' &&
      status.state !== 'authorizing' &&
      status.state !== 'signed-out'
    ) {
      status = { state: 'signed-out' };
      publish();
    }
  }

  async function renew(): Promise<void> {
    const token = refreshToken;
    if (token === null) {
      return;
    }
    const res = await oauth.refreshAccessToken(creds(), token);
    if (res.ok) {
      try {
        await applyAccess(res.value);
      } catch (thrown) {
        // Host slot rejected — the grant is still good; retry.
        void thrown;
        renewFails += 1;
        armRenewRetry();
      }
      return;
    }
    if (res.error.kind === 'auth-expired') {
      await dropGrant();
      return;
    }
    renewFails += 1;
    armRenewRetry();
  }

  async function doRestore(): Promise<void> {
    const read = await custody.read();
    if (!read.ok || read.value === null) {
      publish();
      return;
    }
    clientIdOverride = read.value.clientId;
    refreshToken = read.value.refreshToken;
    if (refreshToken !== null && status.state === 'signed-out') {
      // The stored grant IS the signed-in state — publish before the
      // first exchange resolves so a cold/offline boot still renders
      // honestly, then the renew loop does its first refresh now.
      status = { state: 'signed-in' };
    }
    publish();
    if (refreshToken !== null) {
      renewQueued();
    }
  }

  function endFlow(): void {
    flow = null;
    pendingBegin = null;
  }

  async function runPollLoop(
    source: CancellationSource,
    grant: DeviceGrant,
    intervalMs: number,
  ): Promise<void> {
    let interval = intervalMs;
    for (;;) {
      const slept = await clock.sleep(interval, source.signal);
      if (!slept || source.signal.cancelled) {
        endFlow();
        status = { state: 'signed-out' };
        publish();
        return;
      }
      if (clock.now() >= grant.expiresAtMs) {
        endFlow();
        status = {
          state: 'failed',
          error: appError('expired', 'oauth: device code expired'),
        };
        publish();
        return;
      }
      const res = await oauth.pollDeviceGrant(creds(), grant);
      if (source.signal.cancelled) {
        endFlow();
        status = { state: 'signed-out' };
        publish();
        return;
      }
      if (!res.ok) {
        endFlow();
        status = { state: 'failed', error: res.error };
        publish();
        return;
      }
      const verdict = res.value;
      if (verdict.type === 'pending') {
        continue;
      }
      if (verdict.type === 'slowDown') {
        interval += SLOWDOWN_STEP_MS;
        continue;
      }
      if (verdict.type === 'denied') {
        endFlow();
        status = {
          state: 'failed',
          error: appError('permission-denied', 'oauth: denied'),
        };
        publish();
        return;
      }
      if (verdict.type === 'expired') {
        endFlow();
        status = {
          state: 'failed',
          error: appError('expired', 'oauth: device code expired'),
        };
        publish();
        return;
      }
      // granted — persist the refresh grant BEFORE publishing; a
      // custody failure is a failed sign-in, not a session that
      // silently won't survive a restart.
      endFlow();
      const token = verdict.grant;
      if (token.refreshToken === null) {
        // A grant with no refresh_token can't outlive its ~1h access
        // token — signing in on it would strand the user mid-session
        // with no renew path, so it's a typed failure, not a silent
        // half-linked state.
        status = {
          state: 'failed',
          error: appError(
            'invalid-response',
            'oauth: grant carried no refresh token',
          ),
        };
        publish();
        return;
      }
      refreshToken = token.refreshToken;
      const wrote = await writeCustody({
        v: 1,
        refreshToken: token.refreshToken,
        clientId: clientIdOverride,
      });
      if (!wrote.ok) {
        refreshToken = null;
        status = { state: 'failed', error: wrote.error };
        publish();
        return;
      }
      try {
        await applyAccess(token);
      } catch (thrown) {
        status = {
          state: 'failed',
          error: fromUnknown(thrown),
        };
        publish();
        return;
      }
      status = { state: 'signed-in' };
      publish();
      return;
    }
  }

  return {
    snapshot: () => current,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    restore() {
      restored ??= doRestore();
      return restored;
    },

    beginSignIn() {
      if (
        flow !== null ||
        pendingBegin !== null ||
        status.state === 'signed-in' ||
        status.state === 'starting' ||
        status.state === 'authorizing'
      ) {
        return;
      }
      const source = new CancellationSource();
      pendingBegin = source;
      status = { state: 'starting' };
      publish();
      void (async () => {
        await (restored ??= doRestore());
        if (source.signal.cancelled) {
          if (pendingBegin === source) {
            pendingBegin = null;
          }
          return;
        }
        const begun = await oauth.beginDeviceFlow(creds());
        if (source.signal.cancelled) {
          pendingBegin = null;
          status = { state: 'signed-out' };
          publish();
          return;
        }
        if (!begun.ok) {
          pendingBegin = null;
          status = { state: 'failed', error: begun.error };
          publish();
          return;
        }
        flow = {
          source,
          grant: begun.value,
          intervalMs: begun.value.intervalMs,
        };
        status = {
          state: 'authorizing',
          userCode: begun.value.userCode,
          verificationUrl: begun.value.verificationUrl,
          expiresAtMs: begun.value.expiresAtMs,
        };
        publish();
        await runPollLoop(source, begun.value, begun.value.intervalMs);
      })();
    },

    cancelSignIn() {
      pendingBegin?.cancel();
      flow?.source.cancel();
      flow = null;
      pendingBegin = null;
      if (
        status.state === 'starting' ||
        status.state === 'authorizing' ||
        status.state === 'failed'
      ) {
        status = { state: 'signed-out' };
        publish();
      }
    },

    async signOut() {
      await (restored ??= doRestore());
      pendingBegin?.cancel();
      flow?.source.cancel();
      flow = null;
      pendingBegin = null;
      refreshToken = null;
      accessExpiresAtMs = 0;
      disarmRenew();
      renewFails = 0;
      // Host slot first — a custody failure below must never leave a
      // live bearer reachable.
      try {
        await deps.applyToken(null);
      } catch {
        // reported through the custody write result below — the
        // dangerous direction (surviving bearer) is already handled.
      }
      // The override is a preference, not a credential — the record
      // keeps it while dropping the grant. If that write fails, a
      // whole-record delete is the fallback (override lost, grant dead).
      const wrote = await writeCustody({
        v: 1,
        refreshToken: null,
        clientId: clientIdOverride,
      });
      if (!wrote.ok) {
        const cleared = await clearCustody();
        status = { state: 'signed-out' };
        publish();
        return cleared.ok
          ? ok(undefined)
          : err(
              appError(
                'unavailable',
                'oauth: custody clear failed',
              ),
            );
      }
      status = { state: 'signed-out' };
      publish();
      return ok(undefined);
    },

    async setClientOverride(clientId) {
      const trimmed = clientId?.trim() ?? '';
      if (trimmed.length > 512) {
        return err(
          appError('invalid-message', 'oauth: client id too long'),
        );
      }
      await (restored ??= doRestore());
      const next = trimmed === '' ? null : trimmed;
      const wrote = await writeCustody({
        v: 1,
        refreshToken,
        clientId: next,
      });
      if (!wrote.ok) {
        return wrote;
      }
      clientIdOverride = next;
      publish();
      return ok(undefined);
    },
  };
}
