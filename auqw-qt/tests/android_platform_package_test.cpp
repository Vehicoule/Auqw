#include <QFile>
#include <QFileInfo>
#include <QString>
#include <QTest>

namespace {

QString packageSourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QLatin1Char('/') + relativePath.toString();
}

QString readTextFile(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return {};
    }
    return QString::fromUtf8(file.readAll());
}

QByteArray readBinaryFile(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        return {};
    }
    return file.readAll();
}

QString sourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QStringLiteral("/../") + relativePath.toString();
}

QString projectSourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QStringLiteral("/../../") + relativePath.toString();
}

QString androidApkPath() {
    return qEnvironmentVariable("AUQW_ANDROID_APK_PATH");
}

bool hasUsesPermission(const QString& manifest, const QString& permission) {
    return manifest.contains(QStringLiteral("android:name=\"%1\"").arg(permission));
}

} // namespace

class AndroidPlatformPackageTest final : public QObject {
    Q_OBJECT

private slots:
    void manifestDeclaresForegroundMediaService() {
        const QString manifest = readTextFile(packageSourcePath(u"AndroidManifest.xml"));
        QVERIFY2(!manifest.isEmpty(), "AndroidManifest.xml should be readable");

        QVERIFY(hasUsesPermission(manifest, QStringLiteral("android.permission.INTERNET")));
        QVERIFY(hasUsesPermission(manifest, QStringLiteral("android.permission.FOREGROUND_SERVICE")));
        QVERIFY(hasUsesPermission(manifest, QStringLiteral("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK")));
        QVERIFY(hasUsesPermission(manifest, QStringLiteral("android.permission.POST_NOTIFICATIONS")));
        QVERIFY2(!hasUsesPermission(manifest, QStringLiteral("android.permission.WRITE_EXTERNAL_STORAGE")),
            "Android 15-targeted package should not request legacy external storage write permission");
        QVERIFY2(!manifest.contains(QStringLiteral("requestLegacyExternalStorage")),
            "Android 15-targeted package should not opt into legacy external storage");
        QVERIFY(manifest.contains(QStringLiteral("android:name=\"com.Vehicoule.auqw.AuqwActivity\"")));
        QVERIFY(manifest.contains(QStringLiteral("android:name=\"com.Vehicoule.auqw.AuqwPlaybackService\"")));
        QVERIFY(manifest.contains(QStringLiteral("android:foregroundServiceType=\"mediaPlayback\"")));
        QVERIFY(manifest.contains(QStringLiteral("android:exported=\"false\"")));
    }

    void bridgeKeepsMediaSessionBehindAndroidPackage() {
        const QString activity = readTextFile(packageSourcePath(u"src/com/Vehicoule/auqw/AuqwActivity.java"));
        const QString bridge = readTextFile(packageSourcePath(u"src/com/Vehicoule/auqw/AuqwMediaSessionBridge.java"));
        const QString service = readTextFile(packageSourcePath(u"src/com/Vehicoule/auqw/AuqwPlaybackService.java"));

        QVERIFY2(activity.contains(QStringLiteral("extends QtActivity")), "custom activity should keep Qt lifecycle");
        QVERIFY2(bridge.contains(QStringLiteral("startForegroundService")), "bridge should start Android foreground service");
        QVERIFY2(service.contains(QStringLiteral("MediaSession")), "service should own Android MediaSession");
        QVERIFY2(service.contains(QStringLiteral("PlaybackState")), "service should publish media playback state");
        QVERIFY2(service.contains(QStringLiteral("startForeground(")), "service should enter foreground while playback is active");
    }

