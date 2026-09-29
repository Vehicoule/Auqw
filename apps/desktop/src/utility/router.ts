import { isUtilityPingArgs } from '../shared/contract.ts';
import {
  fromUnknown,
  isShellError,
  shellError,
} from '../shared/errors.ts';
import type { UtilityRequest, UtilityResponse } from './envelope.ts';

export type UtilityHandler = (args: unknown) => Promise<unknown>;

/** validate-then-run handler — the utility-side arg boundary. */
export function guarded<A>(
  name: string,
  validate: (value: unknown) => value is A,
  run: (args: A) => Promise<unknown> | unknown,
): UtilityHandler {
  return async (args) => {
    if (!validate(args)) {
      throw shellError(
        'invalid-request',
        `invalid arguments for ${name}`,
      );
    }
    return run(args);
  };
}

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
