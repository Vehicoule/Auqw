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
 *    tokens live in memory + the host slot, never on disk. An
 *    in-flight device flow is persisted too — a dismissed sheet or a
 *    killed process must not discard the code the user is approving;
 *    the poll re-arms over it on restore/reopen.
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
  /**
   * Whether a live access token currently sits in the host slot.
   * `signed-in && !bearerLive` means linked-but-dead (boot restore
   * pending or refresh failing) — recovery CTAs must still show. */
  readonly bearerLive: boolean;
};

/**
 * The sealed record — one JSON blob per install. `refreshToken` is
 * the credential half; `clientId` is the advanced override. Fields
 * are nullable (never absent) so a partial record can't smuggle an
 * undeclared shape through JSON.parse.
 */
/**
 * An in-flight device flow — persisted so an interrupted approval
 * (sheet dismissed mid-poll, or the whole app process dying while the
 * user is in the browser) can resume polling the same device code
 * instead of throwing the grant Google already minted away.
 */
export type AuthPendingFlow = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly intervalMs: number;
  readonly expiresAtMs: number;
  /** The client_id the code was minted under — polls must reuse it. */
  readonly clientId: string;
};

export type AuthCustodyRecord = {
  readonly v: 1;
  readonly refreshToken: string | null;
  readonly clientId: string | null;
  /**
   * The client_id that minted `refreshToken` — a grant is bound to
   * its issuer for life, so refresh exchanges keep using it even
   * after the override preference moves.
   */
  readonly grantClientId: string | null;
  /** Optional — absent once a flow grants, denies, or lapses. */
  readonly pendingFlow?: AuthPendingFlow | undefined;
};

export const EMPTY_AUTH_CUSTODY: AuthCustodyRecord = {
  v: 1,
  refreshToken: null,
  clientId: null,
  grantClientId: null,
};

function isPendingFlow(value: unknown): value is AuthPendingFlow {
  const numOk = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'deviceCode',
      'userCode',
      'verificationUrl',
      'intervalMs',
      'expiresAtMs',
      'clientId',
    ]) &&
    typeof value['deviceCode'] === 'string' &&
    value['deviceCode'].length > 0 &&
    value['deviceCode'].length <= 4096 &&
    typeof value['userCode'] === 'string' &&
    value['userCode'].length <= 64 &&
    typeof value['verificationUrl'] === 'string' &&
    value['verificationUrl'].length <= 512 &&
    numOk(value['intervalMs']) &&
    numOk(value['expiresAtMs']) &&
    typeof value['clientId'] === 'string' &&
    value['clientId'].length > 0 &&
    value['clientId'].length <= 512
  );
}

