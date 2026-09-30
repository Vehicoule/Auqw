import { isAuthCustodyRecord } from '@auqw/application';
import { isAuthCustodyOp } from '../utility/auth-custody.ts';
import type { AuthCustodyOp } from '../utility/auth-custody.ts';
import { shellError } from '../shared/errors.ts';
import type { SecureStore } from './secure-store.ts';

/**
 * The `auth:custody` service — main-process half of the OAuth custody
 * channel, mirroring `sync:keys`. ONE sealed record under
 * `auqw.auth.session` holds `{v, refreshToken, clientId}`: the refresh
 * grant (credential) plus the client-id override (preference) stay in
 * one atomic write so a torn RMW can't drop one half. The record sits
 * in its own `auth-secure` store dir — `secure:*` renderer channels
 * reach only the renderer-facing store, so a sandboxed renderer can
 * never read a refresh token out of this custody.
 *
 * Every decryptString on macOS can fire a Keychain ACL prompt — the
 * SecureStore's promise cache already bounds that to one read per key
 * per process.
 */

const STORE_KEY = 'auqw.auth.session';

export function createAuthCustodyHandler(deps: {
  secure: SecureStore;
}): (args: unknown) => Promise<unknown> {
  const { secure } = deps;

  return async (args: unknown) => {
    if (!isAuthCustodyOp(args)) {
      throw shellError('invalid-request', 'auth:custody bad op');
    }
    const op: AuthCustodyOp = args;
    switch (op.op) {
      case 'get': {
        const text = await secure.get(STORE_KEY);
        if (text === null) {
          return { record: null };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw shellError('corrupt-state', 'auth custody is not json');
        }
        if (!isAuthCustodyRecord(parsed)) {
          throw shellError(
            'corrupt-state',
            'auth custody failed validation',
          );
        }
        return { record: parsed };
      }
      case 'set':
        // `isAuthCustodyOp` already certified the record shape —
        // re-serializing it verbatim keeps no undeclared fields.
        await secure.set(STORE_KEY, JSON.stringify(op.record));
        return null;
      case 'clear':
        await secure.delete(STORE_KEY);
        return null;
    }
  };
}
