---
name: testing-auqw-update-flow
description: How to exercise the desktop Linux update flow end-to-end (AppImage install leg + flatpak 'open' leg) against the /tmp/auqw-sim feed fixture — the quiet world-bar icon entry + engaged UpdateCard, restart-handoff marker proof, residue checks, click geometry, routing table, and the xdg-open→CDP dependency for 'get it'.
---

# Testing the auqw desktop Linux update flow (icon entry + engaged UpdateCard)

Extends `testing-auqw-desktop-electron` — the update surface legs.

## Fixture (/tmp/auqw-sim, provided per-run or recreate from PR context)

- `feed.mjs` — self-signed HTTPS GitHub-releases-shaped feed on 127.0.0.1:4477.
  Knobs: `FEED_PORT`, `FEED_BPS` (250000 ≈ 16s download — cancel-friendly),
  `FEED_PAD` (artifact size). Node is NOT on PATH — restart with the nvm path:
  `setsid nohup env FEED_BPS=250000 ~/.nvm/versions/node/v24.19.0/bin/node /tmp/auqw-sim/feed.mjs >> /tmp/auqw-sim/feed.log 2>&1 &`
- The artifact is a script logging `NEW-APPIMAGE-EXEC <ts> <argv>` to
  `/tmp/auqw-sim/ran.log` then `exec electron "$@"`. **The marker line is the
  only proof the restart exec'd the replaced `$APPIMAGE` and not
  `process.execPath`** — truncate ran.log before the restart step.
- `launch-appimage.sh` (APPIMAGE leg → 'install'), `launch-flatpak.sh`
  (FLATPAK_ID → 'open'). Both set `AUQW_UPDATE_RELEASES_URL` (dev-only seam,
  gated on `!app.isPackaged`), bindings/plugin env, and
  `--ignore-certificate-errors` (required for the self-signed feed).
- Boot sweep check: `touch ${APPIMAGE}.new ${APPIMAGE}.new.part` + a file in
  `~/.config/auqw-desktop/updates/` before launch — all gone once the window
  renders.
- A konsole running `watch -n0.5 'ls -l /tmp/auqw-sim/appimage; echo ---;
  tail -5 /tmp/auqw-sim/ran.log; echo ---; tail -3 /tmp/auqw-sim/feed.log'`
  beside the window gives live .part/residue/marker/feed-hit evidence.

## Icon entry + engaged card (post-8e09920 surface)

- NO card/pill ever pops uninvited. The download `IconButton` sits in the
  world-bar end cluster LEFT of the hamburger ≡ (tool coords ≈ **973,9** at
  1024x768 mapping of a 3200x2400 screen; icon is tiny — zoom the strip
  [850,0,1024,40] first).
- Accent dot (8px, top-right of the button) badges when the update model has
  something (warn color on `failed` chip). `updateCard === null` → no dot —
  that covers checking, check failures, dismissed versions, and settled
  'applied'.
- Card (when engaged) is anchored `top:44 right:8` under the cluster —
  tool coords ≈ x 880..1016, y 14..26. Action label
  ('install'/'cancel'/'restart'/'get it'/'retry') ≈ **x=990, y=20**; × ≈
  **x=1011**. The close slot is RESERVED when not dismissible — the action
  button does NOT right-shift between states anymore.

### Press routing (b37f244+)

| icon press when…            | result                                        |
| --------------------------- | --------------------------------------------- |
| `updateCard === null`       | silent `check('manual')` only — NEVER acts    |
| engaged + dismissible card  | collapse (non-destructive; run continues)     |
| engaged + live run          | nothing — card stays (cancel reachable)       |
| disengaged + 'idle' chip    | engage + act (download / open / restart…)     |
| disengaged + stored/failed  | engage only — reveals restart/retry buttons   |

- × on a settled card = dismiss version + collapse; the offer (and dot) stays
  hidden for the session — restart the app to clear `dismissedVersion`.
- The dismissed-hidden press is the cleanest silent-check probe: feed.log
  should show exactly one `GET /releases` and no artifact/SHA256SUMS hits.
- The relaunched app re-offers via DOT ONLY (fresh session, card disengaged).

## 'get it' (openExternal) needs devin Chrome alive

`shell.openExternal` → `~/.local/bin/xdg-open` →
`curl -XPUT localhost:29229/json/new?<url>` — needs devin's Chrome for
Testing (CDP :29229) running; if closed, open() fails silently. Relaunch:

```
setsid nohup env DISPLAY=:0 /opt/.devin/chrome/chrome/linux-*/chrome-linux64/chrome \
  --remote-debugging-port=29229 --no-first-run \
  --user-data-dir=$HOME/.config/google-chrome-for-testing &
```

404 on the fake tag is expected — only the omnibox URL matters.

## Gotchas

- auqw window bounds persist across restarts — apply `wmctrl -e` AFTER the
  window settles for the 640px check.
- Batch icon→wait→cancel clicks in ONE computer call; wall-clock gaps can
  let the download finish and flip the card (a 'cancel'-aimed click then
  hits 'restart' or ×).
- Fixture-seeded files in /tmp/auqw-sim/appimage (e.g. a copy named after
  the artifact) are debris, not app residue — app stage files are always
  `${APPIMAGE}.new[.part]`.