    void bridgeDispatchesAndroidControlsToNativeController() {
        const QString bridge = readTextFile(packageSourcePath(u"src/com/Vehicoule/auqw/AuqwMediaSessionBridge.java"));
        const QString service = readTextFile(packageSourcePath(u"src/com/Vehicoule/auqw/AuqwPlaybackService.java"));

        QVERIFY2(bridge.contains(QStringLiteral("dispatchPlaybackCommand")), "bridge should expose Java command dispatch");
        QVERIFY2(bridge.contains(QStringLiteral("nativeDispatchPlaybackCommand")), "bridge should call native playback command dispatch");
        QVERIFY2(bridge.contains(QStringLiteral("UnsatisfiedLinkError")), "bridge should no-op safely before the native library is ready");
        QVERIFY2(service.contains(QStringLiteral("dispatchPlaybackCommand(\"play\"")), "MediaSession play should dispatch to native controller");
        QVERIFY2(service.contains(QStringLiteral("dispatchPlaybackCommand(\"pause\"")), "MediaSession pause should dispatch to native controller");
        QVERIFY2(service.contains(QStringLiteral("dispatchPlaybackCommand(\"stop\"")), "MediaSession stop should dispatch to native controller");
        QVERIFY2(service.contains(QStringLiteral("dispatchPlaybackCommand(\"next\"")), "MediaSession next should dispatch to native controller");
        QVERIFY2(service.contains(QStringLiteral("dispatchPlaybackCommand(\"previous\"")), "MediaSession previous should dispatch to native controller");
        QVERIFY2(!service.contains(QStringLiteral("sendBroadcast(intent)")), "Android controls should not stop at an unhandled broadcast");
    }

    void serviceHandlesSeekAudioFocusAndNoisyAudio() {
        const QString service = readTextFile(packageSourcePath(u"src/com/Vehicoule/auqw/AuqwPlaybackService.java"));

        QVERIFY2(service.contains(QStringLiteral("onSeekTo")), "MediaSession seek should be handled");
        QVERIFY2(service.contains(QStringLiteral("ACTION_AUDIO_BECOMING_NOISY")), "headset or Bluetooth disconnect should be observed");
        QVERIFY2(service.contains(QStringLiteral("registerReceiver")), "service should register noisy-audio receiver while active");
        QVERIFY2(service.contains(QStringLiteral("unregisterReceiver")), "service should unregister noisy-audio receiver when inactive");
        QVERIFY2(service.contains(QStringLiteral("requestAudioFocus")), "service should request audio focus for active playback");
        QVERIFY2(service.contains(QStringLiteral("abandonAudioFocus")), "service should abandon audio focus when playback is inactive");
        QVERIFY2(service.contains(QStringLiteral("AUDIOFOCUS_LOSS")), "full audio focus loss should be handled");
        QVERIFY2(service.contains(QStringLiteral("AUDIOFOCUS_LOSS_TRANSIENT")), "transient audio focus loss should be handled");
    }

    void nativeControllerSyncsFromCorePlaybackState() {
        const QString controller = readTextFile(QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QStringLiteral("/../src/AndroidPlaybackController.cpp"));
        const QString main = readTextFile(QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QStringLiteral("/../src/main.cpp"));

        QVERIFY2(controller.contains(QStringLiteral("playbackStateChanged")), "native Android controller should observe CoreController state");
        QVERIFY2(controller.contains(QStringLiteral("AuqwMediaSessionBridge")), "native Android controller should call Android bridge");
        QVERIFY2(controller.contains(QStringLiteral("playbackTitle")), "native Android controller should sync metadata from Zig-backed controller properties");
        QVERIFY2(main.contains(QStringLiteral("AUQW_ENABLE_ANDROID_PLATFORM")), "main should guard Android playback integration");
        QVERIFY2(!main.contains(QStringLiteral("DesktopPlatformController desktopPlatformController(coreController);\n#endif\n#if AUQW_ENABLE_ANDROID_PLATFORM")),
            "Android integration should not sit inside desktop platform guard");
    }

