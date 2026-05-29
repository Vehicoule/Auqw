#include <QFile>
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
