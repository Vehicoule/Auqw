# Playback fix — desktop error laundering + warm plugin init at boot

Repo: `/home/ubuntu/wt/pb-desktop` (branch `devin/pb-desktop`). Commit to that branch as you go. Do NOT open a PR, merge, force-push, or touch other branches.

## Context (verified trace — `~/wt/pb-analysis/PLAYBACK-ANALYSIS.md` §2/§6)

1. **Dual laundering of the same error.** Native slug `transient` → shell `io-error` (`apps/desktop/src/utility/stream.ts:31-46`), then `io-error` → app `internal` via `SHELL_TO_APP` (`apps/desktop/src/renderer/ipc-errors.ts:36`) — but the prepare-outcome path maps `io-error`→`transient` via `appErrorKind`/`rawToAppError`. The same pump/transport death becomes `internal` on one leg and `transient` on another. Pick `transient` — it's the honest kind for stall/read-deadline/provider transport and it's already what `web-player.ts`'s element-error probe and `onFail` report.

2. **`rate-limit` → `unavailable` loses `retryAfter`** (`utility/stream.ts:42`). Map it through so the engine sees `rate-limit` (and preserves any `retryAfter` the native side carries — check the slug payload shape: if `retryAfter` exists on the napi error, it must reach the AppError).

3. **`auth-required` → `io-error` mislabels** (`stream.ts:44`) — an auth wall reads as transport death. Map it to `auth-required`.

4. **First-play `pluginsReady()` latency.** `apps/desktop/src/utility/stream.ts:184` `streamPrepare` calls `pluginsReady()` — a one-time lazy plugin-dir scan + wasm load that rides the FIRST-ever `stream.prepare` (the user's first click pays it). Warm it at utility startup instead — find the utility entry point/init function and kick off `pluginsReady()` (fire-and-forget with error logging, don't block startup; failures must still surface on the real prepare path).

## Constraints

- Only touch `apps/desktop/src/utility/stream.ts`, `apps/desktop/src/renderer/ipc-errors.ts` (or wherever the maps live — verify paths first), and the utility init file for the boot warm.
- Check every map site for the same slugs — if `SHELL_TO_APP` and `appErrorKind`/`rawToAppError` both exist, make them agree; do NOT create a third map.
- `retryAfter` — if the AppError type has no field for it, check what the engine does with `rate-limit` today before plumbing a new field; minimal change.
- Keep tests green and extend them if a slug-map test exists.

## Gates

```bash
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
cd ~/wt/pb-desktop
pnpm install --frozen-lockfile   # once
pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test
pnpm -C packages/application typecheck && pnpm -C packages/application test
pnpm -C packages/ui-shared typecheck && pnpm -C packages/ui-shared test
```

## Deliverable

`~/wt/pb-desktop/REPORT.md`: the maps before/after per slug, whether `retryAfter` plumbing was possible, where the boot warm was wired, diffstat.