    void androidNativeBackendPlaysHeaderedRemoteStreams() {
        const QString cmake = readTextFile(sourcePath(u"CMakeLists.txt"));
        const QString playbackHeader = readTextFile(sourcePath(u"src/PlaybackBackend.hpp"));
        const QString playbackBackend = readTextFile(sourcePath(u"src/PlaybackBackend.cpp"));
        const QString androidBackend = readTextFile(sourcePath(u"src/AndroidNativePlaybackBackend.cpp"));
        const QString nativePlayer = readTextFile(packageSourcePath(u"src/com/Vehicoule/auqw/AuqwNativeAudioPlayer.java"));

        QVERIFY2(!cmake.isEmpty(), "Qt CMakeLists.txt should be readable");
        QVERIFY2(!playbackHeader.isEmpty(), "PlaybackBackend.hpp should be readable");
        QVERIFY2(!playbackBackend.isEmpty(), "PlaybackBackend.cpp should be readable");
        QVERIFY2(!androidBackend.isEmpty(), "Android native playback backend should exist");
        QVERIFY2(!nativePlayer.isEmpty(), "Android native audio player should exist");

        QVERIFY2(playbackHeader.contains(QStringLiteral("playHeaderedRemoteUrl")),
            "playback backend interface should expose headered remote URL playback");
        QVERIFY2(playbackBackend.contains(QStringLiteral("createAndroidNativePlaybackBackend")),
            "default Android backend should wrap Qt Multimedia with the native Android backend");
        QVERIFY2(cmake.contains(QStringLiteral("src/AndroidNativePlaybackBackend.cpp")),
            "Android build should compile the native Android playback backend");
        QVERIFY2(nativePlayer.contains(QStringLiteral("MediaPlayer")),
            "Android native player should use platform MediaPlayer");
        QVERIFY2(nativePlayer.contains(QStringLiteral("setDataSource")) &&
                nativePlayer.contains(QStringLiteral("HashMap")),
            "Android native player should pass request headers into MediaPlayer.setDataSource");
        QVERIFY2(nativePlayer.contains(QStringLiteral("nativeOnPlaybackState")) &&
                nativePlayer.contains(QStringLiteral("nativeOnPlaybackError")),
            "Android native player should report state and errors to the Qt backend");
    }

    void headeredOnlinePlaybackRoutesThroughBackendApi() {
        const QString coreSearch = readTextFile(sourcePath(u"src/CoreControllerSearch.cpp"));
        QVERIFY2(!coreSearch.isEmpty(), "CoreControllerSearch.cpp should be readable");

        QVERIFY2(coreSearch.contains(QStringLiteral("OnlineStreamKind::HeaderedDirectUrl")),
            "headered direct streams should keep an explicit routing branch");
        QVERIFY2(coreSearch.contains(QStringLiteral("playHeaderedRemoteUrl")),
            "headered direct streams should use backend-level headered URL playback");
        QVERIFY2(!coreSearch.contains(QStringLiteral("std::make_unique<YoutubeHttpAudioDevice>(stream.streamUrl, stream.requestHeaders)")),
            "CoreController should not force headered streams through Qt setSourceDevice on Android");
    }

    void cmakePackagesAndroidOpenSslLibraries() {
        const QString cmake = readTextFile(sourcePath(u"CMakeLists.txt"));
        QVERIFY2(!cmake.isEmpty(), "Qt CMakeLists.txt should be readable");

        QVERIFY2(cmake.contains(QStringLiteral("include(FetchContent)")), "Android build should use FetchContent for android_openssl");
        QVERIFY2(cmake.contains(QStringLiteral("FetchContent_Declare")), "Android build should declare android_openssl");
        QVERIFY2(cmake.contains(QStringLiteral("android_openssl")), "Android build should name the android_openssl dependency");
        QVERIFY2(cmake.contains(QStringLiteral("https://github.com/KDAB/android_openssl.git")), "Android OpenSSL source should use KDAB repository");
        QVERIFY2(cmake.contains(QStringLiteral("b71f1470962019bd89534a2919f5925f93bc5779")), "Android OpenSSL source should be pinned");
        QVERIFY2(cmake.contains(QStringLiteral("android_openssl.cmake")), "Android build should include android_openssl.cmake");
        QVERIFY2(cmake.contains(QStringLiteral("add_android_openssl_libraries(Auqw)")), "Android build should package OpenSSL libraries with Auqw");
    }

    void androidBuildUsesPreloadedAndroidOpenSslSource() {
        const QString containerfile = readTextFile(projectSourcePath(u"containers/android-linux/Containerfile"));
        const QString androidBuild = readTextFile(projectSourcePath(u"ci/android-build.sh"));

        QVERIFY2(!containerfile.isEmpty(), "Android Containerfile should be readable");
        QVERIFY2(!androidBuild.isEmpty(), "Android build script should be readable");

        QVERIFY2(containerfile.contains(QStringLiteral("ANDROID_OPENSSL_SOURCE_DIR=/opt/android_openssl")),
            "Android image should define the preloaded android_openssl source directory");
        QVERIFY2(containerfile.contains(QStringLiteral("https://github.com/KDAB/android_openssl.git")),
            "Android image should prefetch android_openssl from KDAB");
        QVERIFY2(containerfile.contains(QStringLiteral("b71f1470962019bd89534a2919f5925f93bc5779")),
            "Android image should keep android_openssl pinned to the reviewed commit");
        QVERIFY2(containerfile.contains(QStringLiteral("rm -rf \"${ANDROID_OPENSSL_SOURCE_DIR}/.git\"")),
            "Android image should drop android_openssl Git metadata after checkout");
        QVERIFY2(androidBuild.contains(QStringLiteral("ANDROID_OPENSSL_SOURCE_DIR")),
            "Android build script should read the preloaded android_openssl source env");
        QVERIFY2(androidBuild.contains(QStringLiteral("android_openssl.cmake")),
            "Android build script should validate the preloaded android_openssl source");
        QVERIFY2(androidBuild.contains(QStringLiteral("FETCHCONTENT_SOURCE_DIR_ANDROID_OPENSSL")),
            "Android CMake configure should use the preloaded android_openssl source when present");
    }

