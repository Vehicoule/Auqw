# Auqw Full Project Plan

## 1. Frozen Direction

Auqw is a cross-platform music player built around a native Qt/QML shell and a durable Zig core.

Core identity:

```text
Product name: Auqw
Repository/folder: Auqw
Executable: auqw
Developer domain / app id: com.Vehicoule.auqw
Core library: libauqw_core
```

Primary targets:

```text
Windows
macOS
Linux via Flatpak
FreeBSD source build first
Android
iOS
```

Distribution targets:

```text
Codeberg releases
GitHub mirror
No app stores as primary target yet
```

Hard product constraints:

```text
No yt-dlp dependency
No account login in v1
Provider code must be isolated
Qt/C++ owns platform integration
Zig owns durable app logic
```

## 2. Architecture

Main stack:

```text
QML UI
  -> C++ Qt controllers
  -> C++ bridge wrapper
  -> small typed C ABI
  -> Zig Auqw core
  -> SQLite later
```

Language ownership:

| Area | Owner |
| --- | --- |
| UI | Qt/QML |
| Windowing, menus, tray, shortcuts, file dialogs | C++/Qt |
| App controllers | C++/Qt |
| C ABI boundary | C header + Zig exports |
| Durable app state | Zig |
| Queue, playback state, library, playlists | Zig |
| Database | SQLite from Zig |
| Actual audio playback | C++/Qt and native platform adapters |
| First online provider spike | C++/Qt |
| Stable provider abstraction | Zig-facing normalized models |

Bridge rules:

```text
Use opaque Zig-owned handles.
Use typed C ABI functions.
Use JSON only for rich payloads after a typed function owns the command.
Do not expose Zig internals to C++.
Do not expose provider-specific data to QML.
Do not import Qt/C++ headers into Zig.
```

Current ABI:

```c
typedef struct auqw_core auqw_core_t;

typedef struct auqw_init_options {
    const char* app_id;
    const char* app_name;
    const char* data_dir;
    const char* cache_dir;
} auqw_init_options_t;

int auqw_core_create(const auqw_init_options_t* options, auqw_core_t** out_core);
void auqw_core_destroy(auqw_core_t* core);
const char* auqw_core_hello(auqw_core_t* core);
void auqw_free(void* ptr);
```

## 3. Current Status

Implemented:

- `auqw-core`: Zig static library with exported C ABI.
- `auqw-bridge`: C ABI header and C++ RAII wrapper.
- `auqw-qt`: Qt Quick Controls shell with desktop and compact navigation.
- `ci/build-local.sh`: local build script.
- `ci/container-build.sh`: Linux container build front door.
- `ci/container-build.ps1`: Windows container build front door.
- `containers/`: reproducible build environment recipes.
- `ci/platform-builds.md`: platform gate notes.
- `docs/architecture.md`: architecture and maintainability rules.
- `packaging/linux/com.vehicoule.auqw.desktop`: Linux desktop metadata.

Verified:

```text
Zig core test passed.
C++ bridge smoke test passed.
Qt controller and QML shell smoke tests passed.
Bridge-only local build passed.
```

Previous local GUI blocker:

```text
Qt base was installed, but Qt QML development config was missing:
Qt6QmlConfig.cmake
```

Fix on current Ubuntu/WSL environment:

```bash
sudo apt install qt6-declarative-dev qt6-multimedia-dev qml6-module-qtquick-window qml6-module-qtquick-controls qml6-module-qtmultimedia
```

Then run:

```bash
cd /mnt/c/Users/Owner/Documents/Mateo\ TASCON-VAZ/project/Auqw
rm -rf build/local
AUQW_BUILD_QT=ON ./ci/build-local.sh
./build/local/bin/auqw
```

Important note:

```text
packaging/linux/com.vehicoule.auqw.desktop is not a shell script.
Do not run it with ./com.vehicoule.auqw.desktop.
It is launcher metadata for desktop environments.
```

## 4. Milestone 0: Hello-World Shell

Goal:

```text
Show a Qt/QML window that displays text returned by Zig through the C ABI.
```

Acceptance:

