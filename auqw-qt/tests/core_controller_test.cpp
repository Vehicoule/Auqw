#include "../src/CoreController.hpp"
#include "../src/PlaybackBackend.hpp"

#include <QAbstractItemModel>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaObject>
#include <QObject>
#include <QSignalSpy>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTest>
#include <QUrl>

#include <auqw/CoreBridge.hpp>

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

    void emitBackendState(const QString& state, std::optional<qint64> positionMs, std::optional<qint64> durationMs) {
        emitState(state, positionMs, durationMs);
    }

    void setStateChangedCallback(StateChangedCallback callback) override {
        stateChangedCallback = std::move(callback);
    }

    void setErrorCallback(ErrorCallback callback) override {
        errorCallback = std::move(callback);
    }

    int playCalls = 0;
    int pauseCalls = 0;
    int resumeCalls = 0;
    int stopCalls = 0;
    int seekCalls = 0;
    qint64 lastSeekMs = -1;
    QString lastPath;
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

int recentCountForTrack(const QString& databasePath, const QString& trackId) {
    auqw::InitOptions options;
    options.dataDir = QFileInfo(databasePath).absolutePath().toStdString();
    auqw::CoreBridge core(options);
    const std::string response = core.invokeJson(R"({"id":"recent","command":"recent.list","params":{}})");
    const QJsonObject root = QJsonDocument::fromJson(QByteArray::fromStdString(response)).object();
    const QJsonArray items = root.value(QStringLiteral("data")).toObject().value(QStringLiteral("items")).toArray();

    int count = 0;
    for (const QJsonValue& item : items) {
        if (item.toObject().value(QStringLiteral("track_id")).toString() == trackId) {
            ++count;
        }
    }
    return count;
}

} // namespace

