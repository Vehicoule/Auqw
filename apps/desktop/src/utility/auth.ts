import type { AuthCustody, AuthSession, ErrorKind } from '@auqw/application';
import { createAuthSession } from '@auqw/application';
import { isAuthSetClientArgs } from '../shared/contract.ts';
import type { ShellErrorKind } from '../shared/errors.ts';
import { isShellErrorKind, shellError } from '../shared/errors.ts';
import { guarded, type UtilityHandler } from './router.ts';

/**
 * The utility-side auth service: the shared `createAuthSession` runs
 * here (not in the sandboxed renderer — its CSP admits no remote
 * connect-src, and token material must never cross into it). Custody
 * rides the `auth:custody` service channel into main's sealed store;
 * `applyToken` pushes the access token into the host slot through the
 * runtime's lazy-bindings thunk + the live host's `setAuthToken`.
 *
 * Renderer channels: `auth:status` (pull) plus `auth:state` pushes
 * (relayed through main's push registry) keep the shell subscribed;
 * begin/cancel/signOut/setClient are the verbs. `auth:openUrl` is
 * handled in main — the utility owns no `shell.openExternal`.
 */

export const AUTH_STATE_CHANNEL = 'auth:state';

const noArgs = (v: unknown): v is undefined => v === undefined;

// The envelope vocabulary is narrower than the app's ErrorKind — fold
// the auth kinds it lacks onto their nearest sibling (the renderer's
// shellToAppError maps them back up; `auth-expired` reads as
// 'auth-required' — the UX remedy is the same sign-in).
const KIND_FOLD: Partial<Record<ErrorKind, ShellErrorKind>> = {
  'auth-expired': 'auth-required',
  'invalid-message': 'invalid-request',
  expired: 'transient',
  'expired-resource': 'transient',
  timeout: 'transient',
};

function toShellKind(kind: ErrorKind): ShellErrorKind {
  return isShellErrorKind(kind) ? kind : (KIND_FOLD[kind] ?? 'internal');
}

export function createAuthService(deps: {
  readonly custody: AuthCustody;
  readonly applyToken: (token: string | null) => void;
  /** Utility→main service post — validated + relayed to subscribers. */
  readonly push: (channel: string, args: unknown) => Promise<void>;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | null | undefined;
}): {
  readonly session: AuthSession;
  readonly handlers: Readonly<Record<string, UtilityHandler>>;
  readonly restore: () => Promise<void>;
} {
  const session = createAuthSession({
    custody: deps.custody,
    applyToken: deps.applyToken,
    ...(deps.clientId !== undefined ? { clientId: deps.clientId } : {}),
    ...(deps.clientSecret !== undefined && deps.clientSecret !== null
      ? { clientSecret: deps.clientSecret }
      : {}),
  });

  // Every publish forwards the snapshot to subscribed renderers —
  // fire-and-forget: a dead main-side listener is settled by the
  // service call's own timeout, not by awaiting it here.
  session.subscribe(() => {
    void deps.push(AUTH_STATE_CHANNEL, session.snapshot());
  });

  const handlers: Record<string, UtilityHandler> = {
    'auth:status': guarded('auth:status', noArgs, () =>
      Promise.resolve(session.snapshot()),
    ),
    'auth:begin': guarded('auth:begin', noArgs, () => {
      session.beginSignIn();
      return undefined;
    }),
    'auth:cancel': guarded('auth:cancel', noArgs, () => {
      session.cancelSignIn();
      return undefined;
    }),
    'auth:signOut': guarded('auth:signOut', noArgs, async () => {
      const result = await session.signOut();
      if (!result.ok) {
        throw shellError(toShellKind(result.error.kind), result.error.message);
      }
      return undefined;
    }),
    'auth:setClient': guarded(
      'auth:setClient',
      isAuthSetClientArgs,
      async (args) => {
        const result = await session.setClientOverride(args.clientId);
        if (!result.ok) {
          throw shellError(toShellKind(result.error.kind), result.error.message);
        }
        return undefined;
      },
    ),
  };

  return {
    session,
    handlers,
    restore: () => session.restore(),
  };
}
