# Releasing auqw

**Status: Decided** — alpha channel mechanics (rows in
`docs/decisions.md`); post-alpha signing and store channels stay Open
in `apps/mobile/PACKAGING.md`.

## Scheme

- Product version is **semver `MAJOR.MINOR.PATCH`** with an optional
  channel suffix: `0.0.1-alpha.1`. While nothing is stable the line
  lives on `0.0.x`; `-alpha.N` marks pre-release builds, `-alpha.2`
  bumps it, a bare `v0.0.1` publishes the first stable of that line.
- Repo manifests (`apps/desktop/package.json`,
  `apps/mobile/package.json`, `app.config.ts`) carry the version
  *currently in development* — today `0.0.1-alpha.1`. One product
  version across the monorepo; internal package.json versions ride
  the same stamp.
- The **git tag is the build-time source of truth**: the release
  workflow runs `tooling/stamp-version.mjs <tag>` before any build,
  so every artifact embeds its own tag — never the repo's line.

## Cutting a release

```sh
git fetch origin
git tag v0.0.1-alpha.1 origin/main
git push origin v0.0.1-alpha.1
```

`.github/workflows/release.yml` runs on `v*`:

| Job | Produces |
|-----|----------|
| `desktop` | `auqw-<ver>-linux-x86_64.AppImage`, `.tar.gz`, `.flatpak` + `SHA256SUMS.txt` |
| `android` | `auqw-<ver>-android-debug.apk` (debug-signed — installable, not Play-ready) |
| `release` | a GitHub Release titled `<ver>` (`--prerelease` when the tag has a `-` suffix) with all assets + generated notes |

## Downloads

`https://github.com/Vehicoule/Auqw/releases` — newest first; per-tag
assets at `/releases/tag/<tag>`. GitHub's `/releases/latest` resolves
only *stable* releases — it starts working the day a bare `v*` tag
ships; for alpha, link the tag page.

## Open decisions (carried from PACKAGING.md)

- **Desktop signing**: alpha ships unsigned binaries + `SHA256SUMS.txt`.
  Signing/notarization reopens when a distribution channel is picked.
- **Android signing**: alpha ships the debug-signed APK. A real upload
  key waits on the Path A (EAS) vs Path B (local Gradle) ratification.
- **auqw-plugins checkout**: private plugins repos need a
  `PLUGINS_CHECKOUT_TOKEN` PAT secret; public reads under
  `GITHUB_TOKEN`.
- **iOS**: post-release (PACKAGING.md).