- `AUQW_BUILD_QT=OFF ./ci/build-local.sh` passes.
- `AUQW_BUILD_QT=ON ./ci/build-local.sh` passes after Qt QML dev packages are installed.
- `./build/local/bin/auqw` opens a window.
- Window title is `Auqw`.
- Window text is `Hello from Auqw Core`.
- Text comes from Zig, not hardcoded QML.
- App identity remains `com.Vehicoule.auqw`.

Near-term improvements:

- Add `ci/run-local-gui.sh` so running the GUI is obvious.
- Add CMake install rules for `auqw` and desktop metadata.
- Add a small README section explaining `.desktop` launcher usage.
- Add Qt configure preflight message for missing `qt6-declarative-dev`.
- Wire GitHub Actions jobs to call the platform build environments.

## 4.1 Reproducible Build Environments

Build environment policy:

```text
Runner scripts orchestrate CI.
Build dependencies live in containers/ or platform host recipes.
Generated build output is disposable.
```

Environment layout:

```text
containers/linux-flatpak/Containerfile
containers/android-linux/Containerfile
containers/windows/Containerfile
containers/macos/Brewfile
containers/ios/Brewfile
```

Local commands:

```bash
./ci/container-build.sh linux-flatpak
./ci/container-build.sh android-linux
```

Windows container builds require a Windows host with Windows containers enabled:

```powershell
.\ci\container-build.ps1 windows
```

The GitHub `windows-container` job is disabled until repository variable `AUQW_ENABLE_WINDOWS_CONTAINER=true` is set and a self-hosted Windows runner with containers is attached.

macOS and iOS use native macOS host recipes because Xcode and Apple SDKs are required:

```bash
brew bundle --file containers/macos/Brewfile
./ci/macos-build.sh

brew bundle --file containers/ios/Brewfile
./ci/ios-build.sh
```

The GitHub `ios` job is disabled until repository variable `AUQW_ENABLE_IOS=true` is set and the runner has a Qt iOS kit available through `CMAKE_PREFIX_PATH`.

## 5. Milestone 1: Core Foundation

Goal:

```text
Turn Zig core from hello-world into durable app state foundation.
```

Build in Zig:

- Error model.
- Core handle lifecycle.
- Basic command/result types.
- Track model.
- Artist model.
- Album model.
- Playlist model.
- Queue model.
- Playback state model.
- App settings model.

Database:

- Add SQLite to Zig.
- Add migration runner.
- Add first tables:
  - `tracks`
  - `artists`
  - `albums`
  - `playlists`
  - `playlist_tracks`
  - `recent_tracks`
  - `search_history`
  - `settings`

Acceptance:

- `zig build test` passes.
- C ABI smoke test creates core and opens app database.
- Migrations run idempotently.
- C++ bridge can call a typed function to read app metadata.

## 6. Milestone 2: Qt Shell Structure

Status:

```text
Implemented with one shared Qt Quick Controls QML shell.
Desktop uses navigation rail, main stack, queue panel, and mini-player.
Compact/mobile uses bottom tabs, touch-sized controls, queue page, and mini-player above tabs.
Library and playlists bind to current core models.
Settings round-trips theme through the existing core setting command.
```

Goal:

```text
Replace hello-world window with real app shell while keeping data mocked.
```

Desktop UI:

- Sidebar navigation.
- Search page.
- Library page.
- Queue panel static frame.
- Bottom mini-player static frame.
- Settings page.

Mobile UI:

- Bottom navigation.
- Safe-area padding.
- Large touch targets.
- Now Playing static screen.

Rules:

- QML remains UI-only.
- C++ controllers expose properties and invokable commands.
- No provider-specific or database-specific data reaches QML.

Acceptance:

- Desktop shell runs.
- Mobile-sized window remains usable.
- Navigation works.
- Core hello/app metadata still flows through Zig bridge.

## 7. Milestone 3: Local Library And Queue

Status: complete on `main` as of `feat: add queue playback polish`.

Goal:

```text
Make Auqw useful as a local music player before online provider work.
```

Core:

- Local track import model.
- Library scan records.
- Queue add/remove/reorder.
- Repeat/shuffle state.
- Recent track history.
- Saved queue snapshot.

Qt/C++:

- Folder picker.
- Local scan controller.
- Track list model.
- Queue model.

Playback:

- Desktop starts with Qt Multimedia.
- Platform adapters stay behind C++ interface.

