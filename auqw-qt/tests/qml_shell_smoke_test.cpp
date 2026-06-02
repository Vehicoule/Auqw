#include "../src/CoreController.hpp"
#include "../src/PlaybackBackend.hpp"
#include "test_storage.hpp"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QAbstractItemModel>
#include <QMetaObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickItem>
#include <QSignalSpy>
#include <QStandardPaths>
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

QString readMainQml() {
    QFile file(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml"));
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return {};
    }
    return QString::fromUtf8(file.readAll());
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

class FakeOnlineProvider final : public OnlineProvider {
public:
    QString name() const override {
        return QStringLiteral("fake");
    }

    OnlineProviderCapabilities capabilities() const override {
        return OnlineProviderCapabilities{
            .search = true,
            .suggestions = true,
            .metadata = true,
            .playback = true,
            .downloads = true,
        };
    }

    void searchTracks(const QString& query) override {
        ++searchCalls;
        lastSearchQuery = query;
        emit searchSucceeded(query, nextResults);
    }

    void suggestTracks(const QString& query) override {
        ++suggestCalls;
        lastSuggestQuery = query;
        emit suggestionsSucceeded(query, nextSuggestions);
    }

    void fetchTrackMetadata(const QString&, const QString&) override {}
    void resolveStream(const QString&, const QString&) override {}

    int searchCalls = 0;
    int suggestCalls = 0;
    QString lastSearchQuery;
    QString lastSuggestQuery;
    QVector<OnlineTrackResult> nextResults;
    QVector<OnlineSuggestionResult> nextSuggestions;
};

} // namespace

