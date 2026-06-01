#include "../src/CoreController.hpp"
#include "../src/DesktopPlatformController.hpp"
#include "../src/PlaybackBackend.hpp"
#include "test_storage.hpp"

#include <QAbstractItemModel>
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QKeyEvent>
#include <QMetaObject>
#include <QSettings>
#include <QSignalSpy>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTest>
#include <QUrl>
#include <QWindow>

#include <memory>
#include <optional>
#include <utility>

namespace {

bool writeTestFile(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        return false;
    }
    return file.write("test") == 4;
}

int roleForName(const QAbstractItemModel* model, const QByteArray& name) {
    const QHash<int, QByteArray> roles = model->roleNames();
    for (auto it = roles.cbegin(); it != roles.cend(); ++it) {
        if (it.value() == name) {
            return it.key();
        }
    }
    return -1;
}

class FakePlaybackBackend final : public PlaybackBackend {
public:
    void playLocalFile(const QString& path) override {
        ++playCalls;
        lastPath = path;
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void playRemoteUrl(const QUrl& url) override {
        ++remotePlayCalls;
        lastRemoteUrl = url;
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void playHeaderedRemoteUrl(
        const QUrl& url,
        const QList<QPair<QByteArray, QByteArray>>& headers,
        const QString& mimeType) override {
        Q_UNUSED(url);
        Q_UNUSED(headers);
        Q_UNUSED(mimeType);
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void playStreamDevice(std::unique_ptr<QIODevice> device, const QString& mimeType) override {
        Q_UNUSED(device);
        Q_UNUSED(mimeType);
        ++streamDevicePlayCalls;
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void pause() override {
        ++pauseCalls;
        emitState(QStringLiteral("paused"), std::nullopt, std::nullopt);
    }

    void resume() override {
        ++resumeCalls;
        emitState(QStringLiteral("playing"), std::nullopt, std::nullopt);
    }

    void stop() override {
        ++stopCalls;
        emitState(QStringLiteral("stopped"), 0, std::nullopt);
    }

    void seek(qint64 positionMs) override {
        ++seekCalls;
        lastSeekMs = positionMs;
        emitState(QStringLiteral("playing"), positionMs, std::nullopt);
    }

    void setStateChangedCallback(StateChangedCallback callback) override {
        stateChangedCallback = std::move(callback);
    }

    void setErrorCallback(ErrorCallback callback) override {
        errorCallback = std::move(callback);
    }

    int playCalls = 0;
    int remotePlayCalls = 0;
    int streamDevicePlayCalls = 0;
    int pauseCalls = 0;
    int resumeCalls = 0;
    int stopCalls = 0;
    int seekCalls = 0;
    qint64 lastSeekMs = -1;
    QString lastPath;
    QUrl lastRemoteUrl;
    StateChangedCallback stateChangedCallback;
    ErrorCallback errorCallback;

private:
    void emitState(const QString& state, std::optional<qint64> positionMs, std::optional<qint64> durationMs) {
        if (stateChangedCallback) {
            stateChangedCallback(PlaybackBackendState{
                .state = state,
                .positionMs = positionMs,
                .durationMs = durationMs,
            });
        }
    }
};

struct QueuedController {
    std::unique_ptr<CoreController> controller;
    std::unique_ptr<QTemporaryDir> library;
    FakePlaybackBackend* backend = nullptr;
    int trackCount = 0;
    int queueCount = 0;
    QString firstQueueItemId;
    QString secondQueueItemId;
};

QueuedController createQueuedController() {
    auto library = std::make_unique<QTemporaryDir>();
    Q_ASSERT(library->isValid());
    QDir dir(library->path());
    const bool wroteAlpha = writeTestFile(dir.filePath(QStringLiteral("alpha.mp3")));
    const bool wroteBeta = writeTestFile(dir.filePath(QStringLiteral("beta.flac")));
    Q_ASSERT(wroteAlpha);
    Q_ASSERT(wroteBeta);

    auto backend = std::make_unique<FakePlaybackBackend>();
    auto* backendPtr = backend.get();
    auto controller = std::make_unique<CoreController>(std::move(backend));

    auto* tracks = qobject_cast<QAbstractItemModel*>(controller->property("tracksModel").value<QObject*>());
    auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
    Q_ASSERT(tracks != nullptr);
    Q_ASSERT(queue != nullptr);

    const bool imported = QMetaObject::invokeMethod(
        controller.get(),
        "importLocalFolder",
        Q_ARG(QUrl, QUrl::fromLocalFile(library->path())));
    Q_ASSERT(imported);
    Q_ASSERT(tracks->rowCount() == 2);

    const int trackIdRole = roleForName(tracks, "id");
    const int queueIdRole = roleForName(queue, "id");
    Q_ASSERT(trackIdRole > 0);
    Q_ASSERT(queueIdRole > 0);

    for (int row = 0; row < tracks->rowCount(); ++row) {
        const QString trackId = tracks->data(tracks->index(row, 0), trackIdRole).toString();
        const bool queued = QMetaObject::invokeMethod(
            controller.get(),
            "addTrackToQueue",
            Q_ARG(QString, trackId));
        Q_ASSERT(queued);
    }
    Q_ASSERT(queue->rowCount() == 2);

    return QueuedController{
        .controller = std::move(controller),
        .library = std::move(library),
        .backend = backendPtr,
        .trackCount = tracks->rowCount(),
        .queueCount = queue->rowCount(),
        .firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString(),
        .secondQueueItemId = queue->data(queue->index(1, 0), queueIdRole).toString(),
    };
}

} // namespace

class DesktopPlatformControllerTest final : public QObject {
    Q_OBJECT

private slots:
    void init() {
        QDir appData(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation));
        if (appData.exists()) {
            QVERIFY(appData.removeRecursively());
        }
        QSettings settings;
        settings.clear();
        settings.sync();
        QCOMPARE(settings.status(), QSettings::NoError);
    }

    void actionsDrivePlaybackAndExposeState() {
        QueuedController queued = createQueuedController();
        DesktopPlatformController platform(*queued.controller);

        QCOMPARE(queued.trackCount, 2);
        QCOMPARE(queued.queueCount, 2);
        QVERIFY(!queued.firstQueueItemId.isEmpty());
        QVERIFY(!queued.secondQueueItemId.isEmpty());
        QVERIFY(platform.playPauseAction()->isEnabled());
        QCOMPARE(platform.playPauseAction()->text(), QStringLiteral("Play"));
        QCOMPARE(platform.nextAction()->text(), QStringLiteral("Next"));
        QCOMPARE(platform.previousAction()->text(), QStringLiteral("Previous"));
        QCOMPARE(platform.stopAction()->text(), QStringLiteral("Stop"));

        platform.playPauseAction()->trigger();
        QCOMPARE(queued.backend->playCalls, 1);
        QVERIFY(queued.backend->lastPath.endsWith(QStringLiteral("alpha.mp3")));
        QCOMPARE(platform.playPauseAction()->text(), QStringLiteral("Pause"));
        QCOMPARE(platform.lastNotificationTitle(), QStringLiteral("alpha"));
        QCOMPARE(platform.lastNotificationMessage(), QStringLiteral("playing"));

        platform.nextAction()->trigger();
        QCOMPARE(queued.backend->playCalls, 2);
        QVERIFY(queued.backend->lastPath.endsWith(QStringLiteral("beta.flac")));

        platform.previousAction()->trigger();
        QCOMPARE(queued.backend->playCalls, 3);
        QVERIFY(queued.backend->lastPath.endsWith(QStringLiteral("alpha.mp3")));

        platform.playPauseAction()->trigger();
        QCOMPARE(queued.backend->pauseCalls, 1);
        QCOMPARE(platform.playPauseAction()->text(), QStringLiteral("Play"));

        platform.playPauseAction()->trigger();
        QCOMPARE(queued.backend->resumeCalls, 1);
        QCOMPARE(platform.playPauseAction()->text(), QStringLiteral("Pause"));

        platform.stopAction()->trigger();
        QCOMPARE(queued.backend->stopCalls, 1);
        QCOMPARE(platform.playPauseAction()->text(), QStringLiteral("Play"));
    }

    void boundWindowRestoresStateAndHandlesMediaKeys() {
        QueuedController queued = createQueuedController();
        DesktopPlatformController platform(*queued.controller);

        QCOMPARE(queued.trackCount, 2);
        QCOMPARE(queued.queueCount, 2);
        QVERIFY(!queued.firstQueueItemId.isEmpty());
        QVERIFY(platform.playPauseAction()->isEnabled());

        {
            QWindow firstWindow;
            firstWindow.setGeometry(64, 80, 900, 640);
            platform.bindWindow(&firstWindow);
            platform.saveWindowState();
        }

        QWindow restoredWindow;
        platform.bindWindow(&restoredWindow);
        QCOMPARE(restoredWindow.width(), 900);
        QCOMPARE(restoredWindow.height(), 640);

        platform.playPauseAction()->trigger();
        QCOMPARE(queued.backend->playCalls, 1);

        QKeyEvent nextEvent(QEvent::KeyPress, Qt::Key_MediaNext, Qt::NoModifier);
        QApplication::sendEvent(&restoredWindow, &nextEvent);
        QCOMPARE(queued.backend->playCalls, 2);
        QVERIFY(queued.backend->lastPath.endsWith(QStringLiteral("beta.flac")));

        QKeyEvent pauseEvent(QEvent::KeyPress, Qt::Key_MediaTogglePlayPause, Qt::NoModifier);
        QApplication::sendEvent(&restoredWindow, &pauseEvent);
        QCOMPARE(queued.backend->pauseCalls, 1);
    }
};

int main(int argc, char** argv) {
    qputenv("QT_QPA_PLATFORM", "offscreen");

    auqw::tests::TestStorage storage(QStringLiteral("AuqwDesktopPlatformControllerTest"));
    if (!storage.isValid()) {
        return 1;
    }

    QApplication app(argc, argv);
    storage.applyApplicationMetadata();

    DesktopPlatformControllerTest test;
    return QTest::qExec(&test, argc, argv);
}

#include "desktop_platform_controller_test.moc"