Acceptance:

- User selects a local music folder.
- Tracks appear in Library.
- Clicking a track adds it to queue.
- Qt Multimedia plays local file on desktop.
- Recent track is saved to SQLite.

## 8. Milestone 4: Platform Playback

Status: in progress. Desktop platform playback, Android MediaSession, Android foreground service, Android remote control routing, audio focus, and noisy-audio handling have landed on `main`. iOS AVAudioSession, AVPlayer backend, RemoteCommandCenter, Now Playing metadata, and interruption handling source wiring have landed. Android and iOS smoke harnesses are planned/landing; device/runtime pass remains pending until attached platform target logs exist.

Goal:

```text
Keep playback state in Zig while real playback is handled natively.
```

Desktop:

- Qt Multimedia player.
- App-focused media keys.
- Tray controls.
- Track-change notifications.
- Window state restore.

Android:

- MediaSession bridge from Qt/C++ playback state. Landed on `main`.
- Foreground media playback service. Landed on `main`.
- Background playback service wiring. Landed on `main`.
- Remote MediaSession commands routed back into Qt/C++ controls. Landed on `main`.
- Audio focus handling. Landed on `main`.
- Bluetooth/headset disconnect handling through noisy-audio receiver. Landed on `main`.
- Device/emulator smoke harness. Landing through `ci/android-runtime-smoke.sh`; runtime pass pending attached Android target.

iOS:

- AVAudioSession. Landed in source wiring.
- AVPlayer backend behind iOS guard. Landed in source wiring.
- RemoteCommandCenter. Landed in source wiring.
- Now Playing metadata. Landed in source wiring.
- Interruption handling. Landed in source wiring.
- Device/runtime smoke harness. Landing through `ci/ios-runtime-smoke.sh`; runtime pass pending macOS/Xcode/Qt iOS target.

Acceptance:

- Desktop playback controls work.
- Android background playback spike works.
- iOS background playback spike works.
- Platform player events update Zig playback state.

## 9. Milestone 5: Online Provider Spike

Goal:

```text
Add anonymous online search/playback without yt-dlp or account login.
```

Provider direction:

- First provider spike in C++/Qt.
- Use Qt network stack, JSON support, and app event loop.
- Keep provider fragile code outside Zig durable core.
- Normalize all provider results before they reach UI.

Initial capabilities:

- Search tracks. **Landed:** first C++/Qt InnerTube-style provider slice with normalized search results, fixture parser tests, and QML search state.
- Suggestions. **Landed:** normalized provider suggestions flow through `OnlineProvider`, `CoreController`, and QML suggestion UI.
- Metadata. **Landed:** provider metadata contract and InnerTube player-response parser cover title, artist, duration, and artwork.
- Artwork. **Landed:** search result artwork persists through normalized results and queue upsert; QML renders search artwork and mini-player artwork with fallback.
- Stream resolution. **Landed:** queued provider tracks resolve direct anonymous InnerTube audio URLs through normalized Qt provider results.
- Clean error reporting. **Current:** search and online playback failures use friendly UI/core messages; cipher-only streams fail without crashing.
- Fixture-based parser tests.

References:

- OpenTune behavior and InnerTube flow.
- Spotube cross-platform product ideas.
- Existing Aura backend ideas where useful.

Rules:

- Reference behavior only.
- Do not copy GPL source unless license decision is explicit.
- No Python, Node, Kotlin runtime dependency.
- No yt-dlp.

Acceptance:

- Online search returns normalized tracks. **Current:** normalized provider results stay in `CoreController`/Qt models and selected results persist through existing `tracks.upsert`.
- Online playback works on desktop. **Current:** direct audio URLs route through `PlaybackBackend::playRemoteUrl`; signature/cipher handling remains out of scope.
- Provider failure shows non-scary UI state. **Current:** provider failures surface as `Search unavailable. Try again.`
- Same provider code path works on desktop and mobile build targets.

Immediate live smoke status (2026-05-30):

- Resolver soak passed against all default anonymous queries with `stream=headered_direct_url` and `status=first_audio_bytes`.
- Playback soak passed against all default anonymous queries with `stream=headered_direct_url`, `status=first_audio_bytes`, and `status=playback_progress`.
- Current direct/headered path is enough for the tested desktop live playback slice; no `sabr` stream or failure marker was observed.

