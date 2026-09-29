# Playback fix — desktop error laundering + warm plugin init at boot

Branch `devin/pb-desktop`. Scope: `apps/desktop` shell/utility error maps
plus the utility entry point. No engine or contract changes.

## What was wrong (trace: `~/wt/pb-analysis/PLAYBACK-ANALYSIS.md` §2/§6)

One napi rejection crossed **two different kind maps** depending on which
renderer leg carried it:

- `stream:*`/`host:*` calls in `web-player.ts`/`provider.ts` classify via
  `rawToAppError` → `appErrorKind` → canonical `ERROR_KIND_BY_SLUG`
  (`packages/application/src/errors.ts`), where `io-error` → `transient`.
- `settleIpc` callers (`transfer-port`, `tag-reader`, `connectivity`,
  `controller`, `app.tsx`) classify via `SHELL_TO_APP` in
  `renderer/ipc-errors.ts`, where `io-error` → `internal`.

So a pump/transport death (napi slug `transient` → shell `io-error`)
reported `transient` on the player leg and `internal` on the other.
Meanwhile `rate-limit` → shell `unavailable` reached the engine as
**non-retryable** `unavailable` (`unavailable` is not in the app
RETRYABLE set — the 429's retryability was destroyed, not just renamed),
and `auth-required` → `io-error` read as transport death.

## The maps, before → after

### `SLUG_KIND` — napi slug → `ShellErrorKind` (`utility/stream.ts`)

| napi slug | before | after |
|---|---|---|
| `invalid-argument` | `invalid-request` | `invalid-request` |
| `not-found` | `invalid-request` | `invalid-request` |
| `invalid-response` | `invalid-response` | `invalid-response` |
| `released`/`evicted`/`expired`/`superseded` | `released` | `released` |
| `cancelled` | `cancelled` | `cancelled` |
| `unavailable` | `unavailable` | `unavailable` |
| **`streams-capped`** | `unavailable` | **`streams-capped`** |
| **`rate-limit`** | `unavailable` | **`rate-limit`** |
| **`transient`** | `io-error` | **`transient`** |
| **`auth-required`** | `io-error` | **`auth-required`** |
| `internal` | `internal` | `internal` |

### `ShellErrorKind` (`shared/errors.ts`)

Gained `transient`, `rate-limit`, `auth-required` (the envelope guard
`isShellError` only admits registered kinds — the passthrough required
widening the shell taxonomy). `transient` + `rate-limit` join the shell
RETRYABLE set; `auth-required` stays non-retryable, matching the app
taxonomy.

### `SHELL_TO_APP` — `ShellErrorKind` → `ErrorKind` (`renderer/ipc-errors.ts`)

| shell kind | before | after |
|---|---|---|
| **`io-error`** | `internal` | **`transient`** (agrees with `ERROR_KIND_BY_SLUG`) |
| **`transient`** | — | **`transient`** |
| **`rate-limit`** | — | **`rate-limit`** |
| **`auth-required`** | — | **`auth-required`** |

### Net effect end-to-end (rejection leg, both renderer maps agree)

| napi slug | app kind before | app kind after |
|---|---|---|
| `transient` | `internal` (settleIpc leg) / `transient` (rawToAppError leg) | `transient` |
| `rate-limit` | `unavailable` — **non-retryable** | `rate-limit` — retryable |
| `auth-required` | `internal` / `transient` | `auth-required` — terminal, `error.auth` copy |
| `streams-capped` | `unavailable` — **non-retryable** | `streams-capped` — retryable, agrees with the outcome leg |

Side effect of `io-error` → `transient`: shell-local IO failures
(storage, tags, transfer, secure-store, service timeouts, supervisor
posts) now report `transient` instead of `internal` app-side. Both kinds
are retryable in the app taxonomy, so retry behavior is unchanged; the
copy reads "try again" instead of the generic internal text — honest
for retryable IO weather.

## `retryAfter` plumbing — not possible today, nothing to plumb

Checked the native payload shape (`crates/node-bindings/src/lib.rs`
`typed_err`): the JSON blob is `{"code", "kind", "detail"}` —
`StreamError::RateLimited` (`crates/auqw-stream/src/error.rs`) carries
only a message, and nothing in `auqw-stream`/`host-surface`/`plugin-host`
parses a `Retry-After` hint into the error. `AppError.retryAfterMs`
exists and the engine honors it (`retry.ts:197-205`,
`playback-engine.ts:1628-1632`, `search-session.ts:291` fallback), so
the kind passthrough is the complete fix available at this seam: the
engine now sees `rate-limit` with its own backoff policy instead of a
non-retryable `unavailable`. If the seam later emits a hint, it needs a
new optional `retryAfterMs` on `ShellError` + a third `appError` arg —
deliberately not added now (no emitter = dead plumbing).

## Boot warm for `pluginsReady()`

`utility/index.ts`, immediately after `createHostRuntime(...)`:

```ts
void runtime.pluginsReady().catch((thrown) => console.warn(...));
```

- Fire-and-forget — deliberately **not** in the startup `Promise.all`
  that gates `port.start()`, so boot isn't blocked.
- Failure safety is already in `host.ts` `ready()`: a rejected init
  clears the memoized promise, so the first real `stream.prepare`
  retries the scan and surfaces its own typed error — the warm only
  logs.
- Logging is sanitized: `isShellError` gate prints `kind: message` (the
  ShellError text is taxonomy-safe by construction); a non-ShellError
  rejection (e.g. a raw `readdirSync` throw, which can carry fs paths)
  logs a fixed string.

## Tests

- `utility/stream.test.ts`: per-slug passthrough assertions for
  `transient`/`rate-limit`/`auth-required`, including the shell
  `retryable` flag per kind.
- `renderer/ipc-errors.test.ts` (new, registered in `desktop.test.ts`):
  the agreement property — every kind the stream/host legs emit
  classifies identically under `shellToAppError` and `rawToAppError`
  and equals `appErrorKind(kind)`; plus pinned behaviors
  (`io-error`→`transient` both legs, `rate-limit` retryable,
  `auth-required` terminal, message/fallback rules).

## Boot warm rides the bind settle

`pluginsReady()` chains after `potBound`: constructing while the
startup bind pends reads a null provider URL, and a failed bind +
shared-pending retry could strand a providerless host with nothing to
re-kick the read. After settlement the construction read matches a
first click exactly — success supplies the URL, failure kicks
`potRetry` (whose success pushes the port via `setPotProvider`).

## Known remaining divergences (flagged, not changed — outside the
named slugs)

