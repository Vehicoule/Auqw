import type { AppError } from '../errors.ts';
import { appError } from '../errors.ts';
import type { SourceRef } from '../domain.ts';

/** The shared op failure shapes every session lane reports. */
export function internalError(): AppError {
  return appError('internal', 'an internal error occurred');
}

export function timeoutError(): AppError {
  return appError('timeout', 'operation deadline exceeded');
}

export function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function sameRef(a: SourceRef | null, b: SourceRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.provider === b.provider && a.kind === b.kind && a.id === b.id;
}

export function saturatingAdd(a: number, b: number): number {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}
