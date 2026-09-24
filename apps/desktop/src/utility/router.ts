import { isUtilityPingArgs } from '../shared/contract.ts';
import {
  fromUnknown,
  isShellError,
  shellError,
} from '../shared/errors.ts';
import type { UtilityRequest, UtilityResponse } from './envelope.ts';

export type UtilityHandler = (args: unknown) => Promise<unknown>;

/**
 * Channel families that land on this process in later slices — storage,
 * stream, sync, transfer, and tag-reading port adapters. Until an
 * adapter registers a handler the family answers `not-implemented`
 * rather than `invalid-request`.
 */
const STUB_FAMILIES: readonly string[] = [
  'storage:',
  'stream:',
  'sync:',
  'transfer:',
  'tagread:',
  'local:',
];

function handlePing(args: unknown): Promise<unknown> {
  if (!isUtilityPingArgs(args)) {
    return Promise.reject(
      shellError('invalid-request', 'utility:ping expects { message }'),
    );
  }
  return Promise.resolve({ reply: 'pong', echo: args.message });
}

/**
 * Routes one validated request envelope to a handler and always answers
 * with a well-formed response envelope — handler exceptions surface as
 * typed errors, never raw throws across the process boundary.
 */
export function createUtilityRouter(
  handlers?: Readonly<Record<string, UtilityHandler>>,
): (request: UtilityRequest) => Promise<UtilityResponse> {
  const routes: Readonly<Record<string, UtilityHandler>> = {
    'utility:ping': handlePing,
    ...handlers,
  };
  return async (request) => {
    const handler = routes[request.channel];
    if (handler !== undefined) {
      try {
        const result = await handler(request.args);
        return { id: request.id, ok: true, result };
      } catch (thrown) {
        return {
          id: request.id,
          ok: false,
          error: isShellError(thrown) ? thrown : fromUnknown(thrown),
        };
      }
    }
    if (STUB_FAMILIES.some((family) => request.channel.startsWith(family))) {
      return {
        id: request.id,
        ok: false,
        error: shellError(
          'not-implemented',
          `channel ${request.channel} is not implemented yet`,
        ),
      };
    }
    return {
      id: request.id,
      ok: false,
      error: shellError(
        'invalid-request',
        `unknown channel ${request.channel}`,
      ),
    };
  };
}
