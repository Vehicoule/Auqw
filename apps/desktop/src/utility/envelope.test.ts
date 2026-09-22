import { assert } from '@auqw/application/testing';
import { shellError } from '../shared/errors.ts';
import {
  hasRequestId,
  isUtilityRequest,
  isUtilityResponse,
} from './validators.ts';

export function run(): void {
  const request = { id: 7, channel: 'utility:ping', args: { message: 'hi' } };
  assert(isUtilityRequest(request), 'well-formed request passes');
  assert(!isUtilityRequest({ ...request, id: -1 }), 'negative id');
  assert(!isUtilityRequest({ ...request, id: 1.5 }), 'non-integer id');
  assert(!isUtilityRequest({ ...request, id: '7' }), 'string id');
  assert(!isUtilityRequest({ ...request, channel: '' }), 'empty channel');
  assert(
    !isUtilityRequest({ id: 1, channel: 'utility:ping' }),
    'missing args key',
  );
  assert(
    !isUtilityRequest({ ...request, extra: true }),
    'unexpected key rejected',
  );
  assert(!isUtilityRequest(null), 'null rejected');
  assert(!isUtilityRequest([1, 'utility:ping', {}]), 'array rejected');

  const okRes = { id: 3, ok: true, result: { reply: 'pong' } };
  const errRes = {
    id: 4,
    ok: false,
    error: shellError('internal', 'boom'),
  };
  assert(isUtilityResponse(okRes), 'ok response passes');
  assert(isUtilityResponse(errRes), 'error response passes');
  assert(
    !isUtilityResponse({ id: 3, ok: true }),
    'ok without result rejected',
  );
  assert(
    !isUtilityResponse({ id: 3, ok: true, result: 1, error: {} }),
    'result+error together rejected',
  );
  assert(
    !isUtilityResponse({
      id: 4,
      ok: false,
      error: { kind: 'bogus', message: 'm', retryable: false },
    }),
    'unknown error kind rejected',
  );
  assert(
    !isUtilityResponse({ id: 4, ok: false }),
    'error response without error rejected',
  );
  assert(
    !isUtilityResponse({ id: 'x', ok: true, result: 1 }),
    'string id rejected',
  );

  assert(hasRequestId({ id: 3, garbage: [] }), 'id found in malformed msg');
  assert(!hasRequestId({ id: -2 }), 'invalid id not found');
  assert(!hasRequestId('nope'), 'non-record has no id');
}
