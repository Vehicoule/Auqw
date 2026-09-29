/**
 * AppError → user-facing text. The toast pill and the persistent
 * error surfaces (player failed line, search/entity/lyrics panes,
 * sync pair errors, transfer details) all speak this — the raw
 * `kind` slug stays on console.warn and the diagnostics rows, never
 * on a user surface: an error surfaced from a native bridge can embed
 * raw exception text (a signed request URL inside a fetch failure,
 * say) that has no business on screen.
 *
 * `null` marks supersession outcomes — 'superseded' is the caller's
 * own teardown (a queue jump overtaking a play), an internal verdict
 * never worth reporting. 'cancelled' is NOT silent here: providers
 * also return it as a real failure (a remote request cancelled
 * mid-search), and teardown suppression belongs at the ops-level
 * call sites (reportResult/reportPlay) that know the intent was
 * superseded or disposed. `released` surfaces for the same reason:
 * a live prepare can resolve it when the host drops the request.
 */
import type { AppError, ErrorKind } from '@auqw/application';
import { isMatchGate } from '@auqw/application';
import { t, type MessageId } from './i18n.ts';

const SILENT: ReadonlySet<ErrorKind> = new Set(['superseded']);

// Exhaustive over ErrorKind — a new taxonomy kind fails typecheck
// until its copy lands in the `error.*` catalog section.
const TEXT_BY_KIND: Readonly<Record<ErrorKind, MessageId>> = {
  'no-result': 'error.noResult',
  'not-applicable': 'error.unsupported',
  unsupported: 'error.unsupported',
  'auth-required': 'error.auth',
  'auth-expired': 'error.authExpired',
  'rate-limit': 'error.rateLimited',
  transient: 'error.transient',
  'expired-resource': 'error.expiredLink',
  'permission-denied': 'error.permission',
  'invalid-response': 'error.unexpected',
  timeout: 'error.timeout',
  cancelled: 'error.transient',
  'budget-exceeded': 'error.limit',
  'guest-trap': 'error.plugin',
  'invalid-message': 'error.generic',
  'artifact-rejected': 'error.rejected',
  'streams-capped': 'error.capped',
  released: 'error.generic',
  superseded: 'error.generic',
  evicted: 'error.evicted',
  expired: 'error.expired',
  'not-found': 'error.notFound',
  unavailable: 'error.unavailable',
  'storage-full': 'error.storageFull',
  internal: 'error.generic',
};

/**
 * The one-line user-facing reason for `error`, localized — `null`
 * for absent and silent (disposal) errors. Surfaces pair it with
 * their own title; `reportResult` prefixes the failed action name.
 */
export function errorText(
  error: AppError | null | undefined,
): string | null {
  if (error === null || error === undefined || SILENT.has(error.kind)) {
    return null;
  }
  // The ambiguous-match gate is 'unavailable' under the hood but its
  // remedy is the review queue, not a retry.
  if (isMatchGate(error)) {
    return t('error.matchGate');
  }
  return t(TEXT_BY_KIND[error.kind]);
}
