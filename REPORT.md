# OAuth session-trust — productionize the "works without poToken" path — REPORT

Branch `devin/pb-oauth`. Turns the already-plumbed auth-token slot
(host merges `access_token` into session-trust payloads; the released
youtube-music 0.4.5 guest reads it) into a real user path: a
settings-row Google device-flow sign-in on both apps, sealed-custody
refresh grants, in-memory access tokens, expiry refresh, sign-out, and
a provider-wall recovery CTA. Anonymous playback is unchanged.

## What shipped where

### Shared core — `packages/application/src/auth/`

- `oauth.ts` — RFC 8628 client over one injected `http.postForm` seam:
  `beginDeviceFlow` (POST `oauth2.googleapis.com/device/code`, `youtube`
  scope), `pollDeviceGrant` (device_code grant, `authorization_pending`/
  `slow_down` verdicts), `refreshAccessToken` (refresh_token grant).
  Typed `Result` verdicts throughout; bounded field parsing; no secret
  ever enters an error message.
- `session.ts` — `AuthSession`: custody restore at boot, sign-in state
  machine (`authorizing` with live `userCode`/`verificationUrl`/
  `expiresAtMs`), cancel-safe polling (per-attempt abort + generation
  guard so a dismissed sheet leaves no zombie), armed refresh timer at
  `expiry − 60 s` (min 5 s), retry backoff 30 s → 10 min, `invalid_grant`
  /`unauthorized_client` drops custody + clears the host slot exactly
  once, client-id override persisted inside the custody record. A device
  grant lacking `refresh_token` fails sign-in rather than half-linking.

### Desktop — `apps/desktop/`

- `src/utility/auth.ts` + `src/utility/auth-custody.ts` — the OAuth
  client runs in the utility process; custody rides the `auth:custody`
  service channel up to main's `safeStorage` (dedicated `auth-secure`
  dir), mirroring `sync:keys`. Access tokens are applied via the napi
  `authToken` config thunk (`utility/host.ts`, `PluginHostLike`).
- `src/main/index.ts`, `src/main/ipc.ts`, `src/shared/{channels,contract,
  errors}.ts`, `src/main/auth-custody.ts` — `auth:status|begin|cancel|
  signOut|setClient|openUrl` channels (validated envelopes, app error
  kinds folded onto the shell vocabulary), `auth:state` push validated
  before relaying to renderers, `auth:openUrl` allowlists `*.google.com`
  hosts only, `AUQW_OAUTH_CLIENT_ID`/`AUQW_OAUTH_CLIENT_SECRET` join the
  utility env allowlist.
