# Android packaging plan

**Status: Open** — plan awaiting ratification in the docs-repo decision
log (`../docs/decisions.md`, not vendored here). Every "recommend" below
is a proposal, not a settled choice; each carries its reopen condition.
Once ratified, the picked path moves into the decision log and this doc
keeps only the how-to.

Current state: `app.config.ts` pins `com.vehicoule.auqw`; the release
workflow stamps the version from the git tag. No `eas.json`, no
checked-in `android/` (CNG — `expo prebuild` regenerates it,
gitignored). **Alpha already signs**: `plugins/with-alpha-signing.cjs`
injects `signingConfigs.alpha` when `AUQW_ALPHA_KEYSTORE_FILE` is set —
the release workflow decodes the keystore from the
`AUQW_ALPHA_KEYSTORE_B64` repo secret (credentials never enter the
repo; missing secrets fall back to debug signing) and repoints the
release buildType — shipping `assembleRelease` APKs under one
consistent alpha identity. What stays Open below is only the
post-alpha signing story (real upload key, distribution channel). iOS
is post-release —
the provisional `expo-audio` path stays until the native seam lands,
and App Store signing needs an Apple Developer account anyway; not
covered here.

## Build inputs (unchanged by signing choice)

Every Android artifact needs, in order:

1. `./tooling/build-android-bindings.sh` — UniFFI Kotlin + `jniLibs` `.so`
   (arm64-v8a + x86_64; release profile).
2. `pnpm install` + `pnpm sync-plugins` — provider wasm manifests land in
   `assets/plugins/`.
3. `npx expo prebuild --platform android` — generates `android/` with
   `com.vehicoule.auqw`, the Media3 service manifest entries, adaptive
   icons.

## Path A — EAS Build (recommended for distribution)

*Open — vs Path B; reopen if the project moves off Expo-hosted builds
(cost, offline CI, or an org-wide no-SaaS rule).*

Needs an Expo account + `eas init` (mints `extra.eas.projectId` in
`app.config.ts`). Drop in `apps/mobile/eas.json`:

```json
{
  "cli": { "appVersionSource": "remote" },
  "build": {
    "preview": {
      "android": { "buildType": "apk" },
      "distribution": "internal"
    },
    "production": {
      "android": { "buildType": "aab" },
      "autoIncrement": true
    }
  }
}
```

- `eas build -p android --profile preview` → signed APK, installable
  via `adb install` or the internal-distribution link — this is what the
  two-device gate consumes.
- `eas build -p android --profile production` → AAB for Play Console.
- EAS-managed credentials: `eas build` generates and stores an **upload
  key** server-side on first run; nothing key-shaped ever enters the
  repo. Play App Signing holds the real app-signing key at Google, so
  the upload key stays rotatable.
- `appVersionSource: remote` + `autoIncrement` makes EAS own
  `versionCode`; alternatively keep explicit `android.versionCode` in
  `app.config.ts` (see versioning below).