## 10. Milestone 6: Cache And Downloads

Status: complete on `main` as of `feat(downloads): execute queued downloads`. Cache tables, provider capability checks, storage settings, Downloads UI, and real one-at-a-time download execution have landed. Downloaded files preserve provider stream bytes as-is; no transcoding or container rewriting is performed. Direct URL, headered direct URL, and SABR media payload downloads are supported, with SABR limited to parsed audio media payload bytes rather than saving UMP framing.

Goal:

```text
Create cache/download infrastructure without assuming every provider supports downloads.
```

Core tables:

- `cached_artwork`
- `downloads`
- `local_files`

Download states:

```text
queued
resolving
downloading
verifying
completed
failed
cancelled
```

Capabilities:

- Artwork cache.
- Metadata cache.
- Download queue.
- Progress events.
- Delete downloads.
- Storage settings.
- Provider capability checks.
- Direct/headered direct stream download worker.
- SABR audio payload download worker.
- Original stream byte persistence only; no transcode.

Acceptance:

- Artwork cache works.
- Metadata cache works.
- Download UI handles unsupported providers.
- Deleting cached/downloaded content updates DB and filesystem.

## 11. Milestone 7: Packaging And Release

Status: in progress. Linux desktop package foundation has the first slice:
CMake install rules, desktop metadata, AppStream metadata, SVG icon,
Flatpak manifest, local package staging script, and tagged GitHub Release
publishing for Linux Flatpak plus Windows zip assets. macOS, Android, iOS,
and FreeBSD release artifacts remain separate M7 slices.
Linux package IDs use lowercase `com.vehicoule.auqw` because AppStream and
Flatpak validators require lowercase reverse-DNS IDs.

Goal:

```text
Ship reproducible builds for supported platforms.
```

Outputs:

```text
Windows: zip first, installer later
macOS: .app zip first, dmg later
Linux: Flatpak
FreeBSD: source build first, port/pkg later
Android: APK
iOS: source/Xcode build first, TestFlight/ad hoc later if needed
```

Release checklist:

- Icons.
- Desktop metadata.
- Appstream metadata for Linux.
- Flatpak manifest.
- Windows zip.
- macOS app bundle.
- Android APK signing notes.
- iOS build notes.
- Crash logging policy.
- Provider diagnostics page.

## 12. Quality Rules

Human maintainability:

- Prefer readable names over clever names.
- Keep files small and single-purpose.
- Write boring bridge code.
- Keep ownership boundaries strict.
- Add comments only where code is non-obvious.
- Avoid hidden behavior in generic dispatchers.

Efficiency:

- Measure before optimizing.
- Avoid generic string dispatch for hot paths.
- Keep allocations obvious across C ABI.
- Prefer static linking for mobile packaging predictability.
- Keep provider/network retry behavior isolated.

Testing:

- Write tests before behavior changes.
- Verify red before green for new behavior.
- Keep C ABI smoke tests small.
- Add fixture tests for provider parsers.
- Keep local playback tests separate from online provider tests.

## 13. Immediate Next Actions

1. Keep local verification green:

```bash
AUQW_BUILD_QT=OFF ./ci/build-local.sh
AUQW_REQUIRE_QT_MULTIMEDIA=ON AUQW_BUILD_QT=ON ./ci/build-local.sh
AUQW_FLATPAK_BUILD=OFF ./ci/linux-package.sh
./ci/live-playback-soak.sh --runs 1 --max-results 3
./ci/live-playback-soak.sh --playback --runs 1 --max-results 3 --min-position-ms 1000 --playback-window-ms 7000
```

2. Verify reproducible container builds:

```bash
./ci/container-build.sh android-linux
./ci/container-build.sh linux-flatpak
```

3. Plan Milestone 7 packaging and release work.

4. Verify iOS platform playback on macOS when host is available:

```bash
brew bundle --file containers/ios/Brewfile
./ci/ios-build.sh
```

5. Keep online provider constraints in force:

- If live streams are cipher-only, plan a separate signature/cipher handling slice.
- Keep provider code in C++/Qt first.
- Keep normalized results out of QML/provider-specific shapes.
- Keep anonymous provider access only and no yt-dlp dependency.
