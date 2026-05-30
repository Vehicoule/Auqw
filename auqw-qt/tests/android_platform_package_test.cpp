#include <QFile>
#include <QFileInfo>
#include <QString>
#include <QTest>

namespace {

QString packageSourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QLatin1Char('/') + relativePath;
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
    return QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QStringLiteral("/../") + relativePath;
}

QString projectSourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_ANDROID_PACKAGE_SOURCE_DIR) + QStringLiteral("/../../") + relativePath;
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
        QVERIFY2(rootCmake.contains(QStringLiteral("find_package(Qt6 6.5 REQUIRED COMPONENTS Multimedia)")),
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