export function isAuthCustodyRecord(
  value: unknown,
): value is AuthCustodyRecord {
  const idOk = (v: unknown) =>
    v === null ||
    (typeof v === 'string' && v.length > 0 && v.length <= 512);
  const baseKeys = ['v', 'refreshToken', 'clientId', 'grantClientId'];
  return (
    isRecord(value) &&
    (hasExactKeys(value, baseKeys) ||
      hasExactKeys(value, [...baseKeys, 'pendingFlow'])) &&
    value['v'] === 1 &&
    (value['refreshToken'] === null ||
      (typeof value['refreshToken'] === 'string' &&
        value['refreshToken'].length > 0 &&
        value['refreshToken'].length <= 4096)) &&
    idOk(value['clientId']) &&
    idOk(value['grantClientId']) &&
    (value['pendingFlow'] === undefined ||
      isPendingFlow(value['pendingFlow']))
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
  /**
   * Forces an immediate renewal attempt while a grant is live — the
   * recovery affordance for a linked-but-dead bearer. No-op signed
   * out; a flow in flight is unaffected.
   */
  retryNow(): void;
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
/** Per-exchange deadline — a hung endpoint can't stall a flow past
 *  its device-code expiry or park a renewal forever. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
/** UI/wire bound on a published failure message — verbose provider
 *  bodies are truncated at publish, not at each producer, so the
 *  `auth:state` contract's 1024-char bound can never drop a snapshot. */
const SNAPSHOT_MESSAGE_MAX = 512;

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
    /** Frozen at begin — editing the override mid-poll cannot
     *  swap the client a grant is minted under. */
    creds: OAuthCredentials;
  } | null = null;
  let pendingBegin: CancellationSource | null = null;
  let restored: Promise<void> | null = null;
  /** A failed custody read is NOT an absent record — record-changing
   *  verbs refuse while it stands so a transient store error can't
   *  overwrite a real stored grant with the unloaded in-memory view. */
  let restoreFailed = false;
  let renewChain: Promise<void> = Promise.resolve();
  let custodyChain: Promise<unknown> = Promise.resolve();
  /** A rotation write that failed — retried on its own lane until the
   *  grant changes hands; the in-memory grant rides the replacement
   *  either way (the predecessor may already be dead server-side). */
  let pendingGrantWrite: {
    readonly token: string;
    readonly record: AuthCustodyRecord;
  } | null = null;
  let persistDisarm: (() => void) | null = null;
  /** Issuer of the live `refreshToken` — refresh exchanges ride
   *  this, never the moving override. */
  let grantClientId: string | null = null;
  /** The persisted in-flight device flow — memory mirror of the
   *  record's `pendingFlow` field; resume hooks read it, terminal
   *  poll outcomes clear it. */
  let pendingFlow: AuthPendingFlow | null = null;
  let bearerLive = false;
  const listeners = new Set<() => void>();
  let current: AuthSnapshot = { status, clientId: null, bearerLive };

  function publish(): void {
    const wire =
      status.state === 'failed' &&
      status.error.message.length > SNAPSHOT_MESSAGE_MAX
        ? {
            state: 'failed' as const,
            error: {
              ...status.error,
              message: `${status.error.message.slice(0, SNAPSHOT_MESSAGE_MAX)}…`,
            },
          }
        : status;
    current = { status: wire, clientId: clientIdOverride, bearerLive };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing subscriber must not wedge the publisher.
      }
    }
  }

  function credsFor(clientId: string): OAuthCredentials {
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

  function creds(): OAuthCredentials {
    return credsFor(
      clientIdOverride ?? deps.clientId ?? DEFAULT_OAUTH_CLIENT_ID,
    );
  }

  /** Exchange creds for a minted grant — bound to its issuer, not the
   *  moving preference. */
  function grantCreds(): OAuthCredentials {
    return credsFor(
      grantClientId ??
        clientIdOverride ??
        deps.clientId ??
        DEFAULT_OAUTH_CLIENT_ID,
    );
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

  /** Whole-record write carrying (or dropping) the in-flight flow. */
  function writePending(
    flowRec: AuthPendingFlow | null,
  ): Promise<Result<void>> {
    return writeCustody({
      v: 1,
      refreshToken: null,
      clientId: clientIdOverride,
      grantClientId: null,
      ...(flowRec !== null ? { pendingFlow: flowRec } : {}),
    });
  }

  /**
   * Forget the persisted flow — best-effort; the write is skipped
   * once a refresh grant exists (its own record write already
   * replaced the record), so it can never clobber a landed grant.
   */
  function clearPendingCustody(): void {
    pendingFlow = null;
    if (refreshToken !== null) {
      return;
    }
    void writePending(null);
  }

  /**
   * Re-arm a poll over the persisted device grant — used by restore
   * and by begin's resume branch. Identical to the live flow:
   * dismissal cancels it, a granted verdict applies and clears.
   */
  function resumePendingFlow(): void {
    const pending = pendingFlow;
    if (pending === null || flow !== null || pendingBegin !== null) {
      return;
    }
    const source = new CancellationSource();
    const grant: DeviceGrant = {
      deviceCode: pending.deviceCode,
      userCode: pending.userCode,
      verificationUrl: pending.verificationUrl,
      intervalMs: pending.intervalMs,
      expiresAtMs: pending.expiresAtMs,
    };
    flow = {
      source,
      grant,
      intervalMs: grant.intervalMs,
      creds: credsFor(pending.clientId),
    };
    status = {
      state: 'authorizing',
      userCode: grant.userCode,
      verificationUrl: grant.verificationUrl,
      expiresAtMs: grant.expiresAtMs,
    };
    publish();
    void runPollLoop(source, grant, grant.intervalMs);
  }

  function disarmRenew(): void {
    if (renewDisarm !== null) {
      renewDisarm();
      renewDisarm = null;
    }
  }

  function disarmPersist(): void {
    if (persistDisarm !== null) {
      persistDisarm();
      persistDisarm = null;
    }
    pendingGrantWrite = null;
  }

  async function persistRetry(): Promise<void> {
    const pending = pendingGrantWrite;
    if (pending === null) {
      return;
    }
    if (refreshToken !== pending.token) {
      pendingGrantWrite = null;
      return;
    }
    const wrote = await writeCustody(pending.record);
    if (refreshToken !== pending.token) {
      // The grant moved while the write was in flight — the newer
      // owner's write is already serialized behind it.
      return;
    }
    if (wrote.ok) {
      pendingGrantWrite = null;
      return;
    }
    persistDisarm = clock.arm(RENEW_RETRY_BASE_MS, () => {
      persistDisarm = null;
      void persistRetry();
    });
  }

  function armPersistRetry(): void {
    // Rearm the timer only — disarmPersist() would also drop the
    // pending record this retry exists to write.
    if (persistDisarm !== null) {
      persistDisarm();
      persistDisarm = null;
    }
    persistDisarm = clock.arm(RENEW_RETRY_BASE_MS, () => {
      persistDisarm = null;
      void persistRetry();
    });
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

  /** Host-slot writes serialize like custody writes — a pending
   *  apply can never land after a later clear and resurrect a
   *  dropped bearer. */
  let accessChain: Promise<unknown> = Promise.resolve();

  function writeAccess(token: string | null): Promise<void> {
    const next = accessChain.then(() =>
      Promise.resolve(deps.applyToken(token)),
    );
    accessChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function applyAccess(
    grant: TokenGrant,
    owner: string,
  ): Promise<void> {
    await writeAccess(grant.accessToken);
    if (refreshToken !== owner) {
      // The slot changed hands while the write was in flight — a
      // sign-out's null write is chained after ours; don't claim
      // liveness for a grant that no longer owns the slot.
      return;
    }
    accessExpiresAtMs = grant.expiresAtMs;
    const flipped = !bearerLive;
    bearerLive = true;
    renewFails = 0;
    armRenew();
    if (flipped) {
      // linked-but-dead → live transitions must reach subscribers —
      // recovery CTAs key off the flag, not just the state.
      publish();
    }
  }

  /**
   * A dead refresh grant: drop the credential everywhere. Custody is
   * rewritten (override preserved) rather than cleared so the
   * clientId preference survives re-pairing.
   */
  async function dropGrant(): Promise<void> {
    refreshToken = null;
    grantClientId = null;
    pendingFlow = null;
    accessExpiresAtMs = 0;
    bearerLive = false;
    disarmRenew();
    disarmPersist();
    renewFails = 0;
    try {
      await writeAccess(null);
    } catch {
      // A dead host still loses the bearer — custody clearing proceeds.
    }
    await writeCustody({
      v: 1,
      refreshToken: null,
      clientId: clientIdOverride,
      grantClientId: null,
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
    // The grant rides its issuing client for life — the override
    // preference may have moved since it was minted.
    const res = await oauth.refreshAccessToken(grantCreds(), token, {
      timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
    });
    if (refreshToken !== token) {
      // The grant changed while the exchange was in flight — sign-out
      // or a newer grant owns the slot now; applying this late mint
      // would resurrect a cleared bearer.
      return;
    }
    if (res.ok) {
      const grant = res.value;
      if (grant.refreshToken !== null && grant.refreshToken !== token) {
        // The issuer rotated the refresh grant — persist the
        // replacement atomically before applying the access mint; a
        // failed persist retries the lane against the new grant
        // (the old one may already be dead).
        refreshToken = grant.refreshToken;
        const record = {
          v: 1 as const,
          refreshToken: grant.refreshToken,
          clientId: clientIdOverride,
          grantClientId,
        };
        const wrote = await writeCustody(record);
        if (!wrote.ok) {
          // Keep exchanging on the rotated grant (the predecessor may
          // already be revoked) while its custody write retries on the
          // persist lane — the grant stays in memory until durable.
          if (refreshToken === grant.refreshToken) {
            pendingGrantWrite = { token: grant.refreshToken, record };
            armPersistRetry();
          }
          renewFails += 1;
          armRenewRetry();
          return;
        }
        if (refreshToken !== grant.refreshToken) {
          // A sign-out interleaved inside the rotation write — the
          // serialized null write already landed after ours.
          return;
        }
      }
      try {
        // Owner = the live refresh grant this mint answers —
        // post-rotation that's the replacement, otherwise `token`.
        await applyAccess(grant, grant.refreshToken ?? token);
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
    if (bearerLive && clock.now() >= accessExpiresAtMs) {
      // The slot's bearer has expired while renewals keep failing —
      // nothing usable sits in the host; say so (recovery CTAs key
      // off liveness) and clear the stale token.
      bearerLive = false;
      try {
        await writeAccess(null);
      } catch {
        // The flag is the truth consumers read; the host write is
        // best-effort against a possibly-dead sink.
      }
      publish();
    }
  }

  async function doRestore(): Promise<void> {
    const read = await custody.read();
    if (!read.ok) {
      restoreFailed = true;
      publish();
      return;
    }
    restoreFailed = false;
    if (read.value === null) {
      publish();
      return;
    }
    clientIdOverride = read.value.clientId;
    refreshToken = read.value.refreshToken;
    grantClientId = read.value.grantClientId;
    pendingFlow = read.value.pendingFlow ?? null;
    if (
      refreshToken !== null ||
      (pendingFlow !== null && pendingFlow.expiresAtMs <= clock.now())
    ) {
      // A grant landed while the app was gone, or the code already
      // lapsed — the record self-cleans on the next custody write.
      pendingFlow = null;
    }
    if (refreshToken !== null && status.state === 'signed-out') {
      // The stored grant IS the signed-in state — publish before the
      // first exchange resolves so a cold/offline boot still renders
      // honestly, then the renew loop does its first refresh now.
      status = { state: 'signed-in' };
    }
    publish();
    if (refreshToken !== null) {
      renewQueued();
    } else {
      // An approval interrupted mid-flight (sheet closed, process
      // killed while the user was in the browser) resumes silently —
      // a landed grant applies itself instead of being discarded.
      resumePendingFlow();
    }
  }

  /**
   * The memoized restore — retried per call while the last read
   * failed, so a transient store error heals on the next verb
   * instead of persisting as an unseen-record risk for the session.
   */
  async function ensureRestore(): Promise<void> {
    if (restored === null || restoreFailed) {
      restored = doRestore();
    }
    await restored;
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
      // Attempt identity — a dismissed/superseded attempt exits
      // silently; the newer owner already holds flow + status.
      let owned = flow;
      if (owned === null || owned.source !== source) {
        return;
      }
      if (!slept || source.signal.cancelled) {
        endFlow();
        status = { state: 'signed-out' };
        publish();
        return;
      }
      if (clock.now() >= grant.expiresAtMs) {
        clearPendingCustody();
        endFlow();
        status = {
          state: 'failed',
          error: appError('expired', 'oauth: device code expired'),
        };
        publish();
        return;
      }
      const res = await oauth.pollDeviceGrant(owned.creds, grant, {
        timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
        signal: source.signal,
      });
      owned = flow;
      if (owned === null || owned.source !== source) {
        return;
      }
      if (!res.ok) {
        endFlow();
        status = { state: 'failed', error: res.error };
        publish();
        return;
      }
      const verdict = res.value;
      // A granted reply wins even past the code's deadline — the
      // credential is real; only continuations re-check expiry.
      if (
        verdict.type !== 'granted' &&
        clock.now() >= grant.expiresAtMs
      ) {
        clearPendingCustody();
        endFlow();
        status = {
          state: 'failed',
          error: appError('expired', 'oauth: device code expired'),
        };
        publish();
        return;
      }
      if (verdict.type === 'pending') {
        continue;
      }
      if (verdict.type === 'slowDown') {
        interval += SLOWDOWN_STEP_MS;
        continue;
      }
      if (verdict.type === 'denied' || verdict.type === 'expired') {
        // The code is dead server-side — the persisted flow can't be
        // resumed, so forget it.
        clearPendingCustody();
        endFlow();
        status = {
          state: 'failed',
          error:
            verdict.type === 'denied'
              ? appError('permission-denied', 'oauth: denied')
              : appError('expired', 'oauth: device code expired'),
        };
        publish();
        return;
      }
      // granted — the attempt stays live through persistence so a
      // sheet dismissal or sign-out can still veto the mint.
      const token = verdict.grant;
      if (token.refreshToken === null) {
        // A grant with no refresh_token can't outlive its ~1h access
        // token — signing in on it would strand the user mid-session
        // with no renew path, so it's a typed failure, not a silent
        // half-linked state.
        clearPendingCustody();
        endFlow();
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
      if (restoreFailed) {
        // The store never read clean — persisting over unknown
        // contents could destroy a grant we never loaded.
        endFlow();
        status = {
          state: 'failed',
          error: appError('unavailable', 'oauth: custody read failed'),
        };
        publish();
        return;
      }
      refreshToken = token.refreshToken;
      grantClientId = owned.creds.clientId;
      // The grant write replaces the record whole — the persisted
      // flow is consumed.
      pendingFlow = null;
      const wrote = await writeCustody({
        v: 1,
        refreshToken: token.refreshToken,
        clientId: clientIdOverride,
        grantClientId,
      });
      if (flow?.source !== source || refreshToken !== token.refreshToken) {
        // Dismissed (flow dropped) or signed out (grant swapped)
        // while the write was in flight — retract the grant we just
        // stored when we still own it, then leave the newer owner's
        // state alone.
        if (refreshToken === token.refreshToken) {
          refreshToken = null;
          grantClientId = null;
          await writeCustody({
            v: 1,
            refreshToken: null,
            clientId: clientIdOverride,
            grantClientId: null,
          });
        }
        return;
      }
      if (!wrote.ok) {
        refreshToken = null;
        grantClientId = null;
        endFlow();
        status = { state: 'failed', error: wrote.error };
        publish();
        return;
      }
      try {
        await applyAccess(token, token.refreshToken);
      } catch (thrown) {
        endFlow();
        status = {
          state: 'failed',
          error: fromUnknown(thrown),
        };
        publish();
        return;
      }
      if (flow?.source !== source || refreshToken !== token.refreshToken) {
        // A dismissal/sign-out interleaved inside applyAccess — the
        // newer owner already cleared the slot; don't re-publish.
        return;
      }
      endFlow();
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
      return ensureRestore();
    },

    retryNow() {
      if (refreshToken === null) {
        return;
      }
      disarmRenew();
      renewQueued();
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
        await ensureRestore();
        // Attempt identity — a dismissed/superseded begin exits
        // silently; the newer owner already holds pendingBegin/state.
        if (pendingBegin !== source) {
          return;
        }
        if (restoreFailed) {
          pendingBegin = null;
          status = {
            state: 'failed',
            error: appError('unavailable', 'oauth: custody read failed'),
          };
          publish();
          return;
        }
        if (refreshToken !== null) {
          // Restore found a stored grant — the account is already
          // linked (its refresh is queued); publish that rather
          // than minting a second device code.
          pendingBegin = null;
          status = { state: 'signed-in' };
          publish();
          return;
        }
        if (flow !== null) {
          // Restore resumed a persisted flow — the poll is already
          // running under its own source.
          pendingBegin = null;
          return;
        }
        if (pendingFlow !== null && pendingFlow.expiresAtMs > clock.now()) {
          // An approval interrupted mid-flight resumes on the same
          // device code — the sheet shows the identical userCode and
          // the poll picks up where it left off.
          pendingBegin = null;
          resumePendingFlow();
          return;
        }
        if (pendingFlow !== null) {
          // Expired record — forgotten; the mint below rewrites it.
          pendingFlow = null;
        }
        const beginCreds = creds();
        const begun = await oauth.beginDeviceFlow(beginCreds, {
          timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
          signal: source.signal,
        });
        if (pendingBegin !== source) {
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
          creds: beginCreds,
        };
        // Persist the in-flight grant — a dismissed sheet or a killed
        // process must never discard the code the user is approving;
        // resume hooks re-arm the same poll on top of it.
        pendingFlow = {
          deviceCode: begun.value.deviceCode,
          userCode: begun.value.userCode,
          verificationUrl: begun.value.verificationUrl,
          intervalMs: begun.value.intervalMs,
          expiresAtMs: begun.value.expiresAtMs,
          clientId: beginCreds.clientId,
        };
        void writePending(pendingFlow);
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
      await ensureRestore();
      pendingBegin?.cancel();
      flow?.source.cancel();
      flow = null;
      pendingBegin = null;
      refreshToken = null;
      grantClientId = null;
      pendingFlow = null;
      accessExpiresAtMs = 0;
      bearerLive = false;
      disarmRenew();
      disarmPersist();
      renewFails = 0;
      // Host slot first — a custody failure below must never leave a
      // live bearer reachable.
      try {
        await writeAccess(null);
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
        grantClientId: null,
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
      await ensureRestore();
      if (restoreFailed) {
        return err(
          appError('unavailable', 'oauth: custody read failed'),
        );
      }
      const next = trimmed === '' ? null : trimmed;
      const wrote = await writeCustody({
        v: 1,
        refreshToken,
        clientId: next,
        grantClientId,
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
