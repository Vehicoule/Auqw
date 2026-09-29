# Playback reliability: productionize OAuth session-trust (the "works without poToken" path)

You are in the Auqw repo at `/home/ubuntu/wt/pb-oauth` on branch `devin/pb-oauth`.
Commit to that branch as you go. Do NOT open a PR, merge, force-push, or touch other branches/worktrees.

## Context

The whole OAuth plumbing already exists end-to-end — only a production
user path is missing:

- Guest (Auqw-plugins, already released as 0.4.5 and pinned in
  providers.lock.json): `resolve`/`radio` payloads accept
  `access_token`; it rides `Authorization: Bearer` on InnerTube player
  calls — the session-trust header that lifts per-IP bot-check walls for
  account-backed sessions. Empty/absent → anonymous ladder (unchanged).
- Host: `PluginHost::set_auth_token(Option<String>)` (host-surface lib.rs
  ~577) merges `access_token` into every session-trust payload; prepared
  sessions read the same slot at re-mint so a refresh heals in-flight
  recovery. Off-contract values (empty/>8192) clear the slot. Bound on
  mobile (`mobile-bindings` UniFFI `setAuthToken`) and desktop
  (`node-bindings` napi `setAuthToken` / `authToken` field).
- A WORKING device-flow reference implementation lives in
  `apps/mobile/seam-dev.ts` (~lines 102-135 constants + the
  `seam-auth-start`/`seam-auth-poll`/`seam-auth`/`seam-auth-clear` deep
  links ~lines 480-600): `oauth2.googleapis.com/device/code` +
  `/token`, scope `youtube`, device_code grant, refresh-token reuse,
  client creds from param or JSON file. Productionize this shape — the
  seam-dev file itself stays a dev tool (don't add production callers to
  it).
- Provider wall surfaced: engine fix on main (`isBotCheckWall`,
  `error.providerWall` localized copy, no auto-retry) — a wall today is
  a dead-end message. This slice turns it into a recovery affordance.

## Goal — one slice, both apps

1. **OAuth client**: pick the right client_id strategy. Research what the
   codebase/git history/docs say first; if none, the well-known embedded
   YouTube-on-TV client (`861556708454-d6dlm3lh05idd8npek18k6be8ba5oc68`,
   device-flow scope `youtube`) is what yt-dlp/youtube-music clients use —
   document the choice + provenance in docs/decisions.md (a new auth
   capability IS a decision-log event). User-supplied client_id must stay
   supported (the seam-dev creds flow already allows it — keep an
   advanced field/override).
2. **Token custody**: refresh token is a credential — store like sync
   custody, not in plain prefs. Desktop: `apps/desktop/src/main/secure-store.ts`
   consolidated sealed record (#171). Mobile: the secure adapter precedent
   `apps/mobile/src/adapters/secure-sync-keys.ts` (Keystore-backed) —
   mirror that for the auth record. Read each first; match the pattern.
   Access token lives only in memory/host slot (short-lived).
3. **Boot + refresh**: on app start, if a stored refresh token exists,
   exchange it for an access token (googleapis `/token`,
   grant_type=refresh_token) and call `setAuthToken` on the host binding.
   Re-refresh on expiry (~3600s tokens) — a timer or a lazy refresh when
   the seam reports the token near-expired is fine; keep it simple and
   explain the choice.
4. **Sign-in UX (both apps, via app-shell)**: a settings row — "Sign in
   with Google" — that runs the device flow: show `user_code` +
   `verification_url` (copyable code, opens browser), poll until
   success/expiry/dismiss, then store custody + setAuthToken. Localized
   strings in all 5 locales (follow `packages/ui-shared/src/locales`
   shape). Signed-in state must render (account-linked + sign-out).
5. **Wall escape**: when `error.providerWall` (or the `isBotCheckWall`
   path) fires and no auth token is set, the player/settings surface
   should offer "sign in to fix playback" as the recovery CTA — not just
   a dead error line. Keep it a CTA, not a modal trap — dismissed means
   anonymous ladder as today. Wire through the app-shell error surface;
   keep the existing copy for the error line itself.
6. **Sign-out**: clears custody, `setAuthToken(null)`/`setAuthToken()`
   (check the binding's Option shape — mobile UniFFI takes
   `Option<String>`), anonymous ladder resumes. No cached bearer must
   survive sign-out (verify what the host does on clear — off-contract
   clears the slot).

## Hard rules

- **No secrets in code, logs, fixtures, or commits.** The refresh/access
  tokens and client_secret never hit console/logcat/slog — use the
  existing redaction helpers (`apps/desktop/src/shared/redact.ts` covers
  Bearer patterns; mirror coverage if a new seam logs). `slog` lines in
  seam-dev already exclude device_code — keep that discipline.
- **Behavior-identical when signed out**: anonymous users see ZERO
  change except the new settings row and the wall CTA. No new required
  permission, no new bundled dependency without a decisions.md entry
  (prefer implementing the flow over the existing fetch/https stack —
  the seam-dev file already does it with fetch).
- Device flow UI must handle: user closes the sheet mid-poll (cancel +
  no zombie polls), code expiry, network errors (typed verdicts, honest
  copy — reuse the error-text machinery), duplicate sign-in attempts.
- Tests: unit-cover the token exchange + custody round-trip + wall-CTA
  gating + sign-out clearing where the existing suites mock (see
  `controller.test.ts`, `desktop.test.ts`, app-shell tests). No live
  Google calls in tests — fake the endpoints.
- Keep exactOptionalPropertyTypes strictness. Minimal edits elsewhere.

## Gates (all must pass before you finish)

```bash
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test
pnpm -C apps/mobile typecheck && pnpm -C apps/mobile test
pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test
cargo test -p auqw-host-surface -p auqw-mobile-bindings -p auqw-node-bindings 2>/dev/null | tail -5
```

## Deliverable

`~/wt/pb-oauth/REPORT.md`: what shipped where (files), the client_id
choice + rationale, custody design, refresh policy, wall-CTA wiring,
test list, `git diff --stat origin/main...HEAD`, and the honest list of
what is NOT covered (e.g. Google "unverified app" consent screen notes,
device-flow UX limits).
