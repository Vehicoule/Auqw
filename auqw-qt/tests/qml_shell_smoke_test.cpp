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

QString readQmlFile(QStringView relativePath) {
    QFile file(QStringLiteral(AUQW_QML_SOURCE_DIR "/") + relativePath.toString());
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

QVariant roleValue(const QAbstractItemModel* model, int row, const QByteArray& name) {
    const int role = roleForName(model, name);
    if (role <= 0 || row < 0 || row >= model->rowCount()) {
        return {};
    }
    return model->data(model->index(row, 0), role);
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

bool effectivelyVisible(QObject* object) {
    auto* item = qobject_cast<QQuickItem*>(object);
    if (item == nullptr) {
        return object != nullptr && object->property("visible").toBool();
    }

    for (QQuickItem* current = item; current != nullptr; current = current->parentItem()) {
        if (!current->isVisible()) {
            return false;
        }
    }
    return item->width() > 0.0 && item->height() > 0.0;
}

QQuickItem* quickItemByName(QObject* root, const QString& name) {
    return qobject_cast<QQuickItem*>(findObjectByName(root, name));
}

QRectF sceneBounds(QQuickItem* item) {
    if (item == nullptr) {
        return {};
    }
    return QRectF(item->mapToScene(QPointF(0, 0)), QSizeF(item->width(), item->height()));
}

bool hasMeaningfulOverlap(QQuickItem* first, QQuickItem* second) {
    if (first == nullptr || second == nullptr || !effectivelyVisible(first) || !effectivelyVisible(second)) {
        return false;
    }
    const QRectF overlap = sceneBounds(first).intersected(sceneBounds(second));
    return overlap.width() > 1.0 && overlap.height() > 1.0;
}

int visibleSearchFieldCount(QObject* root) {
    int count = 0;
    const QStringList fieldNames = {
        QStringLiteral("searchField"),
    };
    for (const QString& fieldName : fieldNames) {
        QObject* field = root->findChild<QObject*>(fieldName);
        if (field != nullptr && effectivelyVisible(field)) {
            ++count;
        }
    }
    return count;
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
    void resolveStream(const QString& provider, const QString& providerTrackId) override {
        ++resolveCalls;
        lastResolveProvider = provider;
        lastResolveTrackId = providerTrackId;
    }

    int searchCalls = 0;
    int suggestCalls = 0;
    int resolveCalls = 0;
    QString lastSearchQuery;
    QString lastSuggestQuery;
    QString lastResolveProvider;
    QString lastResolveTrackId;
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
        QVERIFY(root->findChild<QObject*>(QStringLiteral("topRightSearchButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("searchOverlay")) != nullptr);
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
        QVERIFY(root->findChild<QObject*>(QStringLiteral("downloadDirectoryDisplay")) != nullptr);
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
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniRepeatButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniRepeatIcon")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniPlayerSwipeStopHandle")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingOverflowButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingOverflowMenu")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingDownloadMenuItem")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingQueueMenuItem")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingShuffleMenuItem")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("albumBackdrop")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("appThemeRoot")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniStopButton")) == nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("miniShuffleButton")) == nullptr);
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
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingDownloadButton")) == nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("nowPlayingQueueButton")) == nullptr);

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

    void topRightSearchButtonOpensSearchOverlay() {
        CoreController controller(std::make_unique<FakePlaybackBackend>());

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        root->setProperty("currentPageIndex", 0);
        QObject* topRightSearchButton = root->findChild<QObject*>(QStringLiteral("topRightSearchButton"));
        QVERIFY(topRightSearchButton != nullptr);
        QTRY_VERIFY(effectivelyVisible(topRightSearchButton));

        QVERIFY(QMetaObject::invokeMethod(topRightSearchButton, "clicked"));

        QTRY_VERIFY(root->property("searchOverlayOpen").toBool());
        QCOMPARE(root->property("currentPageIndex").toInt(), 0);
        QTRY_COMPARE(visibleSearchFieldCount(root), 1);
        QObject* searchField = root->findChild<QObject*>(QStringLiteral("searchField"));
        QVERIFY(searchField != nullptr);
        QTRY_VERIFY(effectivelyVisible(searchField));
    }

    void searchOverlayHasOneVisibleSearchFieldAndSettingsHasNone() {
        CoreController controller(std::make_unique<FakePlaybackBackend>());

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        root->setProperty("searchOverlayOpen", true);
        root->setProperty("currentPageIndex", 2);
        QCoreApplication::processEvents();
        QTRY_COMPARE(visibleSearchFieldCount(root), 1);

        root->setProperty("searchOverlayOpen", false);
        QCoreApplication::processEvents();
        QCOMPARE(visibleSearchFieldCount(root), 0);
    }

    void typingSearchPageUpdatesSuggestions() {
        auto provider = std::make_unique<FakeOnlineProvider>();
        auto* providerPtr = provider.get();
        provider->nextSuggestions = {
            OnlineSuggestionResult{.text = QStringLiteral("around the world")},
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

        auto* window = qobject_cast<QWindow*>(engine.rootObjects().first());
        QVERIFY(window != nullptr);
        QObject* root = window;
        root->setProperty("searchOverlayOpen", true);
        auto* searchField = qobject_cast<QQuickItem*>(root->findChild<QObject*>(QStringLiteral("searchField")));
        QVERIFY(searchField != nullptr);
        QTRY_VERIFY(effectivelyVisible(searchField));
        searchField->forceActiveFocus();
        QTRY_VERIFY(searchField->hasActiveFocus());

        for (const QChar ch : QStringLiteral("around")) {
            QTest::keyClick(window, ch.toLatin1());
        }

        QTRY_COMPARE(providerPtr->suggestCalls, 6);
        QCOMPARE(providerPtr->lastSuggestQuery, QStringLiteral("around"));
        QCOMPARE(root->property("searchPageQuery").toString(), QStringLiteral("around"));
        auto* suggestions = qobject_cast<QAbstractItemModel*>(controller.property("searchSuggestionsModel").value<QObject*>());
        QVERIFY(suggestions != nullptr);
        QTRY_COMPARE(suggestions->rowCount(), 1);
        const int textRole = roleForName(suggestions, "text");
        QVERIFY(textRole > 0);
        QCOMPARE(suggestions->data(suggestions->index(0, 0), textRole).toString(), QStringLiteral("around the world"));
        QObject* searchSuggestionsList = root->findChild<QObject*>(QStringLiteral("searchSuggestionsList"));
        QVERIFY(searchSuggestionsList != nullptr);
        QTRY_VERIFY(effectivelyVisible(searchSuggestionsList));
    }

    void searchOverlayButtonSubmitsAndShowsResults() {
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
        root->setProperty("searchOverlayOpen", true);
        QObject* searchField = root->findChild<QObject*>(QStringLiteral("searchField"));
        QObject* searchButton = root->findChild<QObject*>(QStringLiteral("searchButton"));
        QVERIFY(searchField != nullptr);
        QVERIFY(searchButton != nullptr);

        searchField->setProperty("text", QStringLiteral("  around the world  "));
        QVERIFY(QMetaObject::invokeMethod(searchButton, "clicked"));

        QCOMPARE(providerPtr->searchCalls, 1);
        QCOMPARE(providerPtr->lastSearchQuery, QStringLiteral("around the world"));
        QVERIFY(root->property("searchOverlayOpen").toBool());
        QCOMPARE(root->property("searchPageQuery").toString(), QStringLiteral("around the world"));
        QCOMPARE(controller.property("searchStatus").toString(), QStringLiteral("Ready"));
        QTRY_COMPARE(visibleSearchFieldCount(root), 1);

        auto* searchResults = qobject_cast<QAbstractItemModel*>(controller.property("searchResultsModel").value<QObject*>());
        QVERIFY(searchResults != nullptr);
        QCOMPARE(searchResults->rowCount(), 1);
        const int titleRole = roleForName(searchResults, "title");
        QVERIFY(titleRole > 0);
        QCOMPARE(searchResults->data(searchResults->index(0, 0), titleRole).toString(), QStringLiteral("Around the World"));
        QObject* searchResultsList = root->findChild<QObject*>(QStringLiteral("searchResultsList"));
        QVERIFY(searchResultsList != nullptr);
        QTRY_VERIFY(effectivelyVisible(searchResultsList));
    }

    void searchResultFullRowClickStartsPlaybackRequest() {
        auto provider = std::make_unique<FakeOnlineProvider>();
        auto* providerPtr = provider.get();
        provider->nextResults = {
            OnlineTrackResult{
                .resultId = QStringLiteral("fake:around"),
                .provider = QStringLiteral("fake"),
                .providerTrackId = QStringLiteral("around"),
                .title = QStringLiteral("Around the World"),
                .artist = QStringLiteral("Daft Punk"),
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
        root->setProperty("searchOverlayOpen", true);
        root->setProperty("searchPageQuery", QStringLiteral("around"));
        root->setProperty("submittedSearchQuery", QStringLiteral("around"));
        QVERIFY(QMetaObject::invokeMethod(&controller, "searchOnline", Q_ARG(QString, QStringLiteral("around"))));

        QObject* resultDelegate = nullptr;
        QTRY_VERIFY((resultDelegate = findObjectByName(root, QStringLiteral("searchResultDelegate"))) != nullptr);
        QVERIFY(QMetaObject::invokeMethod(resultDelegate, "clicked"));

        QCOMPARE(providerPtr->resolveCalls, 1);
        QCOMPARE(providerPtr->lastResolveProvider, QStringLiteral("fake"));
        QCOMPARE(providerPtr->lastResolveTrackId, QStringLiteral("around"));
        QCOMPARE(controller.property("playbackState").toString(), QStringLiteral("loading"));
    }

    void desktopShellReservesSearchNavQueueAndPlaybackSpace() {
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
        const QString trackId = roleValue(tracks, 0, "id").toString();
        QVERIFY(QMetaObject::invokeMethod(&controller, "addTrackToQueue", Q_ARG(QString, trackId)));
        QVERIFY(QMetaObject::invokeMethod(&controller, "playFirstQueuedTrack"));

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        root->setProperty("width", 1180);
        root->setProperty("height", 760);
        root->setProperty("currentPageIndex", 0);
        QCoreApplication::processEvents();

        auto* desktopNavigationRail = quickItemByName(root, QStringLiteral("desktopNavigationRail"));
        auto* topRightSearchButton = quickItemByName(root, QStringLiteral("topRightSearchButton"));
        auto* mainStack = quickItemByName(root, QStringLiteral("mainStack"));
        auto* queuePanel = quickItemByName(root, QStringLiteral("queuePanel"));
        auto* bottomPlaybackBar = quickItemByName(root, QStringLiteral("bottomPlaybackBar"));
        QVERIFY(desktopNavigationRail != nullptr);
        QVERIFY(topRightSearchButton != nullptr);
        QVERIFY(mainStack != nullptr);
        QVERIFY(queuePanel != nullptr);
        QVERIFY(bottomPlaybackBar != nullptr);
        QTRY_VERIFY(effectivelyVisible(desktopNavigationRail));
        QTRY_VERIFY(effectivelyVisible(topRightSearchButton));
        QTRY_VERIFY(effectivelyVisible(queuePanel));
        QTRY_VERIFY(effectivelyVisible(bottomPlaybackBar));

        QVERIFY2(!hasMeaningfulOverlap(desktopNavigationRail, mainStack), "desktop nav overlaps page content");
        QVERIFY2(!hasMeaningfulOverlap(topRightSearchButton, mainStack), "desktop search button overlaps page content");
        QVERIFY2(!hasMeaningfulOverlap(queuePanel, mainStack), "queue panel overlaps page content");
        QVERIFY2(!hasMeaningfulOverlap(bottomPlaybackBar, mainStack), "bottom playback bar overlaps page content");
        QVERIFY2(!hasMeaningfulOverlap(bottomPlaybackBar, queuePanel), "bottom playback bar overlaps queue panel");
    }

    void compactShellUsesPageOwnedSearchAndBottomBarsWithoutOverlap() {
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
        const QString trackId = roleValue(tracks, 0, "id").toString();
        QVERIFY(QMetaObject::invokeMethod(&controller, "addTrackToQueue", Q_ARG(QString, trackId)));
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
        root->setProperty("currentPageIndex", 0);
        QCoreApplication::processEvents();

        auto* topRightSearchButton = quickItemByName(root, QStringLiteral("topRightSearchButton"));
        auto* mainStack = quickItemByName(root, QStringLiteral("mainStack"));
        auto* floatingNavigation = quickItemByName(root, QStringLiteral("floatingNavigation"));
        auto* currentSongBox = quickItemByName(root, QStringLiteral("currentSongBox"));
        QVERIFY(topRightSearchButton != nullptr);
        QVERIFY(mainStack != nullptr);
        QVERIFY(floatingNavigation != nullptr);
        QVERIFY(currentSongBox != nullptr);
        QTRY_VERIFY(effectivelyVisible(topRightSearchButton));
        QTRY_VERIFY(effectivelyVisible(floatingNavigation));
        QTRY_VERIFY(effectivelyVisible(currentSongBox));

        QVERIFY2(!hasMeaningfulOverlap(topRightSearchButton, mainStack), "compact top search overlaps page content");
        QVERIFY2(!hasMeaningfulOverlap(floatingNavigation, mainStack), "compact nav overlaps page content");
        QVERIFY2(!hasMeaningfulOverlap(currentSongBox, mainStack), "compact mini-player overlaps page content");
        QVERIFY2(!hasMeaningfulOverlap(currentSongBox, floatingNavigation), "compact mini-player overlaps bottom nav");
    }

    void queuePanelHiddenWhileDesktopSearchOverlayIsOpen() {
        CoreController controller(std::make_unique<FakePlaybackBackend>());

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        root->setProperty("width", 1180);
        root->setProperty("height", 760);
        root->setProperty("currentPageIndex", 0);
        QCoreApplication::processEvents();

        QObject* queuePanel = root->findChild<QObject*>(QStringLiteral("queuePanel"));
        QObject* mainStack = root->findChild<QObject*>(QStringLiteral("mainStack"));
        QVERIFY(queuePanel != nullptr);
        QVERIFY(mainStack != nullptr);
        QTRY_VERIFY(effectivelyVisible(queuePanel));
        const qreal homeStackWidth = mainStack->property("width").toReal();
        QVERIFY(homeStackWidth < root->property("width").toReal());

        root->setProperty("searchOverlayOpen", true);
        QCoreApplication::processEvents();

        QVERIFY(!effectivelyVisible(queuePanel));
        QVERIFY(mainStack->property("width").toReal() > homeStackWidth + 100.0);
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

        auto* favoriteButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("nowPlayingFavoriteButton")));
        auto* repeatButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniRepeatButton")));
        auto* overflowButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("nowPlayingOverflowButton")));
        auto* stopButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniStopButton")));
        auto* shuffleButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniShuffleButton")));
        QVERIFY(favoriteButton != nullptr);
        QVERIFY(repeatButton != nullptr);
        QVERIFY(overflowButton != nullptr);
        QVERIFY(stopButton == nullptr);
        QVERIFY(shuffleButton == nullptr);

        auto* previousButton = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniPreviousButton")));
        QVERIFY(previousButton != nullptr);
        QQuickItem* controlsRow = favoriteButton->parentItem();
        QVERIFY(controlsRow != nullptr);
        QCOMPARE(repeatButton->parentItem(), controlsRow);
        const qreal availableWidth = nowPlayingSheet->property("width").toReal() - (2.0 * root->property("pagePadding").toReal());
        QVERIFY2(
            controlsRow->width() <= availableWidth + 0.5,
            qPrintable(QStringLiteral("compact Now Playing controls too wide: %1 > %2").arg(controlsRow->width()).arg(availableWidth)));
        const qreal repeatRightEdge = repeatButton->mapToItem(controlsRow, QPointF(repeatButton->width(), 0)).x();
        QVERIFY2(
            repeatRightEdge <= controlsRow->width() + 0.5,
            qPrintable(QStringLiteral("compact Now Playing controls overflow row: %1 > %2").arg(repeatRightEdge).arg(controlsRow->width())));

        auto* previousIcon = qobject_cast<QQuickItem*>(findObjectByName(root, QStringLiteral("miniPreviousIcon")));
        QVERIFY(previousIcon != nullptr);
        QVERIFY2(
            previousIcon->width() >= 20.0,
            qPrintable(QStringLiteral("compact Now Playing control icon too small: %1").arg(previousIcon->width())));
    }

    void miniPlayerSwipeStopStopsPlaybackAndClosesSheet() {
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
        const QString trackId = roleValue(tracks, 0, "id").toString();
        QVERIFY(QMetaObject::invokeMethod(&controller, "addTrackToQueue", Q_ARG(QString, trackId)));
        QVERIFY(QMetaObject::invokeMethod(&controller, "playFirstQueuedTrack"));

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        QObject* currentSongBox = root->findChild<QObject*>(QStringLiteral("currentSongBox"));
        QObject* nowPlayingSheet = root->findChild<QObject*>(QStringLiteral("nowPlayingSheet"));
        QObject* swipeStopHandle = root->findChild<QObject*>(QStringLiteral("miniPlayerSwipeStopHandle"));
        QVERIFY(currentSongBox != nullptr);
        QVERIFY(nowPlayingSheet != nullptr);
        QVERIFY(swipeStopHandle != nullptr);
        QTRY_VERIFY(currentSongBox->property("visible").toBool());
        QVERIFY(QMetaObject::invokeMethod(currentSongBox, "clicked"));
        QTRY_VERIFY(nowPlayingSheet->property("visible").toBool());

        QVERIFY(QMetaObject::invokeMethod(swipeStopHandle, "stopFromSwipe"));

        QTRY_COMPARE(controller.property("playbackState").toString(), QStringLiteral("stopped"));
        QTRY_VERIFY(!currentSongBox->property("visible").toBool());
        QTRY_VERIFY(!nowPlayingSheet->property("visible").toBool());
    }

    void mainQmlUsesDrawnIconsAndSearchTapStartsPlayback() {
        const QString qml = readMainQml();
        QVERIFY(!qml.isEmpty());

        QVERIFY2(qml.contains(QStringLiteral("playSearchResult(")), "search results should start playback directly");
        QVERIFY2(
            qml.contains(QStringLiteral("searchStatusLabel.visible")) ||
                qml.contains(QStringLiteral("visible: coreController.searchStatus !== \"Idle\" && coreController.searchStatus !== \"Ready\"")),
            "Idle/Ready search status should not duplicate search page header state");
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
        QVERIFY2(iconButtonBody.contains(QStringLiteral("background: Rectangle")) &&
                iconButtonBody.contains(QStringLiteral("\"transparent\"")),
            "icon-only buttons should not inherit platform-default light button backgrounds on Android");

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

    void mainQmlMatchesStrictOptionBMobileNavigation() {
        const QString qml = readMainQml();
        QVERIFY(!qml.isEmpty());

        QVERIFY2(qml.contains(QStringLiteral("objectName: \"topRightSearchButton\"")),
            "Option B shell should expose search only through the top-right search button");
        QVERIFY2(!qml.contains(QStringLiteral("id: homeSearchField")),
            "Option B mobile home should not duplicate search with an inline field");
        QVERIFY2(!qml.contains(QStringLiteral("objectName: \"homeSearchField\"")),
            "Option B mobile home should not expose a second search entry point");
        QVERIFY2(!qml.contains(QStringLiteral("objectName: \"globalSearchField\"")),
            "Option B shell should not expose a second global search text field");
        QVERIFY2(!qml.contains(QStringLiteral("pageIndex: 2\n                    iconName: \"search\"")),
            "Search should not be a bottom navigation tab");
        QVERIFY2(!qml.contains(QStringLiteral("label: \"Search\"")),
            "Search should not be visible in bottom navigation");
        QVERIFY2(!qml.contains(QStringLiteral("label: \"Queue\"")),
            "Queue should not be visible in bottom navigation");
        const qsizetype settingsNavStart = qml.indexOf(QStringLiteral("objectName: \"floatingNavSettingsButton\""));
        QVERIFY2(settingsNavStart >= 0, "Settings nav button should exist");
        const qsizetype settingsNavEnd = qml.indexOf(QStringLiteral("}"), settingsNavStart);
        const QString settingsNavBody = qml.mid(settingsNavStart, settingsNavEnd - settingsNavStart);
        QVERIFY2(settingsNavBody.contains(QStringLiteral("pageIndex: 2")) &&
                settingsNavBody.contains(QStringLiteral("iconName: \"settings\"")),
            "Settings should move to the third bottom navigation slot");
    }

    void mainQmlUsesStrictOptionBVisualMarkers() {
        const QString qml = readMainQml();
        QVERIFY(!qml.isEmpty());

        QVERIFY2(qml.contains(QStringLiteral("objectName: \"immersiveAlbumBackdrop\"")),
            "Option B shell should name the full-screen album-first backdrop");
        QVERIFY2(qml.contains(QStringLiteral("sourceUrl: coreController.moodArtworkUrl")),
            "Album-first backdrop should use mood artwork instead of playback-only artwork");
        QVERIFY2(!qml.contains(QStringLiteral("source: coreController.playbackArtworkUrl\n")),
            "Backdrop should not bind directly to playback-only artwork");
        QVERIFY2(qml.contains(QStringLiteral("objectName: \"topResultsGlassPanel\"")),
            "Option B search should use a glass top-results panel");
        QVERIFY2(qml.contains(QStringLiteral("objectName: \"viewAllResultsRow\"")),
            "Option B search should expose the view-all-results row");
        QVERIFY2(qml.contains(QStringLiteral("objectName: \"optionBNowPlayingSheet\"")),
            "Option B shell should expose a large glass now-playing sheet");
        QVERIFY2(qml.contains(QStringLiteral("objectName: \"bottomGlassNavigation\"")),
            "Option B bottom navigation should use the glass navigation object");
        QVERIFY2(!qml.contains(QStringLiteral("component HomeLane:")),
            "Home should not use old framed HomeLane cards");
        QVERIFY2(!qml.contains(QStringLiteral("HomeLane {")),
            "Home should use unframed sections, not framed HomeLane instances");
        QVERIFY2(qml.contains(QStringLiteral("component HomeSection: Item")),
            "Home should expose unframed Option B sections");
    }

    void settingsPageUsesDarkStyledControls() {
        const QString qml = readMainQml();
        QVERIFY(!qml.isEmpty());

        QVERIFY2(qml.contains(QStringLiteral("component ShellTextField: TextField")),
            "text fields should own a dark shell style instead of platform-default focused outlines");
        QVERIFY2(qml.contains(QStringLiteral("component SettingsGroup: GroupBox")),
            "settings sections should own a dark GroupBox style instead of platform-default black labels");
        QVERIFY2(qml.contains(QStringLiteral("component SettingsButton: Button")),
            "settings buttons should own a dark button style instead of platform-default light pills");
        QVERIFY2(qml.contains(QStringLiteral("component SettingsComboBox: ComboBox")),
            "settings combo boxes should own a dark style instead of platform-default light controls");
        QVERIFY2(qml.contains(QStringLiteral("component SettingsSwitch: Switch")),
            "settings switches should own a dark style instead of platform-default accent controls");

        const qsizetype settingsStart = qml.indexOf(QStringLiteral("component SettingsPage: Flickable"));
        QVERIFY(settingsStart >= 0);
        const QString settingsBody = qml.mid(settingsStart);

        QVERIFY2(settingsBody.contains(QStringLiteral("SettingsGroup {")),
            "settings page should use dark-styled groups");
        QVERIFY2(settingsBody.contains(QStringLiteral("SettingsButton {")),
            "settings page should use dark-styled buttons");
        QVERIFY2(settingsBody.contains(QStringLiteral("SettingsComboBox {")),
            "settings page should use dark-styled combo boxes");
        QVERIFY2(settingsBody.contains(QStringLiteral("SettingsSwitch {")),
            "settings page should use dark-styled switches");
        QVERIFY2(settingsBody.contains(QStringLiteral("downloadDirectoryDisplay")) &&
                settingsBody.contains(QStringLiteral("elide: Text.ElideMiddle")),
            "download directory display should remain clipped on Android");
        QVERIFY2(settingsBody.contains(QStringLiteral("ShellTextField {")) &&
                !settingsBody.contains(QStringLiteral("placeholderText: \"Download folder\"")),
            "download directory editor should use shell text field styling without an Android floating placeholder");
        QVERIFY2(qml.contains(QStringLiteral("ShellTextField {\n                    id: searchField")) &&
                !qml.contains(QStringLiteral("id: homeSearchField")) &&
                !qml.contains(QStringLiteral("id: globalSearchField")),
            "Only the search overlay should own a search text field");
    }

    void libraryPageUsesDarkStyledControls() {
        const QString qml = readMainQml();
        QVERIFY(!qml.isEmpty());

        QVERIFY2(qml.contains(QStringLiteral("component ShellButton: Button")),
            "Library actions should use dark shell-styled buttons");
        QVERIFY2(qml.contains(QStringLiteral("component ShellSegmentButton: Button")),
            "Library tabs should use dark shell-styled segmented buttons");

        const qsizetype libraryStart = qml.indexOf(QStringLiteral("component LibraryPage: Item"));
        QVERIFY(libraryStart >= 0);
        const qsizetype searchStart = qml.indexOf(QStringLiteral("component SearchPage: Item"), libraryStart);
        QVERIFY(searchStart > libraryStart);
        const QString libraryBody = qml.mid(libraryStart, searchStart - libraryStart);

        QVERIFY2(libraryBody.contains(QStringLiteral("ShellButton {")) &&
                libraryBody.contains(QStringLiteral("objectName: \"importFolderButton\"")),
            "Import Folder should not use a platform-default light Button");
        QVERIFY2(libraryBody.contains(QStringLiteral("ShellSegmentButton {")) &&
                !libraryBody.contains(QStringLiteral("TabBar {")) &&
                !libraryBody.contains(QStringLiteral("\n                TabButton {")),
            "Library tabs should not use Qt TabBar/TabButton platform styling on Android");
    }

    void mainQmlUsesAlbumFirstThemeEffectsAndSplitFiles() {
        const QString qml = readMainQml();
        const QString theme = readQmlFile(u"components/AppTheme.qml");
        const QString artwork = readQmlFile(u"components/ArtworkTile.qml");
        const QString player = readQmlFile(u"components/PlayerControls.qml");
        const QString backdrop = readQmlFile(u"components/AlbumBackdrop.qml");
        const QString glass = readQmlFile(u"components/GlassSurface.qml");
        QVERIFY(!qml.isEmpty());

        QVERIFY2(qml.contains(QStringLiteral("import QtQuick.Effects")),
            "Album-first shell should import QtQuick.Effects for blurred artwork backdrops");
        QVERIFY2(qml.contains(QStringLiteral("AppTheme")) && !theme.isEmpty(),
            "Main.qml should use a split AppTheme component");
        QVERIFY2(qml.contains(QStringLiteral("ArtworkTile")) && !artwork.isEmpty(),
            "Artwork rendering should move into a reusable album-first component");
        QVERIFY2(qml.contains(QStringLiteral("PlayerControls")) && !player.isEmpty(),
            "Now Playing controls should move into a reusable player component");
        QVERIFY2(qml.contains(QStringLiteral("AlbumBackdrop")) && !backdrop.isEmpty(),
            "Backdrop rendering should move into a reusable album-first component");
        QVERIFY2(qml.contains(QStringLiteral("GlassSurface")) && !glass.isEmpty(),
            "Glass surfaces should move into a reusable component");
        QVERIFY2(backdrop.contains(QStringLiteral("albumBackdrop")) &&
                backdrop.contains(QStringLiteral("MultiEffect")) &&
                backdrop.contains(QStringLiteral("blurEnabled")),
            "Shell should expose a blurred album backdrop through AlbumBackdrop");
        QVERIFY2(theme.contains(QStringLiteral("fullImmersiveDark")) &&
                theme.contains(QStringLiteral("lightFallback")),
            "Theme should carry dark primary and light fallback tokens");
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
