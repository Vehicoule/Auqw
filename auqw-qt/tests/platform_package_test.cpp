#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QString>
#include <QStringList>
#include <QTest>

namespace {

QString projectSourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_PROJECT_SOURCE_DIR) + QLatin1Char('/') + relativePath.toString();
}

QString readTextFile(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return {};
    }
    return QString::fromUtf8(file.readAll());
}

QStringList recursiveFileNames(const QString& rootPath) {
    QStringList files;
    QDirIterator it(rootPath, QDir::Files, QDirIterator::Subdirectories);
    while (it.hasNext()) {
        const QString path = it.next();
        files.append(QDir(rootPath).relativeFilePath(path).replace(QLatin1Char('\\'), QLatin1Char('/')));
    }
    return files;
}

bool hasFileEndingWith(const QStringList& files, const QString& suffix) {
    for (const QString& file : files) {
        if (file.endsWith(suffix, Qt::CaseInsensitive)) {
            return true;
        }
    }
    return false;
}

bool hasFileContaining(const QStringList& files, const QString& needle) {
    for (const QString& file : files) {
        if (file.contains(needle, Qt::CaseInsensitive)) {
            return true;
        }
    }
    return false;
}

QString packagePathFromEnv(const char* name) {
    return QString::fromLocal8Bit(qgetenv(name));
}

} // namespace

class PlatformPackageTest final : public QObject {
    Q_OBJECT

private slots:
    void githubBuildWorkflowIsManualAndUsesHostedWindows() {
        const QString workflow = readTextFile(projectSourcePath(u".github/workflows/build.yml"));
        QVERIFY2(!workflow.isEmpty(), ".github/workflows/build.yml should be readable");

        QVERIFY2(workflow.contains(QStringLiteral("workflow_dispatch:")),
            "Build workflow should support manual dispatch");
        QVERIFY2(workflow.contains(QStringLiteral("push:")) &&
                workflow.contains(QStringLiteral("tags:")) &&
                workflow.contains(QStringLiteral("v*")),
            "Build workflow should publish releases from v* tag pushes");
        QVERIFY2(!workflow.contains(QStringLiteral("pull_request:")),
            "Build workflow should not run automatically on pull request");
        QVERIFY2(workflow.contains(QStringLiteral("contents: write")),
            "Build workflow should allow tagged release asset publishing");
        QVERIFY2(workflow.contains(QStringLiteral("windows-latest")),
            "Windows workflow should use a hosted GitHub runner");
        QVERIFY2(!workflow.contains(QStringLiteral("AUQW_ENABLE_WINDOWS_CONTAINER")),
            "Windows workflow should not be gated by the old self-hosted container repo variable");
        QVERIFY2(workflow.contains(QStringLiteral("aqtinstall==3.3.0")),
            "Windows workflow should install the pinned aqtinstall package");
        QVERIFY2(workflow.contains(QStringLiteral("0.16.0")),
            "Windows workflow should install Zig 0.16.0");
        QVERIFY2(workflow.contains(QStringLiteral("6.8.3")) &&
                workflow.contains(QStringLiteral("win64_msvc2022_64")) &&
                workflow.contains(QStringLiteral("qtmultimedia")),
            "Windows workflow should install Qt 6.8.3 win64_msvc2022_64 with qtmultimedia");
        QVERIFY2(workflow.contains(QStringLiteral("aqt install-qt mac desktop 6.8.3 clang_64")) &&
                workflow.contains(QStringLiteral("QT_PREFIX=$qt_prefix")) &&
                workflow.contains(QStringLiteral("QtQuick/Effects/qmldir")),
            "macOS workflow should install the official Qt 6.8.3 universal kit and validate QtQuick.Effects");
        QVERIFY2(workflow.contains(QStringLiteral("ci\\windows-build.ps1")) ||
                workflow.contains(QStringLiteral("ci/windows-build.ps1")),
            "Windows workflow should call ci/windows-build.ps1");
        QVERIFY2(workflow.contains(QStringLiteral("auqw-windows-x64")),
            "Windows workflow should upload a Windows artifact");
        QVERIFY2(workflow.contains(QStringLiteral("auqw-windows-x64.zip")),
            "Windows workflow should package deployed binaries as a release zip");
        QVERIFY2(workflow.contains(QStringLiteral("softprops/action-gh-release")),
            "Build workflow should create a GitHub Release for tag pushes");
        QVERIFY2(workflow.contains(QStringLiteral("download-artifact")),
            "Release job should download package artifacts before publishing assets");
        QVERIFY2(workflow.contains(QStringLiteral("github.ref_type == 'tag'")),
            "Release publishing should be gated to tag refs");
        QVERIFY2(workflow.contains(QStringLiteral("aqt install-qt linux desktop 6.8.3 linux_gcc_64")) &&
                workflow.contains(QStringLiteral("qtmultimedia")),
            "Linux release workflow should install the official Qt 6.8.3 LTS desktop kit with qtmultimedia");
        QVERIFY2(workflow.contains(QStringLiteral("CMAKE_PREFIX_PATH=$qt_prefix")),
            "Linux release workflow should build against the official Qt kit rather than Ubuntu's older Qt packages");
        QVERIFY2(workflow.contains(QStringLiteral("QtQuick/Effects")),
            "Release workflow should validate QtQuick.Effects availability before packaging");
        QVERIFY2(workflow.contains(QStringLiteral("flatpak --user remote-add")),
            "Linux release workflow should add Flathub to the user Flatpak installation");
        QVERIFY2(workflow.contains(QStringLiteral("AUQW_FLATPAK_INSTALLATION: user")),
            "Linux release workflow should install Flatpak dependencies without system deploy permissions");
    }