    void androidBuildRequiresQtMultimedia() {
        const QString containerfile = readTextFile(projectSourcePath(u"containers/android-linux/Containerfile"));
        const QString androidBuild = readTextFile(projectSourcePath(u"ci/android-build.sh"));
        const QString rootCmake = readTextFile(projectSourcePath(u"CMakeLists.txt"));
        const QString qtCmake = readTextFile(sourcePath(u"CMakeLists.txt"));

        QVERIFY2(!containerfile.isEmpty(), "Android Containerfile should be readable");
        QVERIFY2(!androidBuild.isEmpty(), "Android build script should be readable");
        QVERIFY2(!rootCmake.isEmpty(), "root CMakeLists.txt should be readable");
        QVERIFY2(!qtCmake.isEmpty(), "Qt CMakeLists.txt should be readable");

        QVERIFY2(containerfile.contains(QStringLiteral("-m qtmultimedia")),
            "Android Qt install should include qtmultimedia");
        QVERIFY2(androidBuild.contains(QStringLiteral("Qt6Multimedia/Qt6MultimediaConfig.cmake")),
            "Android build should fail fast when Qt Multimedia is absent");
        QVERIFY2(rootCmake.contains(QStringLiteral("find_package(Qt6 6.4 REQUIRED COMPONENTS Multimedia)")),
            "Android CMake configure should require Qt Multimedia");
        QVERIFY2(!qtCmake.contains(QStringLiteral("Qt6Multimedia_FOUND AND NOT ANDROID")),
            "Qt Multimedia backend should not exclude Android");
        QVERIFY2(qtCmake.contains(QStringLiteral("if(Qt6Multimedia_FOUND)")),
            "Qt Multimedia backend should enable whenever Qt6Multimedia is found");
    }

    void androidBuildExtendsGradleWrapperTimeout() {
        const QString androidBuild = readTextFile(projectSourcePath(u"ci/android-build.sh"));
        QVERIFY2(!androidBuild.isEmpty(), "Android build script should be readable");

        QVERIFY2(androidBuild.contains(QStringLiteral("networkTimeout=60000")),
            "Android build should raise Qt-generated Gradle wrapper download timeout");
    }

    void androidBuildTargetsApi35() {
        const QString androidBuild = readTextFile(projectSourcePath(u"ci/android-build.sh"));
        const QString containerfile = readTextFile(projectSourcePath(u"containers/android-linux/Containerfile"));
        const QString qtCmake = readTextFile(sourcePath(u"CMakeLists.txt"));

        QVERIFY2(!androidBuild.isEmpty(), "ci/android-build.sh should be readable");
        QVERIFY2(!containerfile.isEmpty(), "Android Containerfile should be readable");
        QVERIFY2(!qtCmake.isEmpty(), "Qt CMakeLists.txt should be readable");

        QVERIFY2(androidBuild.contains(QStringLiteral("ANDROID_PLATFORM:-android-35")),
            "Android build should default to API 35 platform");
        QVERIFY2(androidBuild.contains(QStringLiteral("ANDROID_BUILD_TOOLS:-35.0.0")),
            "Android build should default to Android build tools 35.0.0");
        QVERIFY2(containerfile.contains(QStringLiteral("ARG ANDROID_PLATFORM=android-35")),
            "Android container should install API 35 platform");
        QVERIFY2(containerfile.contains(QStringLiteral("ARG ANDROID_BUILD_TOOLS=35.0.0")),
            "Android container should install build tools 35.0.0");
        QVERIFY2(qtCmake.contains(QStringLiteral("QT_ANDROID_SDK_BUILD_TOOLS_REVISION 35.0.0")),
            "Qt Android package should declare build tools 35.0.0");
        QVERIFY2(qtCmake.contains(QStringLiteral("QT_ANDROID_TARGET_SDK_VERSION 35")),
            "Qt Android package should target API 35");
        QVERIFY2(androidBuild.contains(QStringLiteral("android.aapt2FromMavenOverride")),
            "Android build should force Gradle to use SDK build-tools aapt2 for API 35 resources");
        QVERIFY2(androidBuild.contains(QStringLiteral("android.suppressUnsupportedCompileSdk")) &&
                androidBuild.contains(QStringLiteral("\"35\"")),
            "Android build should suppress the expected Qt 6.7 Android Gradle plugin compileSdk 35 warning");
    }

