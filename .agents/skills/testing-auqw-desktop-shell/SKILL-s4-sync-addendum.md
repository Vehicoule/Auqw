# Addendum to testing-auqw-desktop-shell/SKILL.md — suggested append

Suggested new sections to append to `SKILL.md` (knowledge learned testing `s4/sync-transport`):

## Renderer API is `window.auqw`, not `window.api`

`preload/index.ts` does `contextBridge.exposeInMainWorld('auqw', api)` — drive services via `window.auqw.sync.*` (status, pairing, devices, unpair, deltas, importDelta, trigger). DevTools opens with Ctrl+Shift+I as a **separate top-level window** ("Developer Tools - file://…"); maximize it with wmctrl. Top-level `await` works in the console. When the console prints a collapsed `{rejected: {…}}`, re-run wrapped in `JSON.stringify(...)` to see `kind`/`message` inline. Rejections surface as `Error` with `.kind` set by the preload's typed-error mapping.

## No OS keystore on this VM → everything gated on safeStorage degrades to 'unavailable'

This box has **no working secrets backend** (kwalletd5 crashes on dbus activation; Electron 44 ignores `--password-store=basic|mock`; no gnome-keyring). `safeStorage.isEncryptionAvailable()` → false → `secure-store.ts requireEncryption()` throws `unavailable` → `sync:keys` custody dead → the sync `start()` fails BEFORE binding → `status()` reports `listener:'unavailable'` honestly (the API still answers — it's honest degradation, not a bug; on a real desktop with a keyring this doesn't happen).

**Test-only unlock recipe** (plain-text encryption backend — still exercises the real SecureStore→safeStorage IPC; do NOT use for production evidence of encryption):

1. Launch electron WITH `--inspect=9330` (plus the usual `--remote-debugging-port=9222`).
2. Main-process eval via `scripts/cdp-inspect.mjs`:
   `node scripts/cdp-inspect.mjs 'process.mainModule.require("electron").safeStorage.setUsePlainTextEncryption(true); ""+process.mainModule.require("electron").safeStorage.isEncryptionAvailable()'`
   → `true`. (`process.mainModule.require` works in inspector eval; bare `require`/`import()` do not.)
3. Kill the utility child so the supervisor respawns it and re-runs the sync `start()`:
   `kill $(pgrep -f "node.mojom.NodeServic[e]" | head -1)` — the auqw utility child shows as `--type=utility --utility-sub-type=node.mojom.NodeService` (distinct from the mojom NetworkService utility). Respawn happens after ~100 ms backoff; `status()` then shows `listener:'listening'` + real `boundPort`.
4. Identity/keys persist to `~/.config/auqw-desktop/secure/*.b64` (base64-wrapped; plaintext mode). Wipe `~/.config/auqw-desktop` for a fresh-identity run.

## Proving the sync seam end-to-end

- `status()` shape is richer than early docs: `{listener, endpoint, boundPort, advertise, pairedDevices, sessions, lastSyncAt, engine, name, fingerprint}`; `engine:'absent'` until the engine leg lands. Pairing `expiresAt` is ~**90 s** out (`codeTtlMs ?? 90_000`).
- Cross-evidence the listener is real: `ss -tlnp | grep <boundPort>` → `LISTEN 0.0.0.0:<port>` owned by the electron utility pid; `bash -c 'exec 3<>/dev/tcp/127.0.0.1/<port> && echo OK'` proves TCP accept.
- Real wire handshake without a phone: `node scripts/sync-client.mjs <host> <port> <code|resume> <deviceId> [holdSecs]` speaks the real protocol (hello→challenge→noise-v1 seal→pair/welcome→open-phase ping/devices/sync→push listen). Rejected pair → sealed `{t:'reject',reason:'no-pairing'}`; unpair while connected → server closes the socket mid-hold.
- `trigger()` semantics: `{triggered:true}` only when a session is `phase==='open'`; offline paired devices land in `pendingSync` → `{pending:true}`.
- `unpair` resolves `undefined` (not the `invalid-response` shape a `return null` in the handler might suggest — the utility envelope normalizes null→undefined before the renderer validator).

## Gotchas that wasted time here

- `pkill -f <pattern>`/`pgrep -f` self-match: if your own shell command line contains the pattern (e.g. the string you're grepping), the pkill kills your shell → use the bracket trick (`pgrep -f "nod[e].mojom"`) or kill by PID.
- A konsole launched with `-e 'bash -c "...; sleep 600"'` is NOT interactive — typed input echoes but never executes. Launch plain `konsole --workdir /tmp`.
- `cdp-eval.mjs`/`cdp-inspect.mjs` need `(async()=>{...})()` wrappers for await; top-level `await` only works inside DevTools console itself.
- Rebuild `dist/` if it predates the branch HEAD — stale dist silently tests old code.
