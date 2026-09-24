import {
  hasOnlyKeys,
  isBoundedString,
  isRecord,
  isSafeNonNegativeInt,
} from '../shared/check.ts';
import { isShellError } from '../shared/errors.ts';
import type { UtilityRequest, UtilityResponse } from './envelope.ts';

export function isUtilityRequest(
  value: unknown,
): value is UtilityRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'channel', 'args']) &&
    isSafeNonNegativeInt(value['id']) &&
    isBoundedString(value['channel'], 128) &&
    Object.hasOwn(value, 'args')
  );
}

export function isUtilityResponse(
  value: unknown,
): value is UtilityResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'ok', 'result', 'error']) ||
    !isSafeNonNegativeInt(value['id'])
  ) {
    return false;
  }
  if (value['ok'] === true) {
    return (
      Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')
    );
  }
  if (value['ok'] === false) {
    return (
      isShellError(value['error']) && !Object.hasOwn(value, 'result')
    );
  }
  return false;
}

/**
 * Whether a raw inbound message carries an id a failure response can be
 * correlated to, even when the rest of the envelope is malformed.
 */
export function hasRequestId(value: unknown): value is { id: number } {
  return isRecord(value) && isSafeNonNegativeInt(value['id']);
}