- `invalid-request`: `invalid-message` (SHELL_TO_APP) vs
  `invalid-response` (`appErrorKind`) — deliberate per the map's
  comment; both non-retryable, only reachable on arg-validation bugs.
- `not-implemented`: `not-applicable` vs `unavailable` — same story.
- `napiStreamError`'s `not-found` → `released` fold on handle ops is
  intentional (decisions.md playback row on dead-handle semantics).
- Host-level napi slugs `load`/`unknown-plugin`/`request-in-flight`/
  `runtime` still fall through to `internal`.

## Diffstat

```
 apps/desktop/src/desktop.test.ts        |  2 ++
 apps/desktop/src/renderer/ipc-errors.ts | 10 ++++++++--
 apps/desktop/src/shared/errors.ts       |  7 +++++++
 apps/desktop/src/utility/index.ts       | 17 ++++++++++++++++-
 apps/desktop/src/utility/stream.test.ts | 16 ++++++++++++++++
 apps/desktop/src/utility/stream.ts      | 13 ++++++++-----
 apps/desktop/src/renderer/ipc-errors.test.ts | new (77 lines)
```

## Gates (all green)

```
pnpm -C apps/desktop typecheck        → clean
pnpm -C apps/desktop test             → desktop shell tests passed
pnpm -C packages/application typecheck → clean
pnpm -C packages/application test      → pass (incl. reliability harness)
pnpm -C packages/ui-shared typecheck   → clean
pnpm -C packages/ui-shared test        → ui-shared tests passed
```