class QmlShellSmokeTest final : public QObject {
    Q_OBJECT

private slots:
    void init() {
        QDir appData(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation));
        if (appData.exists()) {
            QVERIFY(appData.removeRecursively());
        }
    }

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
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchSubmitIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchStatusLabel")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchSuggestionsList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchResultsList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("floatingNavHomeIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("floatingNavLibraryIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("floatingNavSettingsIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerArtworkImage")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerArtworkFallback")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPreviousButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPreviousIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayPauseButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayPauseIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniNextButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniNextIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniStopButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniStopIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniRepeatButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniRepeatIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniShuffleButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniShuffleIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerTitle")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerState")) != nullptr);

        QObject* currentSongBox = root->findChild<QObject*>(QStringLiteral("currentSongBox"));
        QVERIFY(currentSongBox != nullptr);
        QTRY_VERIFY(currentSongBox->property("visible").toBool());
        QObject* nowPlayingSheet = root->findChild<QObject*>(QStringLiteral("nowPlayingSheet"));
        QVERIFY(nowPlayingSheet != nullptr);
        QVERIFY(!nowPlayingSheet->property("visible").toBool());
        QVERIFY(QMetaObject::invokeMethod(currentSongBox, "clicked"));
        QTRY_VERIFY(nowPlayingSheet->property("visible").toBool());
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingFavoriteButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingDownloadButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingQueueButton")) != nullptr);

        QObject* libraryTrackDelegate = nullptr;
        QTRY_VERIFY((libraryTrackDelegate = findObjectByName(root, QStringLiteral("libraryTrackDelegate"))) != nullptr);
        QVERIFY(libraryTrackDelegate->property("enabled").toBool());
        QVERIFY(findObjectByName(root, QStringLiteral("libraryTrackDownloadButton")) != nullptr);

        QObject* queueTrackDelegate = nullptr;
        QTRY_VERIFY((queueTrackDelegate = findObjectByName(root, QStringLiteral("queueTrackDelegate"))) != nullptr);
        QVERIFY(queueTrackDelegate->property("enabled").toBool());
    }

    void currentSongBoxStaysHiddenUntilPlaybackStarts() {
        CoreController controller(std::make_unique<FakePlaybackBackend>());

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        QObject* currentSongBox = root->findChild<QObject*>(QStringLiteral("currentSongBox"));
        QObject* nowPlayingSheet = root->findChild<QObject*>(QStringLiteral("nowPlayingSheet"));
        QVERIFY(currentSongBox != nullptr);
        QVERIFY(nowPlayingSheet != nullptr);
        QVERIFY(!currentSongBox->property("visible").toBool());
        QVERIFY(!nowPlayingSheet->property("visible").toBool());
    }

    void globalSearchButtonSubmitsAndShowsResults() {
        auto provider = std::make_unique<FakeOnlineProvider>();
        auto* providerPtr = provider.get();
        provider->nextResults = {
            OnlineTrackResult{
                .resultId = QStringLiteral("fake:around"),
                .provider = QStringLiteral("fake"),
                .providerTrackId = QStringLiteral("around"),
                .title = QStringLiteral("Around the World"),
                .artist = QStringLiteral("Daft Punk"),
                .album = QStringLiteral("Homework"),
                .durationMs = 430000,
                .artworkUrl = QStringLiteral("https://img.example/around.jpg"),
            },
        };

        CoreController controller(
            std::make_unique<FakePlaybackBackend>(),
            std::move(provider));

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        QObject* globalSearchField = root->findChild<QObject*>(QStringLiteral("globalSearchField"));
        QObject* globalSearchButton = root->findChild<QObject*>(QStringLiteral("globalSearchButton"));
        QVERIFY(globalSearchField != nullptr);
        QVERIFY(globalSearchButton != nullptr);

        globalSearchField->setProperty("text", QStringLiteral("  around the world  "));
        QVERIFY(QMetaObject::invokeMethod(globalSearchButton, "clicked"));

        QCOMPARE(providerPtr->searchCalls, 1);
        QCOMPARE(providerPtr->lastSearchQuery, QStringLiteral("around the world"));
        QCOMPARE(root->property("currentPageIndex").toInt(), 2);
        QCOMPARE(root->property("searchPageQuery").toString(), QStringLiteral("around the world"));
        QCOMPARE(globalSearchField->property("text").toString(), QString());
        QCOMPARE(controller.property("searchStatus").toString(), QStringLiteral("Ready"));

        auto* searchResults = qobject_cast<QAbstractItemModel*>(controller.property("searchResultsModel").value<QObject*>());
        QVERIFY(searchResults != nullptr);
        QCOMPARE(searchResults->rowCount(), 1);
        const int titleRole = roleForName(searchResults, "title");
        QVERIFY(titleRole > 0);
        QCOMPARE(searchResults->data(searchResults->index(0, 0), titleRole).toString(), QStringLiteral("Around the World"));
    }

    void compactNowPlayingSheetHasRoomForControls() {
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
        const QString trackId = tracks->data(tracks->index(0, 0), roleForName(tracks, "id")).toString();
        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "addTrackToQueue",
            Q_ARG(QString, trackId)));
        QVERIFY(QMetaObject::invokeMethod(&controller, "playFirstQueuedTrack"));

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        root->setProperty("width", 390);
        root->setProperty("height", 844);
        QCoreApplication::processEvents();

        QObject* currentSongBox = root->findChild<QObject*>(QStringLiteral("currentSongBox"));
        QObject* nowPlayingSheet = root->findChild<QObject*>(QStringLiteral("nowPlayingSheet"));
        QVERIFY(currentSongBox != nullptr);
        QVERIFY(nowPlayingSheet != nullptr);
        QTRY_VERIFY(currentSongBox->property("visible").toBool());
        QVERIFY(QMetaObject::invokeMethod(currentSongBox, "clicked"));
        QTRY_VERIFY(nowPlayingSheet->property("visible").toBool());
        QVERIFY2(
            nowPlayingSheet->property("height").toReal() >= 640.0,
            qPrintable(QStringLiteral("compact Now Playing popup too short: %1").arg(nowPlayingSheet->property("height").toReal())));

        auto* previousButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniPreviousButton")));
        auto* shuffleButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniShuffleButton")));
        QVERIFY(previousButton != nullptr);
        QVERIFY(shuffleButton != nullptr);
        QQuickItem* controlsRow = previousButton->parentItem();
        QVERIFY(controlsRow != nullptr);
        QCOMPARE(shuffleButton->parentItem(), controlsRow);
        const qreal availableWidth = nowPlayingSheet->property("width").toReal() - (2.0 * root->property("pagePadding").toReal());
        QVERIFY2(
            controlsRow->width() <= availableWidth + 0.5,
            qPrintable(QStringLiteral("compact Now Playing controls too wide: %1 > %2").arg(controlsRow->width()).arg(availableWidth)));
        const qreal shuffleRightEdge = shuffleButton->mapToItem(controlsRow, QPointF(shuffleButton->width(), 0)).x();
        QVERIFY2(
            shuffleRightEdge <= controlsRow->width() + 0.5,
            qPrintable(QStringLiteral("compact Now Playing controls overflow row: %1 > %2").arg(shuffleRightEdge).arg(controlsRow->width())));

        auto* previousIcon = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniPreviousIcon")));
        QVERIFY(previousIcon != nullptr);
        QVERIFY2(
            previousIcon->width() >= 20.0,
            qPrintable(QStringLiteral("compact Now Playing control icon too small: %1").arg(previousIcon->width())));
    }

    void mainQmlUsesDrawnIconsAndSearchTapStartsPlayback() {
        const QString qml = readMainQml();
        QVERIFY(!qml.isEmpty());

        QVERIFY2(qml.contains(QStringLiteral("playSearchResult(")), "search results should start playback directly");
        QVERIFY2(!qml.contains(QStringLiteral("favoriteSearchResult(")), "search row favorite action belongs in Now Playing");
        QVERIFY2(!qml.contains(QStringLiteral("downloadSearchResult(")), "search row download action belongs in Now Playing");
        QVERIFY2(!qml.contains(QStringLiteral("searchResultDownloadButton")), "search rows should not expose a download mini-button");
        const qsizetype iconButtonStart = qml.indexOf(QStringLiteral("component IconButton: Button"));
        QVERIFY2(iconButtonStart >= 0, "IconButton component should own icon-only button behavior");
        const qsizetype nextComponentStart = qml.indexOf(QStringLiteral("component "), iconButtonStart + 1);
        const QString iconButtonBody = qml.mid(iconButtonStart, nextComponentStart - iconButtonStart);
        QVERIFY2(iconButtonBody.contains(QStringLiteral("padding: 0")), "icon-only buttons should not let platform padding clip drawn icons");
        QVERIFY2(iconButtonBody.contains(QStringLiteral("implicitWidth: iconButton.implicitWidth")), "icon content item should report explicit width");
        QVERIFY2(iconButtonBody.contains(QStringLiteral("implicitHeight: iconButton.implicitHeight")), "icon content item should report explicit height");
        QVERIFY2(iconButtonBody.contains(QStringLiteral("Math.min(iconButton.width, iconButton.height, 24)")), "drawn icon size should be based on the button, not a clipped content item");

        const QStringList unsafePrimaryGlyphs = {
            QStringLiteral("glyph: \""),
            QStringLiteral("text: \"⌂\""),
            QStringLiteral("text: \"▤\""),
            QStringLiteral("text: \"☷\""),
            QStringLiteral("text: \"⌕\""),
            QStringLiteral("text: \"♡\""),
            QStringLiteral("text: \"⇩\""),
            QStringLiteral("text: \"↑\""),
            QStringLiteral("text: \"↓\""),
            QStringLiteral("text: \"×\""),
            QStringLiteral("text: \"⏮\""),
            QStringLiteral("text: \"⏸\""),
            QStringLiteral("text: \"▶\""),
            QStringLiteral("text: \"⏭\""),
            QStringLiteral("text: \"■\""),
            QStringLiteral("text: \"↻\""),
            QStringLiteral("text: \"⇄\""),
        };
        for (const QString& glyph : unsafePrimaryGlyphs) {
            QVERIFY2(!qml.contains(glyph), qPrintable(QStringLiteral("unsafe primary glyph remains: %1").arg(glyph)));
        }
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