class CoreControllerTest final : public QObject {
    Q_OBJECT

private slots:
    void init() {
        QDir appData(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation));
        if (appData.exists()) {
            QVERIFY(appData.removeRecursively());
        }
    }

    void exposesCoreMetadataAndEmptyModels() {
        CoreController controller;

        QCOMPARE(controller.property("appName").toString(), QStringLiteral("Auqw"));
        QCOMPARE(controller.property("appId").toString(), QStringLiteral("com.Vehicoule.auqw"));
        QVERIFY(controller.property("databasePath").toString().endsWith(QStringLiteral("auqw.sqlite3")));
        QCOMPARE(controller.property("schemaVersion").toInt(), 3);
        QCOMPARE(controller.property("coreStatus").toString(), QStringLiteral("Ready"));
        QCOMPARE(controller.property("helloText").toString(), QStringLiteral("Hello from Auqw Core"));

        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* playlists = qobject_cast<QAbstractItemModel*>(controller.property("playlistsModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(playlists != nullptr);
        QVERIFY(queue != nullptr);
        QCOMPARE(tracks->rowCount(), 0);
        QCOMPARE(playlists->rowCount(), 0);
        QCOMPARE(queue->rowCount(), 0);
    }

    void themeSettingRoundTripsThroughCore() {
        CoreController controller;
        QSignalSpy spy(&controller, SIGNAL(themeSettingChanged()));

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "setThemeSetting",
            Q_ARG(QString, QStringLiteral("dark"))));

        QCOMPARE(controller.property("themeSetting").toString(), QStringLiteral("dark"));
        QCOMPARE(spy.count(), 1);
        QCOMPARE(controller.property("coreStatus").toString(), QStringLiteral("Ready"));
    }

    void importsLocalFolderIntoLibraryModel() {
        QTemporaryDir library;
        QVERIFY(library.isValid());

        QDir dir(library.path());
        QVERIFY(dir.mkpath(QStringLiteral("nested")));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("alpha.mp3"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("nested/beta.flac"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("ignore.txt"))));

        CoreController controller;
        QSignalSpy statusSpy(&controller, SIGNAL(importStatusChanged()));
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        QVERIFY(tracks != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));

        QCOMPARE(tracks->rowCount(), 2);
        QCOMPARE(controller.property("importedTrackCount").toInt(), 2);
        QCOMPARE(controller.property("importStatus").toString(), QStringLiteral("Imported 2 tracks"));
        QVERIFY(statusSpy.count() >= 1);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));

        QCOMPARE(tracks->rowCount(), 2);
        QCOMPARE(controller.property("importedTrackCount").toInt(), 2);
        QCOMPARE(controller.property("importStatus").toString(), QStringLiteral("Imported 2 tracks"));
    }

    void queuesImportedTracksThroughCore() {
        QTemporaryDir library;
        QVERIFY(library.isValid());

        QDir dir(library.path());
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("alpha.mp3"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("beta.flac"))));

        CoreController controller;
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));

        QCOMPARE(tracks->rowCount(), 2);
        QCOMPARE(queue->rowCount(), 0);

        const int trackIdRole = roleForName(tracks, "id");
        QVERIFY(trackIdRole > 0);
        const QString firstTrackId = tracks->data(tracks->index(0, 0), trackIdRole).toString();
        const QString secondTrackId = tracks->data(tracks->index(1, 0), trackIdRole).toString();
        QVERIFY(!firstTrackId.isEmpty());
        QVERIFY(!secondTrackId.isEmpty());

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "addTrackToQueue",
            Q_ARG(QString, firstTrackId)));
        QCOMPARE(queue->rowCount(), 1);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "addTrackToQueue",
            Q_ARG(QString, secondTrackId)));
        QCOMPARE(queue->rowCount(), 2);

        const int queueIdRole = roleForName(queue, "id");
        const int queueTitleRole = roleForName(queue, "title");
        const int queueLocalPathRole = roleForName(queue, "local_path");
        QVERIFY(queueIdRole > 0);
        QVERIFY(queueTitleRole > 0);
        QVERIFY(queueLocalPathRole > 0);

        const QString firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        const QString secondQueueItemId = queue->data(queue->index(1, 0), queueIdRole).toString();
        QVERIFY(!firstQueueItemId.isEmpty());
        QVERIFY(!secondQueueItemId.isEmpty());
        QCOMPARE(queue->data(queue->index(0, 0), queueTitleRole).toString(), QStringLiteral("alpha"));
        QVERIFY(queue->data(queue->index(0, 0), queueLocalPathRole).toString().endsWith(QStringLiteral("alpha.mp3")));

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "moveQueueItem",
            Q_ARG(QString, secondQueueItemId),
            Q_ARG(int, 0)));
        QCOMPARE(queue->data(queue->index(0, 0), queueIdRole).toString(), secondQueueItemId);
        QCOMPARE(queue->data(queue->index(0, 0), queueTitleRole).toString(), QStringLiteral("beta"));

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "removeQueueItem",
            Q_ARG(QString, firstQueueItemId)));
        QCOMPARE(queue->rowCount(), 1);
        QCOMPARE(queue->data(queue->index(0, 0), queueTitleRole).toString(), QStringLiteral("beta"));

        QVERIFY(QMetaObject::invokeMethod(&controller, "clearQueue"));
        QCOMPARE(queue->rowCount(), 0);
    }

    void playsQueuedLocalTrackThroughInjectedBackend() {
        QTemporaryDir library;
        QVERIFY(library.isValid());

        QDir dir(library.path());
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("alpha.mp3"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("beta.flac"))));

        auto backend = std::make_unique<FakePlaybackBackend>();
        auto* fakeBackend = backend.get();
        CoreController controller(std::move(backend));
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));
        QCOMPARE(tracks->rowCount(), 2);

        const int trackIdRole = roleForName(tracks, "id");
        QVERIFY(trackIdRole > 0);
        const QString firstTrackId = tracks->data(tracks->index(0, 0), trackIdRole).toString();
        QVERIFY(!firstTrackId.isEmpty());

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "addTrackToQueue",
            Q_ARG(QString, firstTrackId)));
        QCOMPARE(queue->rowCount(), 1);

        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);
        const QString firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        QVERIFY(!firstQueueItemId.isEmpty());

        QSignalSpy playbackSpy(&controller, SIGNAL(playbackStateChanged()));
        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "playQueueItem",
            Q_ARG(QString, firstQueueItemId)));

        QCOMPARE(fakeBackend->playCalls, 1);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("alpha.mp3")));
        QCOMPARE(controller.property("playbackState").toString(), QStringLiteral("playing"));
        QCOMPARE(controller.property("playbackTitle").toString(), QStringLiteral("alpha"));
        QCOMPARE(controller.property("playbackQueueItemId").toString(), firstQueueItemId);
        QVERIFY(playbackSpy.count() >= 1);
        QCOMPARE(recentCountForTrack(controller.property("databasePath").toString(), firstTrackId), 1);

        QVERIFY(QMetaObject::invokeMethod(&controller, "pausePlayback"));
        QCOMPARE(fakeBackend->pauseCalls, 1);
        QCOMPARE(controller.property("playbackState").toString(), QStringLiteral("paused"));

        QVERIFY(QMetaObject::invokeMethod(&controller, "resumePlayback"));
        QCOMPARE(fakeBackend->resumeCalls, 1);
        QCOMPARE(controller.property("playbackState").toString(), QStringLiteral("playing"));
        QCOMPARE(recentCountForTrack(controller.property("databasePath").toString(), firstTrackId), 1);

        QVERIFY(QMetaObject::invokeMethod(&controller, "seekPlayback", Q_ARG(qint64, 1200)));
        QCOMPARE(fakeBackend->seekCalls, 1);
        QCOMPARE(fakeBackend->lastSeekMs, 1200);
        QCOMPARE(controller.property("playbackPositionMs").toLongLong(), 1200);

        QVERIFY(QMetaObject::invokeMethod(&controller, "stopPlayback"));
        QCOMPARE(fakeBackend->stopCalls, 1);
        QCOMPARE(controller.property("playbackState").toString(), QStringLiteral("stopped"));
    }

    void advancesToNextQueuedTrackWhenBackendStopsAtEnd() {
        QTemporaryDir library;
        QVERIFY(library.isValid());

        QDir dir(library.path());
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("alpha.mp3"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("beta.flac"))));

        auto backend = std::make_unique<FakePlaybackBackend>();
        auto* fakeBackend = backend.get();
        CoreController controller(std::move(backend));
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));
        QCOMPARE(tracks->rowCount(), 2);

        const int trackIdRole = roleForName(tracks, "id");
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(trackIdRole > 0);
        QVERIFY(queueIdRole > 0);

        for (int row = 0; row < tracks->rowCount(); ++row) {
            const QString trackId = tracks->data(tracks->index(row, 0), trackIdRole).toString();
            QVERIFY(QMetaObject::invokeMethod(
                &controller,
                "addTrackToQueue",
                Q_ARG(QString, trackId)));
        }
        QCOMPARE(queue->rowCount(), 2);

        const QString firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        const QString secondQueueItemId = queue->data(queue->index(1, 0), queueIdRole).toString();
        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "playQueueItem",
            Q_ARG(QString, firstQueueItemId)));
        QCOMPARE(fakeBackend->playCalls, 1);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("alpha.mp3")));

        fakeBackend->emitBackendState(QStringLiteral("stopped"), 2000, 2000);

        QCOMPARE(fakeBackend->playCalls, 2);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("beta.flac")));
        QCOMPARE(controller.property("playbackQueueItemId").toString(), secondQueueItemId);
        QCOMPARE(controller.property("playbackTitle").toString(), QStringLiteral("beta"));
        QCOMPARE(controller.property("playbackState").toString(), QStringLiteral("playing"));
    }

    void playbackNavigationAndOptionsRoundTrip() {
        QTemporaryDir library;
        QVERIFY(library.isValid());

        QDir dir(library.path());
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("alpha.mp3"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("beta.flac"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("gamma.wav"))));

        auto backend = std::make_unique<FakePlaybackBackend>();
        auto* fakeBackend = backend.get();
        CoreController controller(std::move(backend));
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));
        QCOMPARE(tracks->rowCount(), 3);

        const int trackIdRole = roleForName(tracks, "id");
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(trackIdRole > 0);
        QVERIFY(queueIdRole > 0);
        for (int row = 0; row < tracks->rowCount(); ++row) {
            const QString trackId = tracks->data(tracks->index(row, 0), trackIdRole).toString();
            QVERIFY(QMetaObject::invokeMethod(
                &controller,
                "addTrackToQueue",
                Q_ARG(QString, trackId)));
        }
        QCOMPARE(queue->rowCount(), 3);

        const QString firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        const QString secondQueueItemId = queue->data(queue->index(1, 0), queueIdRole).toString();
        const QString thirdQueueItemId = queue->data(queue->index(2, 0), queueIdRole).toString();

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "playQueueItem",
            Q_ARG(QString, secondQueueItemId)));
        QCOMPARE(fakeBackend->playCalls, 1);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("beta.flac")));

        QVERIFY(QMetaObject::invokeMethod(&controller, "playNextQueuedTrack"));
        QCOMPARE(fakeBackend->playCalls, 2);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("gamma.wav")));
        QCOMPARE(controller.property("playbackQueueItemId").toString(), thirdQueueItemId);

        QVERIFY(QMetaObject::invokeMethod(&controller, "playPreviousQueuedTrack"));
        QCOMPARE(fakeBackend->playCalls, 3);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("beta.flac")));
        QCOMPARE(controller.property("playbackQueueItemId").toString(), secondQueueItemId);

        QCOMPARE(controller.property("repeatMode").toString(), QStringLiteral("off"));
        QCOMPARE(controller.property("shuffleEnabled").toBool(), false);

        QVERIFY(QMetaObject::invokeMethod(&controller, "toggleRepeatMode"));
        QCOMPARE(controller.property("repeatMode").toString(), QStringLiteral("one"));
        QVERIFY(QMetaObject::invokeMethod(&controller, "playNextQueuedTrack"));
        QCOMPARE(fakeBackend->playCalls, 4);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("beta.flac")));
        QCOMPARE(controller.property("playbackQueueItemId").toString(), secondQueueItemId);

        QVERIFY(QMetaObject::invokeMethod(&controller, "toggleRepeatMode"));
        QCOMPARE(controller.property("repeatMode").toString(), QStringLiteral("all"));
        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "playQueueItem",
            Q_ARG(QString, thirdQueueItemId)));
        QCOMPARE(fakeBackend->playCalls, 5);
        QVERIFY(QMetaObject::invokeMethod(&controller, "playNextQueuedTrack"));
        QCOMPARE(fakeBackend->playCalls, 6);
        QVERIFY(fakeBackend->lastPath.endsWith(QStringLiteral("alpha.mp3")));
        QCOMPARE(controller.property("playbackQueueItemId").toString(), firstQueueItemId);

        QVERIFY(QMetaObject::invokeMethod(&controller, "toggleRepeatMode"));
        QCOMPARE(controller.property("repeatMode").toString(), QStringLiteral("off"));

        QVERIFY(QMetaObject::invokeMethod(&controller, "toggleShuffle"));
        QCOMPARE(controller.property("shuffleEnabled").toBool(), true);
        QVERIFY(QMetaObject::invokeMethod(&controller, "playNextQueuedTrack"));
        QCOMPARE(fakeBackend->playCalls, 7);
        QVERIFY(controller.property("playbackQueueItemId").toString() != firstQueueItemId);

        QVERIFY(QMetaObject::invokeMethod(&controller, "toggleShuffle"));
        QCOMPARE(controller.property("shuffleEnabled").toBool(), false);
    }
};

int main(int argc, char** argv) {
    QTemporaryDir dataHome;
    QTemporaryDir cacheHome;
    if (!dataHome.isValid() || !cacheHome.isValid()) {
        return 1;
    }

    qputenv("XDG_DATA_HOME", dataHome.path().toUtf8());
    qputenv("XDG_CACHE_HOME", cacheHome.path().toUtf8());
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("Auqw"));
    QCoreApplication::setOrganizationName(QStringLiteral("Vehicoule"));
    QCoreApplication::setOrganizationDomain(QStringLiteral("com.Vehicoule.auqw"));

    CoreControllerTest test;
    return QTest::qExec(&test, argc, argv);
}

#include "core_controller_test.moc"
