/**
 * AppError → user-facing text. The toast pill and the persistent
 * error surfaces (player failed line, search/entity/lyrics panes,
 * sync pair errors, transfer details) all speak this — the raw
 * `kind — message` pair stays on console.warn and the diagnostics
 * rows, never on a user surface: an error surfaced from a native
 * bridge can embed raw exception text (a signed request URL inside
 * a fetch failure, say) that has no business on screen.
 *
 * `null` marks disposal outcomes — cancelled, superseded, released
 * are the caller's own teardown (a pause during prepare, a queue
 * jump overtaking a play), not a failure worth reporting.
 */
import type { AppError, ErrorKind } from '@auqw/application';
import { isMatchGate } from '@auqw/application';
import { t, type MessageId } from './i18n.ts';

// Supersession kinds only — 'released' is NOT silent: a live prepare
// can resolve released when its host drops the request, which strands
// playback with no other signal.
const SILENT: ReadonlySet<ErrorKind> = new Set(['cancelled', 'superseded']);

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
  cancelled: 'error.generic',
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
