#include "../src/CoreController.hpp"
#include "../src/PlaybackBackend.hpp"
#include "test_storage.hpp"

#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QAbstractItemModel>
#include <QMetaObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickItem>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>
#include <QUrl>

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

QObject* findObjectByName(QObject* root, const QString& name) {
    if (root == nullptr) {
        return nullptr;
    }
    if (root->objectName() == name) {
        return root;
    }
    for (QObject* child : root->children()) {
        if (QObject* match = findObjectByName(child, name)) {
            return match;
        }
    }
    if (auto* item = qobject_cast<QQuickItem*>(root)) {
        for (QQuickItem* child : item->childItems()) {
            if (QObject* match = findObjectByName(child, name)) {
                return match;
            }
        }
    }
    return nullptr;
}

class FakePlaybackBackend final : public PlaybackBackend {
public:
    void playLocalFile(const QString& path) override {
        lastPath = path;
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void playRemoteUrl(const QUrl& url) override {
        lastRemoteUrl = url;
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void playHeaderedRemoteUrl(
        const QUrl& url,
        const QList<QPair<QByteArray, QByteArray>>&,
        const QString&) override {
        lastRemoteUrl = url;
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void playStreamDevice(std::unique_ptr<QIODevice>, const QString&) override {
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void pause() override {
        emitState(QStringLiteral("paused"), std::nullopt, std::nullopt);
    }

    void resume() override {
        emitState(QStringLiteral("playing"), std::nullopt, std::nullopt);
    }

    void stop() override {
        emitState(QStringLiteral("stopped"), 0, std::nullopt);
    }

    void seek(qint64 positionMs) override {
        emitState(QStringLiteral("playing"), positionMs, std::nullopt);
    }

    void setStateChangedCallback(StateChangedCallback callback) override {
        stateChangedCallback = std::move(callback);
    }

    void setErrorCallback(ErrorCallback callback) override {
        errorCallback = std::move(callback);
    }

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

} // namespace

class QmlShellSmokeTest final : public QObject {
    Q_OBJECT

private slots:
    void loadsMainShell() {
        QTemporaryDir library;
        QVERIFY(library.isValid());
        QVERIFY(writeTestFile(QDir(library.path()).filePath(QStringLiteral("alpha.mp3"))));

        CoreController controller(std::make_unique<FakePlaybackBackend>());
        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QCOMPARE(tracks->rowCount(), 1);
        const int trackIdRole = roleForName(tracks, "id");
        QVERIFY(trackIdRole > 0);
        const QString trackId = tracks->data(tracks->index(0, 0), trackIdRole).toString();
        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "addTrackToQueue",
            Q_ARG(QString, trackId)));
        QVERIFY(QMetaObject::invokeMethod(&controller, "playFirstQueuedTrack"));
        QCOMPARE(controller.property("playbackState").toString(), QStringLiteral("playing"));

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        QCOMPARE(root->objectName(), QStringLiteral("auqwShellWindow"));
        QVERIFY(root->findChild<QObject*>(QStringLiteral("mainStack")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("homePage")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("recommendationsList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("keepListeningList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("favoritesList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("floatingNavigation")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("floatingNavHomeButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("floatingNavLibraryButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("floatingNavSettingsButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("globalSearchField")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("desktopNavigationRail")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("queuePanel")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("queueList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("queueClearButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("downloadsPage")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("downloadsList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("downloadStatusLabel")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("downloadRemoveSelectedButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("libraryTabs")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("libraryDownloadsTab")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("settingsAppearancePlaybackGroup")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("onlineSourceSettingsGroup")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("listeningDataSettingsGroup")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("aboutSettingsGroup")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("storageSettingsGroup")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("downloadDirectoryField")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("downloadDirectorySaveButton")) != nullptr);
        QVERIFY(findObjectByName(root, QStringLiteral("queueMoveUpButton")) != nullptr);
        QVERIFY(findObjectByName(root, QStringLiteral("queueMoveDownButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("importFolderButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("importStatusLabel")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchField")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchStatusLabel")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchSuggestionsList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchResultsList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerArtworkImage")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerArtworkFallback")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPreviousButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayPauseButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniNextButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniStopButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniRepeatButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniShuffleButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerTitle")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerState")) != nullptr);

        QObject* currentSongBox = root->findChild<QObject*>(QStringLiteral("currentSongBox"));
        QVERIFY(currentSongBox != nullptr);
        QTRY_VERIFY(currentSongBox->property("visible").toBool());
        QObject* nowPlayingSheet = root->findChild<QObject*>(QStringLiteral("nowPlayingSheet"));
        QVERIFY(nowPlayingSheet != nullptr);
        QVERIFY(!nowPlayingSheet->property("visible").toBool());
        QVERIFY(QMetaObject::invokeMethod(currentSongBox, "click"));
        QTRY_VERIFY(nowPlayingSheet->property("visible").toBool());

        QObject* libraryTrackDelegate = nullptr;
        QTRY_VERIFY((libraryTrackDelegate = findObjectByName(root, QStringLiteral("libraryTrackDelegate"))) != nullptr);
        QVERIFY(libraryTrackDelegate->property("enabled").toBool());
        QVERIFY(findObjectByName(root, QStringLiteral("libraryTrackDownloadButton")) != nullptr);

        QObject* queueTrackDelegate = nullptr;
        QTRY_VERIFY((queueTrackDelegate = findObjectByName(root, QStringLiteral("queueTrackDelegate"))) != nullptr);
        QVERIFY(queueTrackDelegate->property("enabled").toBool());
    }
};

int main(int argc, char** argv) {
    qputenv("QT_QPA_PLATFORM", "offscreen");

    auqw::tests::TestStorage storage(QStringLiteral("AuqwQmlShellSmokeTest"));
    if (!storage.isValid()) {
        return 1;
    }

    QGuiApplication app(argc, argv);
    storage.applyApplicationMetadata();

    QmlShellSmokeTest test;
    return QTest::qExec(&test, argc, argv);
}

#include "qml_shell_smoke_test.moc"