- **Prebuilt inputs must reach the upload archive.** With no
  `.easignore`, EAS derives upload exclusions from `.gitignore`, and both
  `modules/auqw-expo/android/src/main/jniLibs/` and
  `apps/mobile/assets/plugins/` are ignored — so a clean upload arrives
  without either input and no hook regenerates them (the `.so`s need the
  Rust + NDK toolchain EAS builders don't carry). `.easignore` *replaces*
  `.gitignore` for the upload, so ship one (copy `.gitignore`, drop those
  two lines) and build inputs locally before `eas build`. Open —
  verify on the first real `eas build` run.

## Path B — fully local (no EAS account)

`./gradlew assembleRelease` on the prebuilt project needs a signing
config from somewhere — AGP's default release buildType carries none.
Because `android/` is regenerated, signing config lives in a **config
plugin**, not a hand-edit. The alpha channel already implements the
env-fed variant of this recipe (`with-alpha-signing.cjs` reading a
CI-secret keystore); the `keystore.properties` design below is the same
plugin shape pointed at a developer-local key file — either way the
real upload key never enters the repo.

1. One-time, outside the repo:

   ```sh
   keytool -genkeypair -v -storetype PKCS12 \
     -keystore ~/.android/auqw-upload.keystore \
     -alias auqw-upload -keyalg RSA -keysize 2048 -validity 10950
   ```

   The upload key + its passwords live in the team secret store /
   Devin org secrets — never in the repo, never in CI logs.

2. `apps/mobile/keystore.properties` (add to `.gitignore` before first
   commit):

   ```properties
   storeFile=/absolute/path/auqw-upload.keystore
   storePassword=...
   keyAlias=auqw-upload
   keyPassword=...
   ```

3. A `plugins/withReleaseSigning.js` config-plugin mod appended to
   `app.config.ts`'s `plugins` array injects into
   `android/app/build.gradle`:

   ```gradle
   def kp = new Properties()
   // rootProject is apps/mobile/android — ../ resolves to
   // apps/mobile/keystore.properties.
   def kf = rootProject.file('../keystore.properties')
   if (kf.exists()) { kf.withInputStream { kp.load(it) } }
   android.signingConfigs.release {
       if (kp.storeFile != null) {
           storeFile file(kp.storeFile)
           storePassword kp.storePassword
           keyAlias kp.keyAlias
           keyPassword kp.keyPassword
       }
   }
   android.buildTypes.release.signingConfig = android.signingConfigs.release
   ```

   (Equivalent shape via `gradle.properties` `MYAPP_UPLOAD_*` vars —
   the standard AGP recipe — also works; either way secrets stay out of
   git.)

4. `./android/gradlew -p android assembleRelease` →
   `android/app/build/outputs/apk/release/app-release.apk` (signed,
   installable); `bundleRelease` → `app-release.aab` for Play.

## Signing strategy — what to ratify

*Open — ratify before the first distributed artifact; reopen when a
distribution channel is picked (Play vs direct APK), because "upload
key" only makes sense under Play App Signing.*

- **Upload key, not a shared "release" key**: Play App Signing holds the
  app-signing key at Google; our keystore is only the upload key — one
  generated key, stored outside the repo (EAS-managed or
  `~/.android/`), rotatable via Play Console if it ever leaks.
- **Debug keystore**: AGP's auto-generated `debug.keystore` under
  `android/` is disposable and never committed (already covered — the
  whole `android/` dir is gitignored).
- **Same identity desktop↔mobile**: the signing question is orthogonal
  to the sync pairing identity — pairing derives per-device X25519
  keys at first launch (`utility/sync-keys`, sealed-auth QR + 6-digit),
  not from APK signatures.

## Versioning

*Open — one owner for `versionCode` must be picked before any release
build; reopen if the EAS-vs-local decision flips.*

- `version` (semver, user-facing): `app.config.ts` `version` is the
  single source of truth (kept in step with `package.json`
  `"version"`).
- `versionCode` (integer, Play-facing): today absent → prebuild emits
  `1`. Add `android.versionCode` to `app.config.ts` for the local path,
  or let EAS own it (`appVersionSource: remote`, `autoIncrement`).

## APK vs AAB

- **APK** (`assembleRelease`, EAS `buildType: apk`): directly
  installable — `adb install`, file share. Required for the two-device
  gate and any dogfood build.
- **AAB** (`bundleRelease`, EAS `buildType: aab`): Play Console only —
  Play re-signs per-device. Not sideloadable.

## What the two-device gate needs from the artifact

1. A signed APK installed on two physical devices (emulator evidence is
   provisional only — LAN multicast + real radios are the point).
2. First-launch pairing: one device shows the QR payload, the other
   scans (or enters the 6-digit code), then sealed-auth session over
   LAN — the `_auqw._tcp.local` mDNS service advertised by
   `utility/sync-mdns` must be reachable, so both devices on the same
   LAN with multicast unfiltered.
3. Evidence: delta push/pull applied between the two installs, `ping`/
   `devices`/`sync-request` typed results — not log claims.