- `src/preload/index.ts` + `src/renderer/auth.ts` — `window.auqw.auth`
  verb surface + `AuthShellPort` adapter (single `ipcRenderer`
  subscription behind a fan-out, pull-then-subscribe so early snapshots
  aren't missed).

### Mobile — `apps/mobile/`

- `src/adapters/secure-auth.ts` — `expo-secure-store` custody (`key:
  auqw.auth.session`), mirroring `secure-sync-keys.ts`.
- `src/adapters/auth.ts` + `App.tsx` — `AuthShellPort` adapter around
  the session controller; grant restore at boot applies the access token
  through `controller.setAuthToken` (UniFFI `Option<String>` — cleared
  on sign-out).

### Shared shell + UI

- `packages/app-shell` — `AuthShellPort` on `AppShellPorts` (optional —
  no port, no account rows), `useSyncExternalStore` auth state, sheet
  open/cancel/retry/sign-out orchestration, wall-CTA wiring.
- `packages/ui-shared` — `toAuthSheetModel`, account settings rows,
  `PlayerModel.recovery = 'sign-in'` only when playback failed with a
  bot-check wall AND auth is explicitly signed out; locale strings in
  en/de/es/fr/zh.
- `packages/ui-web` + `packages/ui-native` — the sign-in sheet (code
  display, copy, open-link, waiting/linked/failed states, retry,
  sign-out, client-id editor) and the provider-wall CTA rendered under
  the original error line.

## client_id choice + rationale

Built-in default: the embedded YouTube-on-TV client
`861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68` — the public pair yt-dlp
and pytube ship for exactly this flow (scope `youtube`, device grant).
Provenance recorded in `docs/decisions.md` ("Auth & session trust").

**Live correction during verification:** the task spec carried a
transcription typo (`ba5oc68`); Google's device endpoint answered
`invalid_client`. Corrected to `ba3oc68` — `/device/code` then issued a
real `user_code`. The same live pass showed Google *requires* this
client's published `client_secret` on `/token`
(`invalid_request — Missing required parameter: client_secret` without
it), so `DEFAULT_OAUTH_CLIENT_SECRET` ships beside the id — it is a
public embedded credential, not an Auqw secret (unredactable; it appears
verbatim in yt-dlp source). An override id never inherits the default
secret — only `AUQW_OAUTH_CLIENT_SECRET` (or seam-dev creds) pairs with
it.

## Custody design

`AuthCustodyRecord {v:1, refreshToken, clientId}` — one sealed record.
Desktop: Electron `safeStorage` under `userData/auth-secure`, reachable
only by the utility through the `auth:custody` service channel. Mobile:
`expo-secure-store` (Keystore/Keychain). Access tokens are never
persisted — memory + host slot only. Sign-out deletes the record and
calls `setAuthToken(null)`; the host clears the slot on off-contract
values, so no bearer survives sign-out.

## Refresh policy

Armed timer at `expires_in − 60 s` (floor 5 s); failures retry 30 s →
10 min bounded backoff; `invalid_grant`/`unauthorized_client` drops
custody + host slot once. Chosen over lazy refresh: Google tokens carry
an honest `expires_in` (~3600 s), and prepared sessions re-read the slot
at re-mint so a healed token reaches in-flight recovery.

## Wall-CTA wiring

`error.providerWall` (engine `isBotCheckWall` path) + signed-out auth →
`PlayerModel.recovery = 'sign-in'` → a localized "sign in to fix
playback" CTA under the unchanged error copy, in both players. CTA opens
the same sign-in sheet; dismiss means the anonymous ladder as today.
Signed-in or non-wall failures render no CTA.

## Tests

New coverage (all fake-endpoint — no live Google calls):

- `auth/oauth.test.ts` — device-flow verdicts: malformed replies,
  endpoint error folding, `authorization_pending`/`slow_down`/
  `expired_token`/`access_denied`, refresh round-trip, secret pairing.
- `auth/session.test.ts` — restore (hit/miss/corrupt), sign-in happy
  path, cancel mid-poll, no-refresh-token grants rejected, expiry timer,
  refresh backoff, `invalid_grant` custody drop, sign-out ordering,
  override persistence, grant-drop not stomping in-flight sign-in.
- `apps/desktop` — `auth:custody` handler round-trip, channel
  validation, `auth:state` push gating, `PluginHostLike.setAuthToken`
  plumbing.
- `packages/ui-shared` — `toAuthSheetModel` states, account rows, wall
  gating (`recovery='sign-in'` iff wall ∧ signed-out), `toPlayerModel`.
- `app-shell` / `ui-native` — sheet orchestration + CTA rendering.

## Live verification (desktop, X display `:0`, real Electron)

Env: `XDG_CONFIG_HOME=/tmp/auqw-oauth-test`,
`AUQW_NODE_BINDINGS=<this worktree>/target/debug/libauqw_node_bindings.so`,
`AUQW_PLUGIN_DIR=<this worktree>/apps/desktop/plugins` (4 pinned
plugins synced + verified via `tooling/sync-plugins.mjs`),
`--password-store=gnome-libsecret` under `dbus-run-session` +
gnome-keyring (safeStorage path).

- **Boot → home** — product UI + dev harness both boot clean; single
  stable `node.mojom` utility PID, no respawns.
- **Settings → ACCOUNT → "google sign-in"** opens the sheet; live
  `/device/code` returned a real code `ZRD-MCF-LMRC` +
  `google.com/device`; status pushed
  `{state:'authorizing', userCode, verificationUrl, expiresAtMs}`.
  Screenshot: `/tmp/auqw-auth-sheet.png`.
- **copy code** → clipboard readback `ZRD-MCF-LMRC`.
- **openUrl allowlist** → `google.com` accepted;
  `evil.example.com` refused (`auth:openUrl refused host`).
- **Dismiss** → cancel → `{state:'signed-out'}`, poll stopped.
- **Failure surface** (earlier run, stale id) →
  `{state:'failed', error:{kind:'invalid-response', message:'oauth:
  device/code invalid_client'}}`, settings row "failed — tap to retry",
  sheet retry — the typed-verdict path exercised live.
- **Audio gate** — dev harness (`AUQW_DEV_HARNESS=1`) + ranged node:http
  fixture serving `/tmp/tone.mp3` (strict 206): `dev-prepared st-0-0
  (audio/mpeg)` → `playing · 2412ms/5000ms` (posMs advancing = the audio
  render pipeline is decoding) → `ended · 5000ms/5000ms`; fixture log
  shows `Range bytes=0-65535 -> 206`. Screenshot: `/tmp/auqw-dev-harness.png`.
- **Product playback** — search "daft punk" → catalog results → tap →
  youtube-music resolved + streamed "Aerodynamic" (0:25 / -3:06
  advancing, peaks rendering, radio queue growing). Anonymous ladder
  verified unchanged end-to-end on the live path.
  Screenshot: `/tmp/auqw-playing.png`.

## Live-found bugs fixed in this slice

1. Built-in client id typo (`ba5oc68` → `ba3oc68`) — device/code
   `invalid_client` live.
2. `client_secret` required on `/token` for the TV client — added the
   published default secret to the built-in credential.
3. `auth:state` listener leak — `createDesktopAuth` sat inside the
   `ports` memo whose deps churn on `syncStatus`; each rebuild wired a
   new `ipcRenderer` listener (11 warned live). Adapter hoisted to its
   own stable memo.
4. `dropGrant` could stomp an in-flight sign-in status; a device grant
   without `refresh_token` claimed a persistable link — both fixed in
   `session.ts`.

## Gates

```text
pnpm install --frozen-lockfile   ok (lockfile clean)
pnpm -r typecheck                ok (all packages + both apps)
pnpm -r test                     ok (application, app-shell, ui-shared,
                                   ui-web, ui-native, storage-sqlite,
                                   design-tokens, desktop, mobile)
cargo test -p auqw-host-surface -p auqw-mobile-bindings -p auqw-node-bindings
                                 ok (20 + 12 pass, rest empty)
```

## Diff stat

```text
git diff --stat origin/main...HEAD
48 files changed, 4042 insertions(+), 6 deletions(-)   (code only;
REPORT.md/PROMPT.md land in the docs commit)
```

## NOT covered (honest list)

- **End-to-end paired sign-in** — requires a Google account approval at
  `google.com/device`; no credentials exist on this box. Everything up
  to the approval is live-verified (code issuance, poll loop, cancel).
- **Provider-wall CTA live** — no bot-check wall materialized during
  the playback run (youtube-music resolved cleanly from this IP).
  Gating is unit-covered; the sheet path itself was driven live.
- **Refresh-token exchange against Google** — same blocker (needs a
  real grant). The exchange code path is identical to the device poll
  (same `/token` endpoint, same secret pairing, unit-covered); the
  `/token` request shape was verified live to reach
  `authorization_pending`.
- **Google consent-screen cosmetics** — the embedded TV client shows
  "YouTube on TV"-style wording on approval pages; a first-party Auqw
  client registration would brand it (reopen condition in decisions.md).
- **Mobile live run** — no Android device/emulator was exercised; the
  adapter mirrors the tested `secure-sync-keys` custody shape and
  typechecks, but device custody round-trip is unproven.
- **Multi-account** — custody holds one grant by design (`v:1` record);
  the reopen condition is logged in decisions.md.