    void releaseWorkflowUsesPlainSemverAssetsWithoutPackageRegistryIndex() {
        const QString workflow = readTextFile(projectSourcePath(u".github/workflows/build.yml"));
        const QString docs = readTextFile(projectSourcePath(u"ci/platform-builds.md"));
        const QString packageIndexPath = projectSourcePath(u"packaging/ghcr/release-index.Containerfile");
        QVERIFY2(!workflow.isEmpty(), ".github/workflows/build.yml should be readable");
        QVERIFY2(!docs.isEmpty(), "ci/platform-builds.md should be readable");

        QVERIFY2(!workflow.contains(QStringLiteral("packages: write")),
            "Build workflow should not request package registry write permission for installer releases");
        QVERIFY2(workflow.contains(QStringLiteral("^v[0-9]+\\.[0-9]+\\.[0-9]+$")),
            "Release job should accept only plain semver tags like v0.0.1");
        QVERIFY2(workflow.contains(QStringLiteral("Release tags must use plain semver like v0.0.1")),
            "Release job should fail clearly when an old alpha-suffixed tag is pushed");
        QVERIFY2(workflow.contains(QStringLiteral("prerelease: false")),
            "Plain semver installer releases should be stable GitHub Releases");
        QVERIFY2(workflow.contains(QStringLiteral("make_latest: true")),
            "Plain semver installer releases should be promoted to GitHub Latest");
        QVERIFY2(workflow.contains(QStringLiteral("overwrite_files: true")),
            "Release job should overwrite same-name assets when v0.0.1 is recreated");
        QVERIFY2(!workflow.contains(QStringLiteral("startsWith(github.ref_name, 'v0.')")),
            "v0.* releases should not be forced to prerelease when v0.0.1 is the public latest installer release");
        QVERIFY2(!workflow.contains(QStringLiteral("contains(github.ref_name, 'alpha')")),
            "Prerelease logic should not depend on alpha tag suffixes");
        QVERIFY2(docs.contains(QStringLiteral("plain semver tags publish stable GitHub Releases")) &&
                docs.contains(QStringLiteral("GitHub Latest")),
            "platform docs should describe plain semver release tags as stable/latest installer releases");

        QVERIFY2(workflow.contains(QStringLiteral("android-linux")) &&
                workflow.contains(QStringLiteral("macos")),
            "Release job should wait for Android and macOS package artifacts");
        QVERIFY2(workflow.contains(QStringLiteral("auqw-linux-x64.flatpak")) &&
                workflow.contains(QStringLiteral("auqw-linux-x64.tar.gz")) &&
                workflow.contains(QStringLiteral("auqw-windows-x64.zip")) &&
                workflow.contains(QStringLiteral("auqw-macos.dmg")) &&
                workflow.contains(QStringLiteral("auqw-android-arm64.apk")),
            "GitHub Release should publish the five installer assets for v0.0.1");

        QVERIFY2(!workflow.contains(QStringLiteral("docker/login-action")),
            "Release job should not authenticate to a container registry");
        QVERIFY2(!workflow.contains(QStringLiteral("docker/build-push-action")),
            "Release job should not publish a metadata-only container image");
        QVERIFY2(!workflow.contains(QStringLiteral("ghcr.io/vehicoule/auqw")),
            "Release workflow should not advertise a package registry entry for installer assets");
        QVERIFY2(!QFileInfo::exists(packageIndexPath),
            "metadata-only package registry Containerfile should be removed");
        QVERIFY2(!docs.contains(QStringLiteral("GHCR")) && !docs.contains(QStringLiteral("ghcr.io/vehicoule/auqw")),
            "platform docs should point installer downloads at GitHub Releases only");
    }

    void projectVersionsResetToFirstAlphaSemver() {
        const QString rootCmake = readTextFile(projectSourcePath(u"CMakeLists.txt"));
        const QString main = readTextFile(projectSourcePath(u"auqw-qt/src/main.cpp"));
        const QString androidManifest = readTextFile(projectSourcePath(u"auqw-qt/android/AndroidManifest.xml"));
        const QString appstream = readTextFile(projectSourcePath(u"packaging/linux/com.vehicoule.auqw.metainfo.xml"));

        QVERIFY2(!rootCmake.isEmpty(), "CMakeLists.txt should be readable");
        QVERIFY2(!main.isEmpty(), "main.cpp should be readable");
        QVERIFY2(!androidManifest.isEmpty(), "AndroidManifest.xml should be readable");
        QVERIFY2(!appstream.isEmpty(), "AppStream metadata should be readable");

        QVERIFY2(rootCmake.contains(QStringLiteral("project(Auqw VERSION 0.0.1")),
            "Project version should reset to 0.0.1 for Alpha 1");
        QVERIFY2(main.contains(QStringLiteral("setApplicationVersion(QStringLiteral(\"0.0.1\"))")),
            "Runtime application version should reset to 0.0.1");
        QVERIFY2(androidManifest.contains(QStringLiteral("android:versionName=\"0.0.1\"")),
            "Android manifest versionName should reset to 0.0.1");
        QVERIFY2(appstream.contains(QStringLiteral("<release version=\"0.0.1\"")),
            "AppStream release metadata should reset to 0.0.1");
        QVERIFY2(!rootCmake.contains(QStringLiteral("0.1.0-alpha")) &&
                !main.contains(QStringLiteral("0.1.0-alpha")) &&
                !androidManifest.contains(QStringLiteral("0.1.0-alpha")) &&
                !appstream.contains(QStringLiteral("0.1.0-alpha")),
            "Source versions should not use alpha-suffixed semver tags");
    }