    void androidQmlModuleUsesStandardFlatResourcePath() {
        const QString qtCmake = readTextFile(sourcePath(u"CMakeLists.txt"));
        const QString main = readTextFile(sourcePath(u"src/main.cpp"));

        QVERIFY2(!qtCmake.isEmpty(), "Qt CMakeLists.txt should be readable");
        QVERIFY2(!main.isEmpty(), "main.cpp should be readable");

        QVERIFY2(qtCmake.contains(QStringLiteral("RESOURCE_PREFIX /qt/qml")),
            "Android QML module should use the standard qrc:/qt/qml import prefix");
        QVERIFY2(qtCmake.contains(QStringLiteral("set_source_files_properties(qml/Main.qml")),
            "Main.qml should have an explicit Qt resource alias");
        QVERIFY2(qtCmake.contains(QStringLiteral("QT_RESOURCE_ALIAS Main.qml")),
            "Main.qml should be flattened to the Auqw module root for androiddeployqt scanning");
        QVERIFY2(main.contains(QStringLiteral("qrc:/qt/qml/Auqw/Main.qml")),
            "Qt 6.4 fallback loading should match the packaged QML module resource path");
        QVERIFY2(!main.contains(QStringLiteral("qrc:/Auqw/qml/Main.qml")),
            "Fallback loading should not use the stale non-standard resource path");
    }

    void androidBuildPatchesQmlScannerSourceRoots() {
        const QString androidBuild = readTextFile(projectSourcePath(u"ci/android-build.sh"));
        QVERIFY2(!androidBuild.isEmpty(), "ci/android-build.sh should be readable");

        QVERIFY2(androidBuild.contains(QStringLiteral("patch_android_deployment_qml_settings")),
            "Android build should patch generated Qt deployment settings before apk creation");
        QVERIFY2(androidBuild.contains(QStringLiteral("data.pop(\"qml-root-path\", None)")),
            "Android deploy settings should not feed source QML roots to Qt 6.7 qmlimportscanner");
        QVERIFY2(androidBuild.contains(QStringLiteral("\"qml-import-paths\"")),
            "Android deploy settings patch should preserve build-tree QML import paths");
        QVERIFY2(androidBuild.contains(QStringLiteral("relative_to(module_build_dir)")),
            "Android deploy settings patch should drop source-tree QML import paths");
    }

    void androidBuildChecksGradleJavaCompatibility() {
        const QString androidBuild = readTextFile(projectSourcePath(u"ci/android-build.sh"));
        QVERIFY2(!androidBuild.isEmpty(), "ci/android-build.sh should be readable");

        QVERIFY2(androidBuild.contains(QStringLiteral("AUQW_JAVA_HOME")),
            "Android build should allow a repo-local Java override for Qt's Gradle wrapper");
        QVERIFY2(androidBuild.contains(QStringLiteral("java_major")),
            "Android build should inspect the active Java major version");
        QVERIFY2(androidBuild.contains(QStringLiteral("Qt Android Gradle wrapper requires Java")),
            "Android build should fail fast on unsupported Java runtimes");
        QVERIFY2(androidBuild.contains(QStringLiteral("Unsupported class file major version")),
            "Android build should explain the Gradle failure it is preventing");
    }

