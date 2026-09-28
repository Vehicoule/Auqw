import type { AppError } from '../errors.ts';
import { appError } from '../errors.ts';

/** The shared op failure shapes every session lane reports. */
export function internalError(): AppError {
  return appError('internal', 'an internal error occurred');
}

export function timeoutError(): AppError {
  return appError('timeout', 'operation deadline exceeded');
}
