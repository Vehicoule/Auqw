#include <QFile>
#include <QString>
#include <QTest>

namespace {

QString sourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_QT_SOURCE_DIR) + QLatin1Char('/') + relativePath.toString();
}

QString readTextFile(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return {};
    }
    return QString::fromUtf8(file.readAll());
}

} // namespace

class IosPlatformWiringTest final : public QObject {
    Q_OBJECT

private slots:
    void cmakeEnablesIosPlatformOnlyForIosTargets() {
        const QString cmake = readTextFile(sourcePath(u"CMakeLists.txt"));
        QVERIFY2(!cmake.isEmpty(), "auqw-qt/CMakeLists.txt should be readable");

        QVERIFY2(cmake.contains(QStringLiteral("AUQW_ENABLE_IOS_PLATFORM")), "iOS platform guard should exist");
        QVERIFY2(cmake.contains(QStringLiteral("CMAKE_SYSTEM_NAME STREQUAL \"iOS\"")), "iOS guard should use target system name");
        QVERIFY2(cmake.contains(QStringLiteral("src/IosPlaybackController.mm")), "iOS controller should be built only through iOS source wiring");
        QVERIFY2(cmake.contains(QStringLiteral("src/ApplePlaybackBackend.mm")), "AVPlayer backend should be built only through iOS source wiring");
        QVERIFY2(cmake.contains(QStringLiteral("-framework AVFoundation")), "iOS target should link AVFoundation");
        QVERIFY2(cmake.contains(QStringLiteral("-framework MediaPlayer")), "iOS target should link MediaPlayer");
    }

    void mainWiresIosControllerOutsideOtherPlatformGuards() {
        const QString main = readTextFile(sourcePath(u"src/main.cpp"));
        QVERIFY2(!main.isEmpty(), "main.cpp should be readable");

        QVERIFY2(main.contains(QStringLiteral("#if AUQW_ENABLE_IOS_PLATFORM")), "main should guard iOS playback integration");
        QVERIFY2(main.contains(QStringLiteral("IosPlaybackController iosPlaybackController(coreController);")), "main should create iOS controller");
        QVERIFY2(!main.contains(QStringLiteral("DesktopPlatformController desktopPlatformController(coreController);\n#if AUQW_ENABLE_IOS_PLATFORM")),
            "iOS integration should not sit inside desktop platform guard");
        QVERIFY2(!main.contains(QStringLiteral("AndroidPlaybackController androidPlaybackController(coreController);\n#if AUQW_ENABLE_IOS_PLATFORM")),
            "iOS integration should not sit inside Android platform guard");
    }

    void iosSourcesUseApplePlaybackAndSystemControls() {
        const QString backend = readTextFile(sourcePath(u"src/ApplePlaybackBackend.mm"));
        const QString controller = readTextFile(sourcePath(u"src/IosPlaybackController.mm"));

        QVERIFY2(!backend.isEmpty(), "ApplePlaybackBackend.mm should be readable");
        QVERIFY2(!controller.isEmpty(), "IosPlaybackController.mm should be readable");
        QVERIFY2(backend.contains(QStringLiteral("AUQW_ENABLE_IOS_PLATFORM")), "Apple backend should stay behind iOS guard");
        QVERIFY2(backend.contains(QStringLiteral("AVPlayer")), "Apple backend should use AVPlayer");
        QVERIFY2(controller.contains(QStringLiteral("AVAudioSession")), "iOS controller should configure AVAudioSession");
        QVERIFY2(controller.contains(QStringLiteral("MPRemoteCommandCenter")), "iOS controller should register remote commands");
        QVERIFY2(controller.contains(QStringLiteral("MPNowPlayingInfoCenter")), "iOS controller should sync now-playing metadata");
    }

    void remoteCommandsRouteToCorePlayback() {
        const QString controller = readTextFile(sourcePath(u"src/IosPlaybackController.mm"));
        QVERIFY2(!controller.isEmpty(), "IosPlaybackController.mm should be readable");

        QVERIFY2(controller.contains(QStringLiteral("resumePlayback")), "iOS play command should resume paused playback");
        QVERIFY2(controller.contains(QStringLiteral("pausePlayback")), "iOS pause command should pause core playback");
        QVERIFY2(controller.contains(QStringLiteral("stopPlayback")), "iOS stop command should stop core playback");
        QVERIFY2(controller.contains(QStringLiteral("playNextQueuedTrack")), "iOS next command should use core queue navigation");
        QVERIFY2(controller.contains(QStringLiteral("playPreviousQueuedTrack")), "iOS previous command should use core queue navigation");
        QVERIFY2(controller.contains(QStringLiteral("seekPlayback")), "iOS seek command should use core seeking");
        QVERIFY2(controller.contains(QStringLiteral("AVAudioSessionInterruptionNotification")), "iOS interruptions should be observed");
    }
};

QTEST_GUILESS_MAIN(IosPlatformWiringTest)

#include "ios_platform_wiring_test.moc"