    void playbackBackendLogsAndroidMultimediaDiagnostics() {
        const QString playbackBackend = readTextFile(sourcePath(u"src/PlaybackBackend.cpp"));
        QVERIFY2(!playbackBackend.isEmpty(), "PlaybackBackend.cpp should be readable");

        QVERIFY2(playbackBackend.contains(QStringLiteral("AUQW_HAS_QT_MULTIMEDIA=1")),
            "Qt Multimedia backend startup should log AUQW_HAS_QT_MULTIMEDIA=1");
        QVERIFY2(playbackBackend.contains(QStringLiteral("AUQW_HAS_QT_MULTIMEDIA=0")),
            "stub backend startup should log AUQW_HAS_QT_MULTIMEDIA=0");
        QVERIFY2(playbackBackend.contains(QStringLiteral("playStreamDevice")),
            "stream-device playback should log diagnostics");
        QVERIFY2(playbackBackend.contains(QStringLiteral("deviceType")),
            "stream-device diagnostics should include device type");
        QVERIFY2(playbackBackend.contains(QStringLiteral("QMediaPlayer error")),
            "QMediaPlayer errors should log debug diagnostics");
        QVERIFY2(playbackBackend.contains(QStringLiteral("mediaStatus")),
            "QMediaPlayer error diagnostics should include media status");
    }

    void packagedApkContainsQtTlsBackendAndOpenSsl() {
        const QString apkPath = androidApkPath();
        if (apkPath.isEmpty()) {
            QSKIP("Set AUQW_ANDROID_APK_PATH to verify packaged APK contents");
        }
        if (!QFileInfo::exists(apkPath)) {
            QSKIP(qPrintable(QStringLiteral("Android APK not found at %1").arg(apkPath)));
        }

        const QByteArray apk = readBinaryFile(apkPath);
        QVERIFY2(!apk.isEmpty(), "Android APK should be readable");
        QVERIFY2(apk.contains("lib/arm64-v8a/libplugins_tls_qopensslbackend_arm64-v8a.so"),
            "APK should contain Qt OpenSSL TLS backend plugin");
        QVERIFY2(apk.contains("lib/arm64-v8a/libssl_3.so"), "APK should contain libssl_3.so");
        QVERIFY2(apk.contains("lib/arm64-v8a/libcrypto_3.so"), "APK should contain libcrypto_3.so");
    }

    void packagedApkContainsQtMultimediaRuntime() {
        const QString apkPath = androidApkPath();
        if (apkPath.isEmpty()) {
            QSKIP("Set AUQW_ANDROID_APK_PATH to verify packaged APK contents");
        }
        if (!QFileInfo::exists(apkPath)) {
            QSKIP(qPrintable(QStringLiteral("Android APK not found at %1").arg(apkPath)));
        }

        const QByteArray apk = readBinaryFile(apkPath);
        QVERIFY2(!apk.isEmpty(), "Android APK should be readable");
        QVERIFY2(apk.contains("lib/arm64-v8a/libQt6Multimedia_arm64-v8a.so"),
            "APK should contain Qt Multimedia runtime library");
        QVERIFY2(apk.contains("lib/arm64-v8a/libplugins_multimedia_"),
            "APK should contain at least one Qt Multimedia backend plugin");
    }

    void nativeControllerRoutesAndroidCommandsToCorePlayback() {
        const QString controller = readTextFile(QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QStringLiteral("/../src/AndroidPlaybackController.cpp"));

        QVERIFY2(controller.contains(QStringLiteral("nativeDispatchPlaybackCommand")), "native JNI entrypoint should receive Android commands");
        QVERIFY2(controller.contains(QStringLiteral("QMetaObject::invokeMethod")), "Android commands should be marshalled onto the Qt object thread");
        QVERIFY2(controller.contains(QStringLiteral("resumePlayback")), "Android play command should resume paused playback");
        QVERIFY2(controller.contains(QStringLiteral("playFirstQueuedTrack")), "Android play command should start queue playback when not paused");
        QVERIFY2(controller.contains(QStringLiteral("pausePlayback")), "Android pause command should pause core playback");
        QVERIFY2(controller.contains(QStringLiteral("stopPlayback")), "Android stop command should stop core playback");
        QVERIFY2(controller.contains(QStringLiteral("playNextQueuedTrack")), "Android next command should use core queue navigation");
        QVERIFY2(controller.contains(QStringLiteral("playPreviousQueuedTrack")), "Android previous command should use core queue navigation");
        QVERIFY2(controller.contains(QStringLiteral("seekPlayback")), "Android seek command should use core seeking");
    }
};

QTEST_GUILESS_MAIN(AndroidPlatformPackageTest)

#include "android_platform_package_test.moc"