    void windowsBuildRequiresCachesQtMultimediaAndDeployment() {
        const QString script = readTextFile(projectSourcePath(u"ci/windows-build.ps1"));
        QVERIFY2(!script.isEmpty(), "ci/windows-build.ps1 should be readable");

        QVERIFY2(script.contains(QStringLiteral("$env:ZIG")), "Windows build should honor ZIG override");
        QVERIFY2(script.contains(QStringLiteral("AUQW_BUILD_DIR")), "Windows build should honor AUQW_BUILD_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_CACHE_DIR")), "Windows build should honor AUQW_ZIG_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_GLOBAL_CACHE_DIR")), "Windows build should honor AUQW_ZIG_GLOBAL_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_TARGET")), "Windows build should honor AUQW_ZIG_TARGET");
        QVERIFY2(script.contains(QStringLiteral("x86_64-windows-msvc")),
            "Windows Zig core should default to the MSVC ABI for the hosted Qt kit");
        QVERIFY2(script.contains(QStringLiteral("--cache-dir")), "Windows Zig build should use explicit cache dir");
        QVERIFY2(script.contains(QStringLiteral("--global-cache-dir")), "Windows Zig build should use explicit global cache dir");
        QVERIFY2(script.contains(QStringLiteral("-Dtarget=$ZigTarget")),
            "Windows Zig build should pass the selected target to the core build");
        QVERIFY2(script.contains(QStringLiteral("CMAKE_BUILD_TYPE=Release")),
            "Windows CMake configure should build Release artifacts for release Qt runtime deployment");
        QVERIFY2(script.contains(QStringLiteral("Qt6MultimediaConfig.cmake")), "Windows build should fail fast when Qt Multimedia is absent");
        QVERIFY2(script.contains(QStringLiteral("QtQuick\\Effects")) || script.contains(QStringLiteral("QtQuick/Effects")),
            "Windows build should fail fast when QtQuick.Effects QML runtime is absent");
        QVERIFY2(script.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "Windows CMake configure should require Qt Multimedia");
        QVERIFY2(script.contains(QStringLiteral("windeployqt")), "Windows build should deploy Qt runtime with windeployqt");
        QVERIFY2(script.contains(QStringLiteral("Qt6Multimedia.dll")), "Windows package validation should require Qt Multimedia DLL");
        const QString qtCmake = readTextFile(projectSourcePath(u"auqw-qt/CMakeLists.txt"));
        QVERIFY2(qtCmake.contains(QStringLiteral("RESOURCE_PREFIX /qt/qml")),
            "Packaged Qt app should embed its Auqw QML module under the standard qrc:/qt/qml import path");
        QVERIFY2(script.contains(QStringLiteral("vcruntime140.dll")) &&
                script.contains(QStringLiteral("vcruntime140_1.dll")) &&
                script.contains(QStringLiteral("msvcp140.dll")),
            "Windows package validation should require core MSVC runtime DLLs beside auqw.exe");
        QVERIFY2(script.contains(QStringLiteral("msvcp140_*.dll")),
            "Windows package should copy available MSVC companion DLLs beside auqw.exe");
        QVERIFY2(script.contains(QStringLiteral("vc_redist.x64.exe")),
            "Windows package should keep the VC redistributable installer as a fallback");
        QVERIFY2(script.contains(QStringLiteral("System.Diagnostics.ProcessStartInfo")) &&
                script.contains(QStringLiteral("UseShellExecute = $false")) &&
                script.contains(QStringLiteral("WaitForExit")) &&
                script.contains(QStringLiteral("Kill()")),
            "Windows package smoke should launch auqw.exe with a process API that returns a reliable exit code");
        QVERIFY2(script.contains(QStringLiteral("RedirectStandardOutput")) &&
                script.contains(QStringLiteral("RedirectStandardError")),
            "Windows package smoke should capture packaged app diagnostics on launch failure");
        QVERIFY2(script.contains(QStringLiteral("QT_QUICK_BACKEND")) &&
                script.contains(QStringLiteral("software")),
            "Windows package smoke should avoid hosted-runner graphics backend dependencies");
        QVERIFY2(script.contains(QStringLiteral("QT_QUICK_CONTROLS_STYLE")) &&
                script.contains(QStringLiteral("Basic")),
            "Windows package smoke should avoid hosted-runner native style dependencies");
        QVERIFY2(script.contains(QStringLiteral("QT_FORCE_STDERR_LOGGING")),
            "Windows package smoke should force Qt diagnostics into captured stderr");
        QVERIFY2(script.contains(QStringLiteral("plugins\\multimedia")) || script.contains(QStringLiteral("plugins/multimedia")),
            "Windows package validation should require Qt Multimedia plugin directory");
        QVERIFY2(!script.contains(QStringLiteral("CMAKE_CXX_COMPILER")), "Windows Qt shell should keep native platform compiler");
        QVERIFY2(script.contains(QStringLiteral("missing ${Description}: $Path")),
            "Windows build should delimit PowerShell variables before literal colons");

        const QString bridgeCMake = readTextFile(projectSourcePath(u"auqw-bridge/CMakeLists.txt"));
        QVERIFY2(bridgeCMake.contains(QStringLiteral("ntdll")),
            "Windows CMake linkage should include ntdll for Zig core Windows runtime symbols");

        const QString coreBuild = readTextFile(projectSourcePath(u"auqw-core/build.zig"));
        QVERIFY2(coreBuild.contains(QStringLiteral("bundle_compiler_rt = true")),
            "Windows Zig core static library should bundle compiler-rt helpers for MSVC links");
    }

    void macosBuildRequiresCachesQtMultimediaAndDeployment() {
        const QString script = readTextFile(projectSourcePath(u"ci/macos-build.sh"));
        QVERIFY2(!script.isEmpty(), "ci/macos-build.sh should be readable");

        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_CACHE_DIR")), "macOS build should honor AUQW_ZIG_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_GLOBAL_CACHE_DIR")), "macOS build should honor AUQW_ZIG_GLOBAL_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("--cache-dir")), "macOS Zig build should use explicit cache dir");
        QVERIFY2(script.contains(QStringLiteral("--global-cache-dir")), "macOS Zig build should use explicit global cache dir");
        QVERIFY2(script.contains(QStringLiteral("Qt6MultimediaConfig.cmake")), "macOS build should fail fast when Qt Multimedia is absent");
        QVERIFY2(script.contains(QStringLiteral("QtQuick/Effects")),
            "macOS build should fail fast when QtQuick.Effects QML runtime is absent");
        QVERIFY2(script.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "macOS CMake configure should require Qt Multimedia");
        QVERIFY2(script.contains(QStringLiteral("macdeployqt")), "macOS build should deploy Qt runtime with macdeployqt");
        QVERIFY2(script.contains(QStringLiteral("otool -L")), "macOS package validation should inspect bundle linkage");
        QVERIFY2(script.contains(QStringLiteral("QtMultimedia.framework")), "macOS package validation should require Qt Multimedia framework");
        QVERIFY2(script.contains(QStringLiteral("PlugIns/multimedia")) || script.contains(QStringLiteral("plugins/multimedia")),
            "macOS package validation should require Qt Multimedia plugin directory");
        QVERIFY2(script.contains(QStringLiteral("AUQW_MACOS_DMG_PATH")),
            "macOS build should let CI choose the DMG output path");
        QVERIFY2(script.contains(QStringLiteral("hdiutil create")) &&
                script.contains(QStringLiteral("-format UDZO")) &&
                script.contains(QStringLiteral("hdiutil verify")),
            "macOS build should create and validate a compressed DMG from the deployed app bundle");
        QVERIFY2(!script.contains(QStringLiteral("CMAKE_CXX_COMPILER")), "macOS Qt shell should keep native platform compiler");
    }

    void linuxRuntimeDeploymentBundlesHostVisibleQtLibraries() {
        const QString deploy = readTextFile(projectSourcePath(u"ci/deploy-linux-runtime.sh"));
        const QString check = readTextFile(projectSourcePath(u"ci/check-linux-runtime.sh"));
        const QString containerfile = readTextFile(projectSourcePath(u"containers/linux-flatpak/Containerfile"));

        QVERIFY2(!deploy.isEmpty(), "ci/deploy-linux-runtime.sh should be readable");
        QVERIFY2(!check.isEmpty(), "ci/check-linux-runtime.sh should be readable");
        QVERIFY2(!containerfile.isEmpty(), "containers/linux-flatpak/Containerfile should be readable");

        QVERIFY2(deploy.contains(QStringLiteral("copy_runtime_libraries")),
            "Linux deploy should copy the runtime library closure into build/lib");
        QVERIFY2(!deploy.contains(QStringLiteral("$1 ~ /^libQt6Multimedia/")),
            "Linux deploy should not copy only Qt Multimedia libraries");
        QVERIFY2(!deploy.contains(QStringLiteral("awk '$2 == \"=>\"")),
            "Linux deploy should not split ldd library paths on spaces");
        QVERIFY2(deploy.contains(QStringLiteral("sed -n")),
            "Linux deploy should parse ldd output line-wise so repo paths with spaces stay intact");
        QVERIFY2(check.contains(QStringLiteral("LD_LIBRARY_PATH")),
            "Linux runtime check should resolve libraries bundled in build/lib");
        QVERIFY2(containerfile.contains(QStringLiteral("ubuntu:24.04")),
            "Linux Flatpak container should match the GitHub ubuntu-latest host glibc for runtime validation");
        QVERIFY2(!containerfile.contains(QStringLiteral("ubuntu:26.04")),
            "Linux Flatpak container should not build runtime libraries against a newer glibc than the GitHub host check");
        QVERIFY2(containerfile.contains(QStringLiteral("gstreamer1.0-alsa")),
            "Linux Flatpak container should provide a GStreamer audio sink for Qt Multimedia tests");
        QVERIFY2(containerfile.contains(QStringLiteral("gstreamer1.0-plugins-good")),
            "Linux Flatpak container should provide common GStreamer playback elements for Qt Multimedia tests");
        QVERIFY2(containerfile.contains(QStringLiteral("gstreamer1.0-pulseaudio")),
            "Linux Flatpak container should provide the PulseAudio GStreamer sink used by Qt Multimedia");
        QVERIFY2(containerfile.contains(QStringLiteral("ARG QT_VERSION=6.8.3")) &&
                containerfile.contains(QStringLiteral("ARG QT_HOST_ARCH=linux_gcc_64")) &&
                containerfile.contains(QStringLiteral("ARG QT_HOST_DIR=gcc_64")) &&
                containerfile.contains(QStringLiteral("aqtinstall==${AQT_VERSION}")),
            "Linux Flatpak container should use the official Qt 6.8.3 LTS host kit");
        QVERIFY2(containerfile.contains(QStringLiteral("CMAKE_PREFIX_PATH=/opt/Qt/${QT_VERSION}/${QT_HOST_DIR}")),
            "Linux Flatpak container should build against the official Qt kit");
        QVERIFY2(containerfile.contains(QStringLiteral("QtQuick/Effects")),
            "Linux Flatpak container should validate the QtQuick Effects QML import used by album backdrops");
    }

    void linuxDesktopInstallMetadataAndFlatpakManifestAreWired() {
        const QString qtCMake = readTextFile(projectSourcePath(u"auqw-qt/CMakeLists.txt"));
        const QString main = readTextFile(projectSourcePath(u"auqw-qt/src/main.cpp"));
        const QString desktop = readTextFile(projectSourcePath(u"packaging/linux/com.vehicoule.auqw.desktop"));
        const QString appstream = readTextFile(projectSourcePath(u"packaging/linux/com.vehicoule.auqw.metainfo.xml"));
        const QString iconPath = projectSourcePath(u"packaging/linux/com.vehicoule.auqw.png");
        const QString manifest = readTextFile(projectSourcePath(u"packaging/linux/com.vehicoule.auqw.yml"));
        const QString script = readTextFile(projectSourcePath(u"ci/linux-package.sh"));
        const QString docs = readTextFile(projectSourcePath(u"ci/platform-builds.md"));

        QVERIFY2(!qtCMake.isEmpty(), "auqw-qt/CMakeLists.txt should be readable");
        QVERIFY2(!main.isEmpty(), "auqw-qt/src/main.cpp should be readable");
        QVERIFY2(!desktop.isEmpty(), "Linux desktop file should be readable");
        QVERIFY2(!appstream.isEmpty(), "Linux AppStream metadata should be readable");
        QVERIFY2(QFileInfo::exists(iconPath), "Linux PNG app icon should exist");
        QVERIFY2(!manifest.isEmpty(), "Linux Flatpak manifest should be readable");
        QVERIFY2(!script.isEmpty(), "ci/linux-package.sh should be readable");
        QVERIFY2(!docs.isEmpty(), "ci/platform-builds.md should be readable");

        QVERIFY2(qtCMake.contains(QStringLiteral("include(GNUInstallDirs)")),
            "Qt CMake should use GNU install directories for Linux packaging");
        QVERIFY2(qtCMake.contains(QStringLiteral("install(TARGETS Auqw")),
            "Qt CMake should install the Auqw executable");
        QVERIFY2(qtCMake.contains(QStringLiteral("CMAKE_INSTALL_BINDIR")),
            "Qt CMake should install the executable to the configured bindir");
        QVERIFY2(qtCMake.contains(QStringLiteral("CMAKE_INSTALL_DATADIR")) &&
                qtCMake.contains(QStringLiteral("applications")) &&
                qtCMake.contains(QStringLiteral("metainfo")) &&
                qtCMake.contains(QStringLiteral("icons/hicolor/128x128/apps")) &&
                qtCMake.contains(QStringLiteral("com.vehicoule.auqw.png")),
            "Qt CMake should install desktop, AppStream, and PNG icon metadata");
        QVERIFY2(main.contains(QStringLiteral("setDesktopFileName(QStringLiteral(\"com.vehicoule.auqw\"))")),
            "Linux app should expose the desktop file id to the windowing system");

        QVERIFY2(desktop.contains(QStringLiteral("Exec=auqw")), "Desktop file should launch auqw");
        QVERIFY2(desktop.contains(QStringLiteral("Icon=com.vehicoule.auqw")), "Desktop file should use the app-id icon");
        QVERIFY2(desktop.contains(QStringLiteral("Categories=AudioVideo;Audio;Music;Player;")),
            "Desktop file should place Auqw in music player launchers");

        QVERIFY2(appstream.contains(QStringLiteral("<id>com.vehicoule.auqw</id>")),
            "AppStream metadata should use the app id");
        QVERIFY2(appstream.contains(QStringLiteral("<launchable type=\"desktop-id\">com.vehicoule.auqw.desktop</launchable>")),
            "AppStream metadata should point at the desktop file");
        QVERIFY2(appstream.contains(QStringLiteral("<metadata_license>CC0-1.0</metadata_license>")),
            "AppStream metadata should declare a metadata license");
        QVERIFY2(appstream.contains(QStringLiteral("<project_license>LicenseRef-proprietary</project_license>")),
            "AppStream metadata should avoid inventing a project source license");
        QVERIFY2(appstream.contains(QStringLiteral("<content_rating type=\"oars-1.1\" />")),
            "AppStream metadata should include a content rating tag");

        QFile iconFile(iconPath);
        QVERIFY2(iconFile.open(QIODevice::ReadOnly), "Linux PNG app icon should be readable");
        QCOMPARE(iconFile.read(8), QByteArray::fromHex("89504E470D0A1A0A"));

        QVERIFY2(manifest.contains(QStringLiteral("app-id: com.vehicoule.auqw")),
            "Flatpak manifest should use the app id");
        QVERIFY2(manifest.contains(QStringLiteral("runtime: org.kde.Platform")) &&
                manifest.contains(QStringLiteral("sdk: org.kde.Sdk")),
            "Flatpak manifest should use the KDE Qt runtime and SDK");
        QVERIFY2(manifest.contains(QStringLiteral("runtime-version: '6.9'")),
            "Flatpak manifest should target a supported KDE Platform runtime branch");
        QVERIFY2(!manifest.contains(QStringLiteral("runtime-version: '6.8'")),
            "Flatpak manifest should not target the EOL KDE Platform 6.8 runtime");
        QVERIFY2(manifest.contains(QStringLiteral("no-debuginfo: true")),
            "Flatpak manifest should not require eu-strip during hosted CI bundle exports");
        QVERIFY2(manifest.contains(QStringLiteral("appstream-compose: false")),
            "Flatpak manifest should not require repository AppStream compose for GitHub release bundles");
        QVERIFY2(manifest.contains(QStringLiteral("command: auqw")), "Flatpak manifest should launch auqw");
        QVERIFY2(manifest.contains(QStringLiteral("--env=QT_QUICK_BACKEND=software")) &&
                manifest.contains(QStringLiteral("--env=QSG_RHI_BACKEND=software")) &&
                manifest.contains(QStringLiteral("--env=QT_OPENGL=software")),
            "Flatpak manifest should force Qt Quick software rendering for WSL/Flatpak launch compatibility");
        QVERIFY2(manifest.contains(QStringLiteral("zig-x86_64-linux-0.16.0.tar.xz")) &&
                manifest.contains(QStringLiteral("70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00")),
            "Flatpak manifest should pin Zig 0.16.0 for source builds");
        QVERIFY2(manifest.contains(QStringLiteral("cmake --install")),
            "Flatpak manifest should install through CMake install rules");
        QVERIFY2(manifest.contains(QStringLiteral("cmake --build flatpak-build --parallel 2")),
            "Flatpak manifest should cap sandbox build parallelism for low-memory Linux hosts");
        QVERIFY2(manifest.contains(QStringLiteral("ctest --test-dir flatpak-build --output-on-failure -R")) &&
                manifest.contains(QStringLiteral("auqw_bridge_smoke")) &&
                manifest.contains(QStringLiteral("auqw_qt_platform_package_test")),
            "Flatpak manifest should run only package-safe smoke tests inside the Flatpak build sandbox");
        QVERIFY2(!manifest.contains(QStringLiteral("ctest --test-dir flatpak-build --output-on-failure\n")),
            "Flatpak manifest should not run network-sensitive controller tests inside the Flatpak build sandbox");

        QVERIFY2(script.contains(QStringLiteral("CMAKE_BUILD_TYPE=Release")),
            "Linux package script should produce Release artifacts");
        QVERIFY2(script.contains(QStringLiteral("desktop-file-validate")),
            "Linux package script should validate desktop metadata when available");
        QVERIFY2(script.contains(QStringLiteral("appstreamcli validate")),
            "Linux package script should validate AppStream metadata when available");
        QVERIFY2(script.contains(QStringLiteral("flatpak-builder")),
            "Linux package script should invoke flatpak-builder when available");
        QVERIFY2(script.contains(QStringLiteral("flatpak build-bundle")),
            "Linux package script should export a Flatpak bundle artifact for releases");
        QVERIFY2(script.contains(QStringLiteral("--runtime-repo=https://flathub.org/repo/flathub.flatpakrepo")),
            "Linux Flatpak bundle should carry the Flathub runtime repository hint so org.kde.Platform can be resolved during install");
        QVERIFY2(script.contains(QStringLiteral("AUQW_LINUX_FLATPAK_BUNDLE")),
            "Linux package script should let CI choose the Flatpak bundle output path");
        QVERIFY2(script.contains(QStringLiteral("AUQW_LINUX_TARBALL")),
            "Linux package script should let CI choose the portable tarball output path");
        QVERIFY2(script.contains(QStringLiteral("deploy-linux-runtime.sh")) &&
                script.contains(QStringLiteral("check-linux-runtime.sh")),
            "Linux package script should deploy and validate the portable runtime tree before archiving it");
        QVERIFY2(script.contains(QStringLiteral("tar -czf")) &&
                script.contains(QStringLiteral("tar -tzf")),
            "Linux package script should create and validate the portable tarball");
        QVERIFY2(script.contains(QStringLiteral("AUQW_FLATPAK_INSTALLATION")),
            "Linux package script should support user Flatpak installation mode for hosted CI");
        QVERIFY2(script.contains(QStringLiteral("AUQW_FLATPAK_BUILD")),
            "Linux package script should let CI disable Flatpak builds explicitly");
        QVERIFY2(docs.contains(QStringLiteral("flatpak install --user ./auqw-linux-x64.flatpak")),
            "Linux package docs should show installing the release bundle directly");
        QVERIFY2(docs.contains(QStringLiteral("org.kde.Platform//6.9")) &&
                !docs.contains(QStringLiteral("org.kde.Platform//6.8")),
            "Linux package docs should document the supported KDE Platform runtime branch");
        QVERIFY2(docs.contains(QStringLiteral("QT_QUICK_BACKEND=software")) &&
                docs.contains(QStringLiteral("QSG_RHI_BACKEND=software")) &&
                docs.contains(QStringLiteral("QT_OPENGL=software")),
            "Linux package docs should document the Flatpak software renderer defaults");
    }

    void androidBuildSignsReleaseApkForTagReleases() {
        const QString workflow = readTextFile(projectSourcePath(u".github/workflows/build.yml"));
        const QString script = readTextFile(projectSourcePath(u"ci/android-build.sh"));
        const QString containerBuild = readTextFile(projectSourcePath(u"ci/container-build.sh"));
        QVERIFY2(!workflow.isEmpty(), ".github/workflows/build.yml should be readable");
        QVERIFY2(!script.isEmpty(), "ci/android-build.sh should be readable");
        QVERIFY2(!containerBuild.isEmpty(), "ci/container-build.sh should be readable");

        QVERIFY2(script.contains(QStringLiteral("AUQW_ANDROID_RELEASE_BUILD")),
            "Android build should support explicit release APK mode");
        QVERIFY2(script.contains(QStringLiteral("GITHUB_REF_TYPE")) &&
                script.contains(QStringLiteral("refs/tags/")),
            "Android build should detect tag release runs");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ANDROID_KEYSTORE_BASE64")) &&
                script.contains(QStringLiteral("AUQW_ANDROID_KEYSTORE_PASSWORD")) &&
                script.contains(QStringLiteral("AUQW_ANDROID_KEY_ALIAS")) &&
                script.contains(QStringLiteral("AUQW_ANDROID_KEY_PASSWORD")),
            "Android release signing should use the documented signing secrets");
        QVERIFY2(script.contains(QStringLiteral("missing Android release signing secrets")),
            "Android release build should fail clearly when signing secrets are missing");
        QVERIFY2(workflow.contains(QStringLiteral("android-signing-preflight")),
            "Android workflow should check signing secrets before starting the container build");
        QVERIFY2(workflow.contains(QStringLiteral("signing-ready")) &&
                workflow.contains(QStringLiteral("Android release signing secrets are missing; skipping signed APK and GitHub Release")),
            "Android workflow should warn and skip release jobs when signing secrets are missing");
        QVERIFY2(workflow.contains(QStringLiteral("needs.android-signing-preflight.outputs.signing-ready == 'true'")),
            "Android and release jobs should run only after signing preflight succeeds");
        QVERIFY2(script.contains(QStringLiteral("apksigner")) &&
                script.contains(QStringLiteral("zipalign")),
            "Android release build should align, sign, and verify the APK");
        QVERIFY2(script.contains(QStringLiteral("auqw-android-arm64.apk")),
            "Android release build should emit the signed release APK path");
        QVERIFY2(containerBuild.contains(QStringLiteral("AUQW_ANDROID_KEYSTORE_BASE64")) &&
                containerBuild.contains(QStringLiteral("GITHUB_REF_TYPE")),
            "Android container build should pass signing and tag context into the build container");
        QVERIFY2(workflow.contains(QStringLiteral("AUQW_ANDROID_KEYSTORE_BASE64: ${{ secrets.AUQW_ANDROID_KEYSTORE_BASE64 }}")) &&
                workflow.contains(QStringLiteral("AUQW_ANDROID_KEYSTORE_PASSWORD: ${{ secrets.AUQW_ANDROID_KEYSTORE_PASSWORD }}")) &&
                workflow.contains(QStringLiteral("AUQW_ANDROID_KEY_ALIAS: ${{ secrets.AUQW_ANDROID_KEY_ALIAS }}")) &&
                workflow.contains(QStringLiteral("AUQW_ANDROID_KEY_PASSWORD: ${{ secrets.AUQW_ANDROID_KEY_PASSWORD }}")),
            "Android workflow should provide release signing secrets to tag builds");
        QVERIFY2(workflow.contains(QStringLiteral("Upload Android release APK")) &&
                workflow.contains(QStringLiteral("build/android-linux/apk/auqw-android-arm64.apk")),
            "Android workflow should upload the signed release APK artifact");
        QVERIFY2(workflow.contains(QStringLiteral("Free Android runner disk")) &&
                workflow.contains(QStringLiteral("/opt/hostedtoolcache")) &&
                workflow.contains(QStringLiteral("/usr/local/lib/android")) &&
                workflow.contains(QStringLiteral("podman system prune")),
            "Android workflow should free hosted runner disk before building the large Qt Android image");
    }

    void iosBuildChecksQtKitAppleLinkageAndBundleMetadata() {
        const QString script = readTextFile(projectSourcePath(u"ci/ios-build.sh"));
        QVERIFY2(!script.isEmpty(), "ci/ios-build.sh should be readable");

        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_CACHE_DIR")), "iOS build should honor AUQW_ZIG_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_GLOBAL_CACHE_DIR")), "iOS build should honor AUQW_ZIG_GLOBAL_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("--cache-dir")), "iOS Zig build should use explicit cache dir");
        QVERIFY2(script.contains(QStringLiteral("--global-cache-dir")), "iOS Zig build should use explicit global cache dir");
        QVERIFY2(script.contains(QStringLiteral("QT_IOS_PREFIX")) || script.contains(QStringLiteral("CMAKE_PREFIX_PATH")),
            "iOS build should discover or accept a Qt iOS kit");
        QVERIFY2(script.contains(QStringLiteral("QT_HOST_PATH")), "iOS build should accept Qt host tools path");
        QVERIFY2(script.contains(QStringLiteral("Qt6MultimediaConfig.cmake")), "iOS build should fail fast when Qt Multimedia is absent");
        QVERIFY2(script.contains(QStringLiteral("QtQuick/Effects")),
            "iOS build should fail fast when QtQuick.Effects QML runtime is absent");
        QVERIFY2(script.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "iOS CMake configure should require Qt Multimedia");
        QVERIFY2(script.contains(QStringLiteral("CMAKE_SYSTEM_NAME=iOS")), "iOS build should configure an iOS target");
        QVERIFY2(script.contains(QStringLiteral("AVFoundation")), "iOS validation should verify AVFoundation linkage");
        QVERIFY2(script.contains(QStringLiteral("MediaPlayer")), "iOS validation should verify MediaPlayer linkage");
        QVERIFY2(script.contains(QStringLiteral("Info.plist")), "iOS validation should verify bundle metadata");
        QVERIFY2(script.contains(QStringLiteral("ctest")), "iOS build should run source/package CTest where available");
    }

    void androidRuntimeSmokeRequiresAttachedTargetEvidence() {
        const QString script = readTextFile(projectSourcePath(u"ci/android-runtime-smoke.sh"));
        const QString docs = readTextFile(projectSourcePath(u"ci/platform-builds.md"));

        QVERIFY2(!script.isEmpty(), "ci/android-runtime-smoke.sh should be readable");
        QVERIFY2(!docs.isEmpty(), "ci/platform-builds.md should be readable");

        QVERIFY2(script.contains(QStringLiteral("AUQW_ANDROID_APK_PATH")),
            "Android smoke should accept an already-built APK path");
        QVERIFY2(script.contains(QStringLiteral("ci/android-build.sh")),
            "Android smoke should build the APK when no APK path is provided");
        QVERIFY2(script.contains(QStringLiteral("adb devices")),
            "Android smoke should discover attached emulator/device targets");
        QVERIFY2(script.contains(QStringLiteral("install -r")),
            "Android smoke should install the APK before launch");
        QVERIFY2(script.contains(QStringLiteral("am start")),
            "Android smoke should launch the Qt activity");
        QVERIFY2(script.contains(QStringLiteral("logcat")) &&
                script.contains(QStringLiteral("FATAL EXCEPTION")) &&
                script.contains(QStringLiteral("Process crashed")),
            "Android smoke should collect logcat and fail on launch crashes");
        QVERIFY2(script.contains(QStringLiteral("dumpsys media_session")),
            "Android smoke should collect MediaSession runtime evidence");
        QVERIFY2(script.contains(QStringLiteral("dumpsys activity services")),
            "Android smoke should fall back to active service evidence when package dumps omit non-exported services");
        QVERIFY2(script.contains(QStringLiteral("AuqwPlaybackService")),
            "Android smoke should check the playback service evidence path");
        QVERIFY2(script.contains(QStringLiteral("attach Android target")),
            "Android smoke should fail clearly when no target is attached");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ANDROID_SMOKE_SOURCE_ONLY")),
            "Android smoke should support explicit source-only CI mode without claiming runtime pass");
        QVERIFY2(docs.contains(QStringLiteral("ci/android-runtime-smoke.sh")),
            "Platform docs should document the Android runtime smoke gate");
    }

    void iosRuntimeSmokeRequiresNativeHostTargetEvidence() {
        const QString script = readTextFile(projectSourcePath(u"ci/ios-runtime-smoke.sh"));
        const QString docs = readTextFile(projectSourcePath(u"ci/platform-builds.md"));

        QVERIFY2(!script.isEmpty(), "ci/ios-runtime-smoke.sh should be readable");
        QVERIFY2(!docs.isEmpty(), "ci/platform-builds.md should be readable");

        QVERIFY2(script.contains(QStringLiteral("ci/ios-build.sh")),
            "iOS smoke should build/validate the app when no app path is provided");
        QVERIFY2(script.contains(QStringLiteral("AUQW_IOS_APP_PATH")),
            "iOS smoke should accept an already-built app bundle");
        QVERIFY2(script.contains(QStringLiteral("xcrun simctl")),
            "iOS smoke should use simctl for simulator/device launch evidence");
        QVERIFY2(script.contains(QStringLiteral("booted")),
            "iOS smoke should target a booted simulator/device");
        QVERIFY2(script.contains(QStringLiteral("com.Vehicoule.auqw")),
            "iOS smoke should launch the Auqw bundle id");
        QVERIFY2(script.contains(QStringLiteral("AVFoundation")),
            "iOS smoke should keep Apple framework linkage validation in the runtime gate");
        QVERIFY2(script.contains(QStringLiteral("MediaPlayer")),
            "iOS smoke should keep MediaPlayer linkage validation in the runtime gate");
        QVERIFY2(script.contains(QStringLiteral("attach iOS target")),
            "iOS smoke should fail clearly when no target is available");
        QVERIFY2(script.contains(QStringLiteral("AUQW_IOS_SMOKE_SOURCE_ONLY")),
            "iOS smoke should support explicit source-only CI mode without claiming runtime pass");
        QVERIFY2(docs.contains(QStringLiteral("ci/ios-runtime-smoke.sh")),
            "Platform docs should document the iOS runtime smoke gate");
    }

    void freebsdDocsAndRuntimeCheckMirrorSourceBuildFlow() {
        const QString docs = readTextFile(projectSourcePath(u"ci/platform-builds.md"));
        const QString runtimeCheck = readTextFile(projectSourcePath(u"ci/check-freebsd-runtime.sh"));

        QVERIFY2(!docs.isEmpty(), "ci/platform-builds.md should be readable");
        QVERIFY2(!runtimeCheck.isEmpty(), "ci/check-freebsd-runtime.sh should be readable");

        QVERIFY2(docs.contains(QStringLiteral("pkg install")), "FreeBSD docs should list native package dependencies");
        QVERIFY2(docs.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "FreeBSD docs should require Qt Multimedia for platform playback builds");
        QVERIFY2(docs.contains(QStringLiteral("ci/check-freebsd-runtime.sh")), "FreeBSD docs should document runtime validation script");
        QVERIFY2(runtimeCheck.contains(QStringLiteral("ldd")), "FreeBSD runtime check should use native ldd");
        QVERIFY2(runtimeCheck.contains(QStringLiteral("libQt6Multimedia")), "FreeBSD runtime check should verify Qt Multimedia linkage when present");
        QVERIFY2(runtimeCheck.contains(QStringLiteral("plugins/multimedia")), "FreeBSD runtime check should verify Qt Multimedia backend plugin path");
    }

    void windowsPackageContainsExpectedRuntimeWhenPathProvided() {
        const QString packagePath = packagePathFromEnv("AUQW_WINDOWS_PACKAGE_DIR");
        if (packagePath.isEmpty()) {
            QSKIP("Set AUQW_WINDOWS_PACKAGE_DIR to verify deployed Windows package contents");
        }
        if (!QFileInfo::exists(packagePath)) {
            QSKIP(qPrintable(QStringLiteral("Windows package not found at %1").arg(packagePath)));
        }

        const QStringList files = recursiveFileNames(packagePath);
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("auqw.exe")), "Windows package should contain auqw.exe");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Qt6Core.dll")), "Windows package should contain Qt6Core.dll");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Qt6Multimedia.dll")), "Windows package should contain Qt6Multimedia.dll");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("vcruntime140.dll")), "Windows package should contain vcruntime140.dll");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("vcruntime140_1.dll")), "Windows package should contain vcruntime140_1.dll");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("msvcp140.dll")), "Windows package should contain msvcp140.dll");
        QVERIFY2(hasFileContaining(files, QStringLiteral("msvcp140_")),
            "Windows package should contain available msvcp140 companion DLLs");
        QVERIFY2(hasFileContaining(files, QStringLiteral("plugins/multimedia/")) || hasFileContaining(files, QStringLiteral("multimedia/")),
            "Windows package should contain a Qt Multimedia backend plugin");
    }

    void macosBundleContainsExpectedRuntimeWhenPathProvided() {
        const QString appPath = packagePathFromEnv("AUQW_MACOS_APP_PATH");
        if (appPath.isEmpty()) {
            QSKIP("Set AUQW_MACOS_APP_PATH to verify deployed macOS bundle contents");
        }
        if (!QFileInfo::exists(appPath)) {
            QSKIP(qPrintable(QStringLiteral("macOS app bundle not found at %1").arg(appPath)));
        }

        const QStringList files = recursiveFileNames(appPath);
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Contents/Info.plist")), "macOS bundle should contain Info.plist");
        QVERIFY2(hasFileContaining(files, QStringLiteral("Contents/Frameworks/QtMultimedia.framework")),
            "macOS bundle should contain Qt Multimedia framework");
        QVERIFY2(hasFileContaining(files, QStringLiteral("Contents/PlugIns/multimedia/")),
            "macOS bundle should contain a Qt Multimedia backend plugin");
    }

    void iosBundleContainsExpectedMetadataWhenPathProvided() {
        const QString appPath = packagePathFromEnv("AUQW_IOS_APP_PATH");
        if (appPath.isEmpty()) {
            QSKIP("Set AUQW_IOS_APP_PATH to verify built iOS bundle contents");
        }
        if (!QFileInfo::exists(appPath)) {
            QSKIP(qPrintable(QStringLiteral("iOS app bundle not found at %1").arg(appPath)));
        }

        const QStringList files = recursiveFileNames(appPath);
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Info.plist")), "iOS bundle should contain Info.plist");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("auqw")), "iOS bundle should contain app binary");
        QVERIFY2(hasFileContaining(files, QStringLiteral("Frameworks")),
            "iOS bundle should contain deployed framework layout when Qt kit produced artifacts");
    }
};

QTEST_GUILESS_MAIN(PlatformPackageTest)

#include "platform_package_test.moc"
