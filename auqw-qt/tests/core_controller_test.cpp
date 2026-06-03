#include "../src/CoreController.hpp"
#include "../src/OnlineProvider.hpp"
#include "../src/PlaybackBackend.hpp"
#include "test_storage.hpp"

#include <QAbstractItemModel>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QIODevice>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaObject>
#include <QObject>
#include <QHostAddress>
#include <QPointer>
#include <QSignalSpy>
#include <QStandardPaths>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTest>
#include <QTimer>
#include <QUrl>

#include <auqw/CoreBridge.hpp>

#include <algorithm>
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

QByteArray readFileBytes(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        return {};
    }
    return file.readAll();
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

void appendUmpVarint(QByteArray& bytes, quint32 value) {
    if (value < 128) {
        bytes.append(static_cast<char>(value));
        return;
    }
    if (value < 8192) {
        bytes.append(static_cast<char>(0x80 | (value & 0x3f)));
        bytes.append(static_cast<char>(value / 64));
        return;
    }
    Q_UNREACHABLE();
}

QByteArray umpFrame(quint32 type, const QByteArray& payload) {
    QByteArray frame;
    appendUmpVarint(frame, type);
    appendUmpVarint(frame, static_cast<quint32>(payload.size()));
    frame.append(payload);
    return frame;
}

QByteArray sabrAudioResponse(const QByteArray& audioBytes) {
    QByteArray mediaPayload;
    mediaPayload.append('\0');
    mediaPayload.append(audioBytes);
    return umpFrame(21, mediaPayload);
}

bool requestContainsHeader(const QByteArray& request, const QByteArray& name, const QByteArray& value) {
    const QByteArray wantedName = name.toLower();
    const QList<QByteArray> lines = request.split('\n');
    for (QByteArray line : lines) {
        line = line.trimmed();
        const qsizetype separator = line.indexOf(':');
        if (separator <= 0) {
            continue;
        }
        if (line.left(separator).toLower() == wantedName &&
            line.mid(separator + 1).trimmed() == value) {
            return true;
        }
    }
    return false;
}

class LocalHttpServer final {
public:
    struct Response {
        QByteArray body;
        QByteArray contentType = QByteArrayLiteral("application/octet-stream");
        QByteArray requiredHeaderName;
        QByteArray requiredHeaderValue;
        int delayMs = 0;
    };

    explicit LocalHttpServer(QList<Response> responses)
        : responses_(std::move(responses)) {
        QObject::connect(&server_, &QTcpServer::newConnection, &server_, [this] {
            while (QTcpSocket* socket = server_.nextPendingConnection()) {
                handleSocket(socket);
            }
        });
        const bool listening = server_.listen(QHostAddress::LocalHost);
        Q_ASSERT(listening);
    }

    QUrl url(const QString& path = QStringLiteral("/stream")) const {
        QUrl value;
        value.setScheme(QStringLiteral("http"));
        value.setHost(QStringLiteral("127.0.0.1"));
        value.setPort(server_.serverPort());
        value.setPath(path);
        return value;
    }

    int requestCount() const {
        return requestCount_;
    }

    bool sawRequiredHeader() const {
        return sawRequiredHeader_;
    }

private:
    void handleSocket(QTcpSocket* socket) {
        socket->setParent(&server_);
        auto buffer = std::make_shared<QByteArray>();
        QObject::connect(socket, &QTcpSocket::disconnected, socket, &QTcpSocket::deleteLater);
        QObject::connect(socket, &QTcpSocket::readyRead, &server_, [this, socket, buffer] {
            buffer->append(socket->readAll());
            if (!buffer->contains("\r\n\r\n")) {
                return;
            }

            const int index = requestCount_++;
            const Response response = responses_.value(std::min(index, static_cast<int>(responses_.size()) - 1));
            if (!response.requiredHeaderName.isEmpty()) {
                sawRequiredHeader_ = requestContainsHeader(*buffer, response.requiredHeaderName, response.requiredHeaderValue);
            }

            QPointer<QTcpSocket> guardedSocket(socket);
            const auto sendResponse = [guardedSocket, response] {
                if (!guardedSocket) {
                    return;
                }
                QByteArray header;
                header.append("HTTP/1.1 200 OK\r\n");
                header.append("Connection: close\r\n");
                header.append("Content-Type: ");
                header.append(response.contentType);
                header.append("\r\nContent-Length: ");
                header.append(QByteArray::number(response.body.size()));
                header.append("\r\n\r\n");
                guardedSocket->write(header);
                guardedSocket->write(response.body);
                guardedSocket->disconnectFromHost();
            };

            if (response.delayMs > 0) {
                QTimer::singleShot(response.delayMs, &server_, sendResponse);
            } else {
                sendResponse();
            }
        });
    }

    QTcpServer server_;
    QList<Response> responses_;
    int requestCount_ = 0;
    bool sawRequiredHeader_ = false;
};

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
        ++headeredRemotePlayCalls;
        headeredRemotePlaybackActive = true;
        lastHeaderedRemoteUrl = url;
        lastHeaderedRemoteHeaders = headers;
        lastHeaderedRemoteMimeType = mimeType;
        emitState(QStringLiteral("playing"), 0, std::nullopt);
    }

    void playStreamDevice(std::unique_ptr<QIODevice> device, const QString& mimeType) override {
        ++streamDevicePlayCalls;
        streamDeviceAlive = device != nullptr;
        lastStreamMimeType = mimeType;
        streamDevice = std::move(device);
        if (failStreamDevicePlayback) {
            emitError(QStringLiteral("Online stream playback unsupported on this platform."));
            return;
        }
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
        streamDevice.reset();
        streamDeviceAlive = false;
        headeredRemotePlaybackActive = false;
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
    int remotePlayCalls = 0;
    int headeredRemotePlayCalls = 0;
    int streamDevicePlayCalls = 0;
    int pauseCalls = 0;
    int resumeCalls = 0;
    int stopCalls = 0;
    int seekCalls = 0;
    bool failStreamDevicePlayback = false;
    bool streamDeviceAlive = false;
    bool headeredRemotePlaybackActive = false;
    qint64 lastSeekMs = -1;
    QString lastPath;
    QUrl lastRemoteUrl;
    QUrl lastHeaderedRemoteUrl;
    QList<QPair<QByteArray, QByteArray>> lastHeaderedRemoteHeaders;
    QString lastHeaderedRemoteMimeType;
    QString lastStreamMimeType;
    std::unique_ptr<QIODevice> streamDevice;
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

    void emitError(const QString& message) {
        if (errorCallback) {
            errorCallback(message);
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

int searchHistoryCountForQuery(const QString& databasePath, const QString& query) {
    auqw::InitOptions options;
    options.dataDir = QFileInfo(databasePath).absolutePath().toStdString();
    auqw::CoreBridge core(options);
    const std::string response = core.invokeJson(R"({"id":"search","command":"search_history.list","params":{}})");
    const QJsonObject root = QJsonDocument::fromJson(QByteArray::fromStdString(response)).object();
    const QJsonArray items = root.value(QStringLiteral("data")).toObject().value(QStringLiteral("items")).toArray();

    int count = 0;
    for (const QJsonValue& item : items) {
        if (item.toObject().value(QStringLiteral("query")).toString() == query) {
            ++count;
        }
    }
    return count;
}

QJsonArray artworkCacheRows(const QString& databasePath) {
    auqw::InitOptions options;
    options.dataDir = QFileInfo(databasePath).absolutePath().toStdString();
    auqw::CoreBridge core(options);
    const std::string response = core.invokeJson(R"({"id":"artwork","command":"cache.artwork.list","params":{}})");
    const QJsonObject root = QJsonDocument::fromJson(QByteArray::fromStdString(response)).object();
    return root.value(QStringLiteral("data")).toObject().value(QStringLiteral("artwork")).toArray();
}

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
            .downloads = downloadsSupported,
        };
    }

    void searchTracks(const QString& query) override {
        ++searchCalls;
        lastQuery = query;
        if (holdSearch) {
            return;
        }
        if (failNext) {
            emit searchFailed(query, QStringLiteral("upstream exploded"));
            return;
        }
        emit searchSucceeded(query, nextResults);
    }

    void suggestTracks(const QString& query) override {
        ++suggestCalls;
        lastSuggestQuery = query;
        if (holdSuggestions) {
            return;
        }
        emit suggestionsSucceeded(query, nextSuggestions);
    }

    void fetchTrackMetadata(const QString& provider, const QString& providerTrackId) override {
        ++metadataCalls;
        lastMetadataProvider = provider;
        lastMetadataTrackId = providerTrackId;
        emit metadataSucceeded(provider, providerTrackId, nextMetadata);
    }

    void resolveStream(const QString& provider, const QString& providerTrackId) override {
        ++resolveCalls;
        lastResolveProvider = provider;
        lastResolveTrackId = providerTrackId;
    }

    void emitResolvedStream(
        const QString& provider,
        const QString& providerTrackId,
        const QUrl& streamUrl = QUrl(QStringLiteral("https://audio.example/direct.webm")),
        const QString& mimeType = QStringLiteral("audio/webm; codecs=\"opus\"")) {
        emit streamResolved(provider, providerTrackId, OnlineStreamResult{
            .provider = provider,
            .providerTrackId = providerTrackId,
            .streamUrl = streamUrl,
            .mimeType = mimeType,
        });
    }

    void emitResolvedHeaderedStream(
        const QString& provider,
        const QString& providerTrackId,
        const QUrl& streamUrl = QUrl(QStringLiteral("https://audio.example/headered.webm")),
        const QString& mimeType = QStringLiteral("audio/webm; codecs=\"opus\""),
        int itag = 251) {
        OnlineStreamResult stream;
        stream.provider = provider;
        stream.providerTrackId = providerTrackId;
        stream.streamUrl = streamUrl;
        stream.mimeType = mimeType;
        stream.streamKind = OnlineStreamKind::HeaderedDirectUrl;
        stream.requestHeaders = {
            {QByteArrayLiteral("X-Test-Download"), QByteArrayLiteral("direct-secret")},
        };
        stream.clientName = QStringLiteral("ANDROID_VR");
        stream.itag = itag;
        emit streamResolved(provider, providerTrackId, stream);
    }

    void emitResolvedSabrStream(
        const QString& provider,
        const QString& providerTrackId,
        const QUrl& streamUrl = QUrl(QStringLiteral("https://rr1.example/videoplayback?sabr=1"))) {
        YoutubeSabrStreamInfo sabr;
        sabr.providerTrackId = providerTrackId;
        sabr.serverAbrStreamingUrl = streamUrl;
        sabr.videoPlaybackUstreamerConfig = QStringLiteral("dXN0cmVhbWVy");
        sabr.clientName = QStringLiteral("WEB");
        sabr.clientVersion = QStringLiteral("2.20260528.01.00");
        sabr.visitorData = QStringLiteral("visitor-token");
        sabr.audioFormats = QVector<YoutubeSabrFormat>{
            YoutubeSabrFormat{
                .itag = 251,
                .mimeType = QStringLiteral("audio/webm; codecs=\"opus\""),
                .bitrate = 160000,
                .lastModified = 1780000000000001LL,
                .xtags = QStringLiteral("acont=original"),
            },
        };
        emit streamResolved(provider, providerTrackId, OnlineStreamResult{
            .provider = provider,
            .providerTrackId = providerTrackId,
            .mimeType = QStringLiteral("audio/webm; codecs=\"opus\""),
            .isSabr = true,
            .sabr = sabr,
        });
    }

    void emitStreamFailure(const QString& provider, const QString& providerTrackId) {
        emit streamResolveFailed(provider, providerTrackId, QStringLiteral("direct stream unavailable"));
    }

    void emitSearchResults(const QString& query, const QVector<OnlineTrackResult>& results) {
        emit searchSucceeded(query, results);
    }

    void emitSuggestions(const QString& query) {
        emit suggestionsSucceeded(query, nextSuggestions);
    }

    int searchCalls = 0;
    int suggestCalls = 0;
    int metadataCalls = 0;
    int resolveCalls = 0;
    bool downloadsSupported = false;
    bool failNext = false;
    bool holdSearch = false;
    bool holdSuggestions = false;
    QString lastQuery;
    QString lastSuggestQuery;
    QString lastMetadataProvider;
    QString lastMetadataTrackId;
    QString lastResolveProvider;
    QString lastResolveTrackId;
    QVector<OnlineTrackResult> nextResults;
    QVector<OnlineSuggestionResult> nextSuggestions;
    OnlineTrackMetadata nextMetadata;
};

std::unique_ptr<CoreController> makeController(
    FakeOnlineProvider** providerOut = nullptr,
    FakePlaybackBackend** backendOut = nullptr) {
    auto playback = std::make_unique<FakePlaybackBackend>();
    if (backendOut != nullptr) {
        *backendOut = playback.get();
    }
    auto provider = std::make_unique<FakeOnlineProvider>();
    if (providerOut != nullptr) {
        *providerOut = provider.get();
    }
    return std::make_unique<CoreController>(std::move(playback), std::move(provider));
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
        QCOMPARE(controller.property("schemaVersion").toInt(), 6);
        QCOMPARE(controller.property("coreStatus").toString(), QStringLiteral("Ready"));
        QCOMPARE(controller.property("helloText").toString(), QStringLiteral("Hello from Auqw Core"));

        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* playlists = qobject_cast<QAbstractItemModel*>(controller.property("playlistsModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        auto* downloads = qobject_cast<QAbstractItemModel*>(controller.property("downloadsModel").value<QObject*>());
        auto* searchResults = qobject_cast<QAbstractItemModel*>(controller.property("searchResultsModel").value<QObject*>());
        auto* recentTracks = qobject_cast<QAbstractItemModel*>(controller.property("recentTracksModel").value<QObject*>());
        auto* favoriteTracks = qobject_cast<QAbstractItemModel*>(controller.property("favoriteTracksModel").value<QObject*>());
        auto* recommendations = qobject_cast<QAbstractItemModel*>(controller.property("recommendationsModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(playlists != nullptr);
        QVERIFY(queue != nullptr);
        QVERIFY(downloads != nullptr);
        QVERIFY(searchResults != nullptr);
        QVERIFY(recentTracks != nullptr);
        QVERIFY(favoriteTracks != nullptr);
        QVERIFY(recommendations != nullptr);
        QCOMPARE(tracks->rowCount(), 0);
        QCOMPARE(playlists->rowCount(), 0);
        QCOMPARE(queue->rowCount(), 0);
        QCOMPARE(downloads->rowCount(), 0);
        QCOMPARE(searchResults->rowCount(), 0);
        QCOMPARE(recentTracks->rowCount(), 0);
        QCOMPARE(favoriteTracks->rowCount(), 0);
        QCOMPARE(recommendations->rowCount(), 0);
        QCOMPARE(controller.property("searchStatus").toString(), QStringLiteral("Idle"));
        QCOMPARE(controller.property("searchErrorMessage").toString(), QString{});
        QCOMPARE(controller.property("downloadStatus").toString(), QStringLiteral("Idle"));
        QVERIFY(controller.property("downloadDirectory").toString().length() > 0);
        QCOMPARE(controller.property("onlineEnabled").toBool(), true);
        QCOMPARE(controller.property("onlineSourceStatus").toString(), QStringLiteral("Ready"));
        QCOMPARE(controller.property("onlineSourceCapabilities").toStringList(), QStringList({
            QStringLiteral("Search"),
            QStringLiteral("Suggestions"),
            QStringLiteral("Metadata"),
            QStringLiteral("Playback"),
            QStringLiteral("Downloads"),
        }));
    }

    void onlineEnabledSettingPersistsAndBlocksProviderCalls() {
        {
            FakeOnlineProvider* provider = nullptr;
            const std::unique_ptr<CoreController> controller = makeController(&provider);
            QSignalSpy onlineSpy(controller.get(), SIGNAL(onlineSourceChanged()));

            QVERIFY(QMetaObject::invokeMethod(controller.get(), "setOnlineEnabled", Q_ARG(bool, false)));

            QCOMPARE(controller->property("onlineEnabled").toBool(), false);
            QCOMPARE(controller->property("onlineSourceStatus").toString(), QStringLiteral("Disabled"));
            QVERIFY(onlineSpy.count() >= 1);

            QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
            QCOMPARE(provider->searchCalls, 0);
            QCOMPARE(controller->property("searchStatus").toString(), QStringLiteral("Disabled"));
            QCOMPARE(controller->property("searchErrorMessage").toString(), QStringLiteral("Online search disabled."));

            QVERIFY(QMetaObject::invokeMethod(controller.get(), "suggestOnline", Q_ARG(QString, QStringLiteral("sto"))));
            QCOMPARE(provider->suggestCalls, 0);
        }

        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        QCOMPARE(controller->property("onlineEnabled").toBool(), false);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "setOnlineEnabled", Q_ARG(bool, true)));
        QCOMPARE(controller->property("onlineSourceStatus").toString(), QStringLiteral("Ready"));

        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QCOMPARE(provider->searchCalls, 1);
        QCOMPARE(controller->property("searchStatus").toString(), QStringLiteral("Ready"));
    }

    void onlineSearchPopulatesResultsAndRecordsHistory() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
                .artist = QStringLiteral("Aster Band"),
                .album = QStringLiteral("Blue Album"),
                .durationMs = 213000,
                .artworkUrl = QStringLiteral("https://img.example/large.jpg"),
            },
        };

        auto* searchResults = qobject_cast<QAbstractItemModel*>(controller->property("searchResultsModel").value<QObject*>());
        QVERIFY(searchResults != nullptr);
        const int resultIdRole = roleForName(searchResults, "result_id");
        const int titleRole = roleForName(searchResults, "title");
        const int artistRole = roleForName(searchResults, "artist");
        const int artworkRole = roleForName(searchResults, "artwork_url");
        QVERIFY(resultIdRole > 0);
        QVERIFY(titleRole > 0);
        QVERIFY(artistRole > 0);
        QVERIFY(artworkRole > 0);

        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "searchOnline",
            Q_ARG(QString, QStringLiteral("stone"))));

        QCOMPARE(provider->searchCalls, 1);
        QCOMPARE(provider->lastQuery, QStringLiteral("stone"));
        QCOMPARE(searchResults->rowCount(), 1);
        QCOMPARE(searchResults->data(searchResults->index(0, 0), resultIdRole).toString(), QStringLiteral("ytmusic:video-alpha"));
        QCOMPARE(searchResults->data(searchResults->index(0, 0), titleRole).toString(), QStringLiteral("Stone Window"));
        QCOMPARE(searchResults->data(searchResults->index(0, 0), artistRole).toString(), QStringLiteral("Aster Band"));
        QCOMPARE(searchResults->data(searchResults->index(0, 0), artworkRole).toString(), QStringLiteral("https://img.example/large.jpg"));
        QCOMPARE(controller->property("searchStatus").toString(), QStringLiteral("Ready"));
        QCOMPARE(controller->property("searchErrorMessage").toString(), QString{});
        QCOMPARE(searchHistoryCountForQuery(controller->property("databasePath").toString(), QStringLiteral("stone")), 1);
    }

    void moodArtworkUrlUsesFirstAvailableArtworkByPriority() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        QSignalSpy moodSpy(controller.get(), SIGNAL(moodArtworkUrlChanged()));

        QCOMPARE(controller->property("moodArtworkUrl").toString(), QString{});

        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:fav"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("fav"),
                .title = QStringLiteral("Favorite Seed"),
                .artist = QStringLiteral("Aster Band"),
                .artworkUrl = QStringLiteral("https://img.example/favorite.jpg"),
            },
        };
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("favorite"))));
        QCOMPARE(controller->property("moodArtworkUrl").toString(), QStringLiteral("https://img.example/favorite.jpg"));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "favoriteSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:fav"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QString{})));
        QCOMPARE(controller->property("moodArtworkUrl").toString(), QStringLiteral("https://img.example/favorite.jpg"));

        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:recent"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("recent"),
                .title = QStringLiteral("Recent Track"),
                .artist = QStringLiteral("Aster Band"),
                .artworkUrl = QStringLiteral("https://img.example/recent.jpg"),
            },
        };
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("recent"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:recent"))));
        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("recent"));
        QCOMPARE(controller->property("moodArtworkUrl").toString(), QStringLiteral("https://img.example/recent.jpg"));

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "stopPlayback"));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QString{})));
        QCOMPARE(controller->property("moodArtworkUrl").toString(), QStringLiteral("https://img.example/recent.jpg"));

        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:search"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("search"),
                .title = QStringLiteral("Search Track"),
                .artworkUrl = QStringLiteral("https://img.example/search.jpg"),
            },
        };
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("search"))));
        QCOMPARE(controller->property("moodArtworkUrl").toString(), QStringLiteral("https://img.example/search.jpg"));

        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:playback"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("playback"),
                .title = QStringLiteral("Playback Track"),
                .artworkUrl = QStringLiteral("https://img.example/playback.jpg"),
            },
        };
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("playback"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:playback"))));
        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("playback"));
        QCOMPARE(controller->property("moodArtworkUrl").toString(), QStringLiteral("https://img.example/playback.jpg"));

        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:other"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("other"),
                .title = QStringLiteral("Other Track"),
                .artworkUrl = QStringLiteral("https://img.example/search-overridden.jpg"),
            },
        };
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("other"))));
        QCOMPARE(controller->property("moodArtworkUrl").toString(), QStringLiteral("https://img.example/playback.jpg"));
        QVERIFY(moodSpy.count() > 0);
    }

    void onlineSuggestionsPopulateModelAndAcceptedSuggestionRunsSearch() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->nextSuggestions = QVector<OnlineSuggestionResult>{
            OnlineSuggestionResult{
                .provider = QStringLiteral("ytmusic"),
                .text = QStringLiteral("stone window"),
            },
        };
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* suggestions = qobject_cast<QAbstractItemModel*>(controller->property("searchSuggestionsModel").value<QObject*>());
        QVERIFY(suggestions != nullptr);
        const int providerRole = roleForName(suggestions, "provider");
        const int textRole = roleForName(suggestions, "text");
        QVERIFY(providerRole > 0);
        QVERIFY(textRole > 0);

        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "suggestOnline",
            Q_ARG(QString, QStringLiteral("sto"))));

        QCOMPARE(provider->suggestCalls, 1);
        QCOMPARE(provider->lastSuggestQuery, QStringLiteral("sto"));
        QCOMPARE(suggestions->rowCount(), 1);
        QCOMPARE(suggestions->data(suggestions->index(0, 0), providerRole).toString(), QStringLiteral("ytmusic"));
        QCOMPARE(suggestions->data(suggestions->index(0, 0), textRole).toString(), QStringLiteral("stone window"));

        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "acceptSearchSuggestion",
            Q_ARG(QString, QStringLiteral("stone window"))));

        QCOMPARE(suggestions->rowCount(), 0);
        QCOMPARE(provider->searchCalls, 1);
        QCOMPARE(provider->lastQuery, QStringLiteral("stone window"));
        QCOMPARE(controller->property("searchStatus").toString(), QStringLiteral("Ready"));
    }

    void acceptedSuggestionIgnoresStaleSuggestionReplies() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->holdSuggestions = true;
        provider->nextSuggestions = QVector<OnlineSuggestionResult>{
            OnlineSuggestionResult{
                .provider = QStringLiteral("ytmusic"),
                .text = QStringLiteral("stone window"),
            },
        };
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* suggestions = qobject_cast<QAbstractItemModel*>(controller->property("searchSuggestionsModel").value<QObject*>());
        QVERIFY(suggestions != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "suggestOnline",
            Q_ARG(QString, QStringLiteral("sto"))));
        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "acceptSearchSuggestion",
            Q_ARG(QString, QStringLiteral("stone window"))));

        provider->emitSuggestions(QStringLiteral("sto"));

        QCOMPARE(suggestions->rowCount(), 0);
        QCOMPARE(provider->searchCalls, 1);
    }

    void addSearchResultUpsertsTrackAndQueuesIt() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
                .artist = QStringLiteral("Aster Band"),
                .album = QStringLiteral("Blue Album"),
                .durationMs = 213000,
                .artworkUrl = QStringLiteral("https://img.example/large.jpg"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueTitleRole = roleForName(queue, "title");
        const int queueLocalPathRole = roleForName(queue, "local_path");
        const int queueProviderRole = roleForName(queue, "provider");
        const int queueProviderTrackIdRole = roleForName(queue, "provider_track_id");
        QVERIFY(queueTitleRole > 0);
        QVERIFY(queueLocalPathRole > 0);
        QVERIFY(queueProviderRole > 0);
        QVERIFY(queueProviderTrackIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "searchOnline",
            Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "addSearchResultToQueue",
            Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        QCOMPARE(queue->rowCount(), 1);
        QCOMPARE(queue->data(queue->index(0, 0), queueTitleRole).toString(), QStringLiteral("Stone Window"));
        QCOMPARE(queue->data(queue->index(0, 0), queueLocalPathRole).toString(), QString{});
        QCOMPARE(queue->data(queue->index(0, 0), queueProviderRole).toString(), QStringLiteral("ytmusic"));
        QCOMPARE(queue->data(queue->index(0, 0), queueProviderTrackIdRole).toString(), QStringLiteral("video-alpha"));
        QCOMPARE(controller->property("coreStatus").toString(), QStringLiteral("Ready"));
    }

    void playSearchResultQueuesAndStartsResolvedStream() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
                .artist = QStringLiteral("Aster Band"),
                .album = QStringLiteral("Blue Album"),
                .durationMs = 213000,
                .artworkUrl = QStringLiteral("https://img.example/large.jpg"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        const int queueTitleRole = roleForName(queue, "title");
        QVERIFY(queueIdRole > 0);
        QVERIFY(queueTitleRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        QCOMPARE(queue->rowCount(), 1);
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        QVERIFY(!queueItemId.isEmpty());
        QCOMPARE(queue->data(queue->index(0, 0), queueTitleRole).toString(), QStringLiteral("Stone Window"));
        QCOMPARE(provider->resolveCalls, 1);
        QCOMPARE(provider->lastResolveProvider, QStringLiteral("ytmusic"));
        QCOMPARE(provider->lastResolveTrackId, QStringLiteral("video-alpha"));
        QCOMPARE(backend->remotePlayCalls, 0);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("loading"));

        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QCOMPARE(backend->remotePlayCalls, 1);
        QCOMPARE(backend->lastRemoteUrl, QUrl(QStringLiteral("https://audio.example/direct.webm")));
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
        QCOMPARE(controller->property("playbackQueueItemId").toString(), queueItemId);
        QCOMPARE(controller->property("playbackTitle").toString(), QStringLiteral("Stone Window"));
    }

    void playSearchResultReusesQueuedItemAndRestartsFromCachedStream() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QCOMPARE(queue->rowCount(), 1);
        const QString queueItemId = roleValue(queue, 0, "id").toString();
        QCOMPARE(provider->resolveCalls, 1);
        QCOMPARE(backend->remotePlayCalls, 1);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        QCOMPARE(queue->rowCount(), 1);
        QCOMPARE(roleValue(queue, 0, "id").toString(), queueItemId);
        QCOMPARE(provider->resolveCalls, 1);
        QCOMPARE(backend->remotePlayCalls, 2);
        QCOMPARE(controller->property("playbackQueueItemId").toString(), queueItemId);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
    }

    void playSearchResultFirstSecondFirstSequenceKeepsTwoQueueItemsAndPlaysEachTap() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-beta"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-beta"),
                .title = QStringLiteral("Moon Door"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        provider->emitResolvedStream(
            QStringLiteral("ytmusic"),
            QStringLiteral("video-alpha"),
            QUrl(QStringLiteral("https://audio.example/alpha.webm")));
        QCOMPARE(backend->remotePlayCalls, 1);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-beta"))));
        provider->emitResolvedStream(
            QStringLiteral("ytmusic"),
            QStringLiteral("video-beta"),
            QUrl(QStringLiteral("https://audio.example/beta.webm")));
        QCOMPARE(backend->remotePlayCalls, 2);
        QCOMPARE(backend->lastRemoteUrl, QUrl(QStringLiteral("https://audio.example/beta.webm")));

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        QCOMPARE(queue->rowCount(), 2);
        QCOMPARE(backend->remotePlayCalls, 3);
        QCOMPARE(backend->lastRemoteUrl, QUrl(QStringLiteral("https://audio.example/alpha.webm")));
        QCOMPARE(controller->property("playbackTitle").toString(), QStringLiteral("Stone Window"));
    }

    void searchResultModelMarksCurrentPlayingRow() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* searchResults = qobject_cast<QAbstractItemModel*>(controller->property("searchResultsModel").value<QObject*>());
        QVERIFY(searchResults != nullptr);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        const int playingRole = roleForName(searchResults, "is_playing");
        const int loadingRole = roleForName(searchResults, "is_loading");
        QVERIFY(playingRole > 0);
        QVERIFY(loadingRole > 0);
        QCOMPARE(searchResults->data(searchResults->index(0, 0), playingRole).toBool(), false);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        QCOMPARE(searchResults->data(searchResults->index(0, 0), loadingRole).toBool(), true);
        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QCOMPARE(searchResults->data(searchResults->index(0, 0), playingRole).toBool(), true);
        QCOMPARE(searchResults->data(searchResults->index(0, 0), loadingRole).toBool(), false);
    }

    void prewarmStoresStreamAndIgnoresStaleQueryResults() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->holdSearch = true;
        const QVector<OnlineTrackResult> staleResults{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };
        const QVector<OnlineTrackResult> freshResults{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-beta"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-beta"),
                .title = QStringLiteral("Moon Door"),
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("moon"))));
        provider->emitSearchResults(QStringLiteral("stone"), staleResults);
        provider->emitSearchResults(QStringLiteral("moon"), freshResults);

        QTRY_COMPARE(provider->resolveCalls, 1);
        QCOMPARE(provider->lastResolveTrackId, QStringLiteral("video-beta"));
        provider->emitResolvedStream(
            QStringLiteral("ytmusic"),
            QStringLiteral("video-beta"),
            QUrl(QStringLiteral("https://audio.example/prewarmed.webm")));

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-beta"))));

        QCOMPARE(provider->resolveCalls, 1);
        QCOMPARE(backend->remotePlayCalls, 1);
        QCOMPARE(backend->lastRemoteUrl, QUrl(QStringLiteral("https://audio.example/prewarmed.webm")));
        QCOMPARE(controller->property("playbackTitle").toString(), QStringLiteral("Moon Door"));
    }

    void playSearchResultWithMissingIdDoesNotQueue() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playSearchResult", Q_ARG(QString, QStringLiteral("missing"))));

        QCOMPARE(queue->rowCount(), 0);
        QCOMPARE(provider->resolveCalls, 0);
        QCOMPARE(backend->remotePlayCalls, 0);
        QCOMPARE(backend->playCalls, 0);
        QCOMPARE(controller->property("coreStatus").toString(), QStringLiteral("Search result unavailable"));
    }

    void favoriteSearchResultUpsertsTrackAndRefreshesHomeModels() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
                .artist = QStringLiteral("Aster Band"),
                .album = QStringLiteral("Blue Album"),
                .durationMs = 213000,
                .artworkUrl = QStringLiteral("https://img.example/large.jpg"),
            },
        };

        auto* tracks = qobject_cast<QAbstractItemModel*>(controller->property("tracksModel").value<QObject*>());
        auto* favorites = qobject_cast<QAbstractItemModel*>(controller->property("favoriteTracksModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(favorites != nullptr);
        QCOMPARE(favorites->rowCount(), 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "favoriteSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        QCOMPARE(tracks->rowCount(), 1);
        QCOMPARE(favorites->rowCount(), 1);
        QCOMPARE(roleValue(favorites, 0, "title").toString(), QStringLiteral("Stone Window"));
        QCOMPARE(roleValue(favorites, 0, "artist").toString(), QStringLiteral("Aster Band"));
        QCOMPARE(roleValue(favorites, 0, "artwork_url").toString(), QStringLiteral("https://img.example/large.jpg"));

        const QString trackId = roleValue(favorites, 0, "track_id").toString();
        QVERIFY(!trackId.isEmpty());
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "unfavoriteTrack", Q_ARG(QString, trackId)));
        QCOMPARE(favorites->rowCount(), 0);
    }

    void unsupportedProviderDownloadShowsFriendlyStatusAndDoesNotQueue() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->downloadsSupported = false;
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* downloads = qobject_cast<QAbstractItemModel*>(controller->property("downloadsModel").value<QObject*>());
        QVERIFY(downloads != nullptr);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "downloadSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        QCOMPARE(downloads->rowCount(), 0);
        QCOMPARE(provider->metadataCalls, 0);
        QCOMPARE(provider->resolveCalls, 0);
        QCOMPARE(controller->property("downloadStatus").toString(), QStringLiteral("Downloads unavailable for this provider."));
    }

    void downloadCapableProviderQueuesAndStartsResolve() {
        QTemporaryDir downloadDir;
        QVERIFY(downloadDir.isValid());

        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->downloadsSupported = true;
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
                .artist = QStringLiteral("Aster Band"),
                .durationMs = 213000,
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "setDownloadDirectory", Q_ARG(QString, downloadDir.path())));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "downloadSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        auto* downloads = qobject_cast<QAbstractItemModel*>(controller->property("downloadsModel").value<QObject*>());
        QVERIFY(downloads != nullptr);
        QCOMPARE(downloads->rowCount(), 1);

        const int stateRole = roleForName(downloads, "state");
        const int progressRole = roleForName(downloads, "progress");
        const int targetPathRole = roleForName(downloads, "target_path");
        const int titleRole = roleForName(downloads, "title");
        QVERIFY(stateRole > 0);
        QVERIFY(progressRole > 0);
        QVERIFY(targetPathRole > 0);
        QVERIFY(titleRole > 0);
        QCOMPARE(downloads->data(downloads->index(0, 0), stateRole).toString(), QStringLiteral("resolving"));
        QCOMPARE(downloads->data(downloads->index(0, 0), progressRole).toLongLong(), 0);
        QVERIFY(downloads->data(downloads->index(0, 0), targetPathRole).toString().startsWith(downloadDir.path()));
        QCOMPARE(downloads->data(downloads->index(0, 0), titleRole).toString(), QStringLiteral("Stone Window"));
        QCOMPARE(controller->property("downloadStatus").toString(), QStringLiteral("Resolving download"));
        QCOMPARE(provider->metadataCalls, 0);
        QCOMPARE(provider->resolveCalls, 1);
        QCOMPARE(provider->lastResolveProvider, QStringLiteral("ytmusic"));
        QCOMPARE(provider->lastResolveTrackId, QStringLiteral("video-alpha"));
    }

    void directStreamDownloadWritesOriginalBytesAndCompletes() {
        QTemporaryDir downloadDir;
        QVERIFY(downloadDir.isValid());
        const QByteArray audioBytes = QByteArrayLiteral("direct-webm-bytes");
        LocalHttpServer server({
            LocalHttpServer::Response{
                .body = audioBytes,
                .contentType = QByteArrayLiteral("audio/webm"),
            },
        });

        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->downloadsSupported = true;
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "setDownloadDirectory", Q_ARG(QString, downloadDir.path())));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "downloadSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        QCOMPARE(provider->resolveCalls, 1);

        auto* downloads = qobject_cast<QAbstractItemModel*>(controller->property("downloadsModel").value<QObject*>());
        QVERIFY(downloads != nullptr);
        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"), server.url(QStringLiteral("/direct.webm")), QStringLiteral("audio/webm"));

        QTRY_COMPARE(roleValue(downloads, 0, "state").toString(), QStringLiteral("completed"));
        QCOMPARE(roleValue(downloads, 0, "progress").toLongLong(), 100);
        QCOMPARE(roleValue(downloads, 0, "bytes_received").toLongLong(), audioBytes.size());
        QCOMPARE(roleValue(downloads, 0, "bytes_total").toLongLong(), audioBytes.size());
        QCOMPARE(roleValue(downloads, 0, "mime_type").toString(), QStringLiteral("audio/webm"));
        QCOMPARE(roleValue(downloads, 0, "stream_kind").toString(), QStringLiteral("direct"));
        const QString targetPath = roleValue(downloads, 0, "target_path").toString();
        QVERIFY(targetPath.startsWith(downloadDir.path()));
        QVERIFY(targetPath.endsWith(QStringLiteral(".webm")));
        QCOMPARE(readFileBytes(targetPath), audioBytes);
        QCOMPARE(controller->property("downloadStatus").toString(), QStringLiteral("Download completed"));
    }

    void headeredStreamDownloadSendsHeadersAndCompletes() {
        QTemporaryDir downloadDir;
        QVERIFY(downloadDir.isValid());
        const QByteArray audioBytes = QByteArrayLiteral("headered-m4a-bytes");
        LocalHttpServer server({
            LocalHttpServer::Response{
                .body = audioBytes,
                .contentType = QByteArrayLiteral("audio/mp4"),
                .requiredHeaderName = QByteArrayLiteral("X-Test-Download"),
                .requiredHeaderValue = QByteArrayLiteral("direct-secret"),
            },
        });

        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->downloadsSupported = true;
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "setDownloadDirectory", Q_ARG(QString, downloadDir.path())));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "downloadSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        auto* downloads = qobject_cast<QAbstractItemModel*>(controller->property("downloadsModel").value<QObject*>());
        QVERIFY(downloads != nullptr);
        provider->emitResolvedHeaderedStream(
            QStringLiteral("ytmusic"),
            QStringLiteral("video-alpha"),
            server.url(QStringLiteral("/headered.m4a")),
            QStringLiteral("audio/mp4"),
            140);

        QTRY_COMPARE(roleValue(downloads, 0, "state").toString(), QStringLiteral("completed"));
        QVERIFY(server.sawRequiredHeader());
        QCOMPARE(roleValue(downloads, 0, "progress").toLongLong(), 100);
        QCOMPARE(roleValue(downloads, 0, "bytes_received").toLongLong(), audioBytes.size());
        QCOMPARE(roleValue(downloads, 0, "bytes_total").toLongLong(), audioBytes.size());
        QCOMPARE(roleValue(downloads, 0, "mime_type").toString(), QStringLiteral("audio/mp4"));
        QCOMPARE(roleValue(downloads, 0, "stream_kind").toString(), QStringLiteral("headered_direct"));
        const QString targetPath = roleValue(downloads, 0, "target_path").toString();
        QVERIFY(targetPath.endsWith(QStringLiteral(".m4a")));
        QCOMPARE(readFileBytes(targetPath), audioBytes);
    }

    void sabrStreamDownloadWritesParsedAudioPayloadBytes() {
        QTemporaryDir downloadDir;
        QVERIFY(downloadDir.isValid());
        const QByteArray audioBytes = QByteArrayLiteral("sabr-audio-payload");
        LocalHttpServer server({
            LocalHttpServer::Response{
                .body = sabrAudioResponse(audioBytes),
                .contentType = QByteArrayLiteral("application/vnd.yt-ump"),
            },
            LocalHttpServer::Response{
                .body = {},
                .contentType = QByteArrayLiteral("application/vnd.yt-ump"),
            },
        });

        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->downloadsSupported = true;
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "setDownloadDirectory", Q_ARG(QString, downloadDir.path())));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "downloadSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        auto* downloads = qobject_cast<QAbstractItemModel*>(controller->property("downloadsModel").value<QObject*>());
        QVERIFY(downloads != nullptr);
        provider->emitResolvedSabrStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"), server.url(QStringLiteral("/sabr")));

        QTRY_COMPARE(roleValue(downloads, 0, "state").toString(), QStringLiteral("completed"));
        QTRY_VERIFY(server.requestCount() >= 2);
        QCOMPARE(roleValue(downloads, 0, "progress").toLongLong(), 100);
        QCOMPARE(roleValue(downloads, 0, "bytes_received").toLongLong(), audioBytes.size());
        QVERIFY(roleValue(downloads, 0, "bytes_total").toString().isEmpty());
        QCOMPARE(roleValue(downloads, 0, "mime_type").toString(), QStringLiteral("audio/webm; codecs=\"opus\""));
        QCOMPARE(roleValue(downloads, 0, "stream_kind").toString(), QStringLiteral("sabr"));
        const QString targetPath = roleValue(downloads, 0, "target_path").toString();
        QVERIFY(targetPath.endsWith(QStringLiteral(".webm")));
        QCOMPARE(readFileBytes(targetPath), audioBytes);
    }

    void removeActiveDownloadCancelsWorkerAndDeletesFiles() {
        QTemporaryDir downloadDir;
        QVERIFY(downloadDir.isValid());
        const QByteArray audioBytes = QByteArrayLiteral("slow-direct-bytes");
        LocalHttpServer server({
            LocalHttpServer::Response{
                .body = audioBytes,
                .contentType = QByteArrayLiteral("audio/webm"),
                .delayMs = 400,
            },
        });

        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->downloadsSupported = true;
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "setDownloadDirectory", Q_ARG(QString, downloadDir.path())));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "downloadSearchResult", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        auto* downloads = qobject_cast<QAbstractItemModel*>(controller->property("downloadsModel").value<QObject*>());
        QVERIFY(downloads != nullptr);
        QCOMPARE(downloads->rowCount(), 1);
        const int idRole = roleForName(downloads, "id");
        const int targetPathRole = roleForName(downloads, "target_path");
        QVERIFY(idRole > 0);
        QVERIFY(targetPathRole > 0);
        const QString downloadId = downloads->data(downloads->index(0, 0), idRole).toString();
        QVERIFY(!downloadId.isEmpty());
        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"), server.url(QStringLiteral("/slow.webm")), QStringLiteral("audio/webm"));
        QTRY_COMPARE(roleValue(downloads, 0, "state").toString(), QStringLiteral("downloading"));
        const QString targetPath = downloads->data(downloads->index(0, 0), targetPathRole).toString();
        QVERIFY(!targetPath.isEmpty());

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "removeDownload", Q_ARG(QString, downloadId)));

        QCOMPARE(downloads->rowCount(), 0);
        QTest::qWait(500);
        QVERIFY(!QFileInfo::exists(targetPath));
        const QStringList files = QDir(downloadDir.path()).entryList(QDir::Files | QDir::Hidden | QDir::NoDotAndDotDot);
        QVERIFY(files.isEmpty());
        QCOMPARE(controller->property("downloadStatus").toString(), QStringLiteral("Download removed"));
    }

    void artworkCacheRecordsLocalCachePath() {
        QTemporaryDir artworkDir;
        QVERIFY(artworkDir.isValid());
        const QString artworkSource = QDir(artworkDir.path()).filePath(QStringLiteral("cover.jpg"));
        QVERIFY(writeTestFile(artworkSource));

        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
                .artworkUrl = QUrl::fromLocalFile(artworkSource).toString(),
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));

        const QJsonArray rows = artworkCacheRows(controller->property("databasePath").toString());
        QCOMPARE(rows.size(), 1);
        const QJsonObject artwork = rows.first().toObject();
        QCOMPARE(artwork.value(QStringLiteral("source_url")).toString(), QUrl::fromLocalFile(artworkSource).toString());
        const QString cachePath = artwork.value(QStringLiteral("cache_path")).toString();
        QVERIFY(cachePath.contains(QStringLiteral("/artwork/")));
        QVERIFY(QFileInfo::exists(cachePath));
    }

    void onlineSearchFailureShowsFriendlyErrorAndDoesNotQueue() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->failNext = true;

        auto* searchResults = qobject_cast<QAbstractItemModel*>(controller->property("searchResultsModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(searchResults != nullptr);
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            controller.get(),
            "searchOnline",
            Q_ARG(QString, QStringLiteral("stone"))));

        QCOMPARE(searchResults->rowCount(), 0);
        QCOMPARE(queue->rowCount(), 0);
        QCOMPARE(controller->property("searchStatus").toString(), QStringLiteral("Error"));
        QCOMPARE(controller->property("searchErrorMessage").toString(), QStringLiteral("upstream exploded"));
    }

    void playsQueuedOnlineTrackThroughResolvedStream() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
                .artist = QStringLiteral("Aster Band"),
                .durationMs = 213000,
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        QVERIFY(!queueItemId.isEmpty());

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, queueItemId)));

        QCOMPARE(provider->resolveCalls, 1);
        QCOMPARE(provider->lastResolveProvider, QStringLiteral("ytmusic"));
        QCOMPARE(provider->lastResolveTrackId, QStringLiteral("video-alpha"));
        QCOMPARE(backend->playCalls, 0);
        QCOMPARE(backend->remotePlayCalls, 0);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("loading"));

        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"), QUrl(QStringLiteral("https://audio.example/direct.webm")));

        QCOMPARE(backend->remotePlayCalls, 1);
        QCOMPARE(backend->lastRemoteUrl, QUrl(QStringLiteral("https://audio.example/direct.webm")));
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
        QCOMPARE(controller->property("playbackQueueItemId").toString(), queueItemId);
        QCOMPARE(controller->property("coreStatus").toString(), QStringLiteral("Playing"));
    }

    void playsQueuedSabrTrackThroughStreamDevice() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, queueItemId)));
        provider->emitResolvedSabrStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QCOMPARE(backend->remotePlayCalls, 0);
        QCOMPARE(backend->streamDevicePlayCalls, 1);
        QCOMPARE(backend->lastStreamMimeType, QStringLiteral("audio/webm; codecs=\"opus\""));
        QVERIFY(backend->streamDeviceAlive);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
        QCOMPARE(controller->property("playbackQueueItemId").toString(), queueItemId);
    }

    void playsQueuedHeaderedTrackThroughBackendHeaderedUrl() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, queueItemId)));
        provider->emitResolvedHeaderedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QCOMPARE(backend->remotePlayCalls, 0);
        QCOMPARE(backend->streamDevicePlayCalls, 0);
        QCOMPARE(backend->headeredRemotePlayCalls, 1);
        QCOMPARE(backend->lastHeaderedRemoteUrl, QUrl(QStringLiteral("https://audio.example/headered.webm")));
        QCOMPARE(backend->lastHeaderedRemoteMimeType, QStringLiteral("audio/webm; codecs=\"opus\""));
        QCOMPARE(backend->lastHeaderedRemoteHeaders.size(), 1);
        QCOMPARE(backend->lastHeaderedRemoteHeaders.at(0).first, QByteArrayLiteral("X-Test-Download"));
        QCOMPARE(backend->lastHeaderedRemoteHeaders.at(0).second, QByteArrayLiteral("direct-secret"));
        QVERIFY(backend->headeredRemotePlaybackActive);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
        QCOMPARE(controller->property("playbackQueueItemId").toString(), queueItemId);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "seekPlayback", Q_ARG(qint64, 42000)));
        QCOMPARE(backend->seekCalls, 0);
        QCOMPARE(controller->property("coreStatus").toString(), QStringLiteral("Seek unavailable for this online stream."));
    }

    void sabrBackendFailureShowsFriendlyError() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        backend->failStreamDevicePlayback = true;
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, queueItemId)));

        provider->emitResolvedSabrStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QCOMPARE(backend->streamDevicePlayCalls, 1);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("error"));
        QCOMPARE(controller->property("playbackErrorMessage").toString(), QStringLiteral("Online stream playback unsupported on this platform."));
        QCOMPARE(controller->property("coreStatus").toString(), QStringLiteral("Online stream playback unsupported on this platform."));
    }

    void seekOnSabrStreamShowsUnavailableStatus() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, queueItemId)));
        provider->emitResolvedSabrStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "seekPlayback", Q_ARG(qint64, 42000)));

        QCOMPARE(backend->seekCalls, 0);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
        QCOMPARE(controller->property("coreStatus").toString(), QStringLiteral("Seek unavailable for this online stream."));
    }

    void stopCancelsActiveSabrStream() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, queueItemId)));
        provider->emitResolvedSabrStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));
        QVERIFY(backend->streamDeviceAlive);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "stopPlayback"));

        QCOMPARE(backend->stopCalls, 1);
        QVERIFY(!backend->streamDeviceAlive);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("stopped"));
    }

    void onlinePlaybackFailureShowsFriendlyError() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        const QString queueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, queueItemId)));
        provider->emitStreamFailure(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));

        QCOMPARE(backend->remotePlayCalls, 0);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("error"));
        QCOMPARE(controller->property("playbackErrorMessage").toString(), QStringLiteral("Online playback unavailable. Try another result."));
        QCOMPARE(controller->property("coreStatus").toString(), QStringLiteral("Online playback unavailable. Try another result."));
    }

    void ignoresStaleStreamResolution() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-beta"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-beta"),
                .title = QStringLiteral("Moon Door"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-beta"))));
        const QString firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        const QString secondQueueItemId = queue->data(queue->index(1, 0), queueIdRole).toString();

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, firstQueueItemId)));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, secondQueueItemId)));
        QCOMPARE(provider->resolveCalls, 2);

        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"), QUrl(QStringLiteral("https://audio.example/old.webm")));
        QCOMPARE(backend->remotePlayCalls, 0);
        QCOMPARE(controller->property("playbackQueueItemId").toString(), secondQueueItemId);

        provider->emitResolvedStream(QStringLiteral("ytmusic"), QStringLiteral("video-beta"), QUrl(QStringLiteral("https://audio.example/new.webm")));
        QCOMPARE(backend->remotePlayCalls, 1);
        QCOMPARE(backend->lastRemoteUrl, QUrl(QStringLiteral("https://audio.example/new.webm")));
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
    }

    void playNextStopsActiveStreamBeforeResolvingNextTrack() {
        FakeOnlineProvider* provider = nullptr;
        FakePlaybackBackend* backend = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider, &backend);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-beta"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-beta"),
                .title = QStringLiteral("Moon Door"),
            },
        };

        auto* queue = qobject_cast<QAbstractItemModel*>(controller->property("queueModel").value<QObject*>());
        QVERIFY(queue != nullptr);
        const int queueIdRole = roleForName(queue, "id");
        QVERIFY(queueIdRole > 0);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-alpha"))));
        QVERIFY(QMetaObject::invokeMethod(controller.get(), "addSearchResultToQueue", Q_ARG(QString, QStringLiteral("ytmusic:video-beta"))));
        const QString firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        const QString secondQueueItemId = queue->data(queue->index(1, 0), queueIdRole).toString();

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playQueueItem", Q_ARG(QString, firstQueueItemId)));
        provider->emitResolvedHeaderedStream(QStringLiteral("ytmusic"), QStringLiteral("video-alpha"));
        QVERIFY(backend->headeredRemotePlaybackActive);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "playNextQueuedTrack"));

        QCOMPARE(provider->resolveCalls, 2);
        QCOMPARE(provider->lastResolveTrackId, QStringLiteral("video-beta"));
        QCOMPARE(backend->stopCalls, 1);
        QVERIFY(!backend->headeredRemotePlaybackActive);
        QCOMPARE(controller->property("playbackQueueItemId").toString(), secondQueueItemId);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("loading"));

        provider->emitResolvedHeaderedStream(QStringLiteral("ytmusic"), QStringLiteral("video-beta"));

        QCOMPARE(backend->streamDevicePlayCalls, 0);
        QCOMPARE(backend->headeredRemotePlayCalls, 2);
        QVERIFY(backend->headeredRemotePlaybackActive);
        QCOMPARE(controller->property("playbackQueueItemId").toString(), secondQueueItemId);
        QCOMPARE(controller->property("playbackState").toString(), QStringLiteral("playing"));
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

    void playbackRecentsSeedRecommendationsAndClearListeningHistory() {
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
        auto* recents = qobject_cast<QAbstractItemModel*>(controller.property("recentTracksModel").value<QObject*>());
        auto* recommendations = qobject_cast<QAbstractItemModel*>(controller.property("recommendationsModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(queue != nullptr);
        QVERIFY(recents != nullptr);
        QVERIFY(recommendations != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));
        QCOMPARE(tracks->rowCount(), 2);
        QCOMPARE(recommendations->rowCount(), 0);

        const QString firstTrackId = roleValue(tracks, 0, "id").toString();
        QVERIFY(!firstTrackId.isEmpty());
        QVERIFY(QMetaObject::invokeMethod(&controller, "addTrackToQueue", Q_ARG(QString, firstTrackId)));
        QCOMPARE(queue->rowCount(), 1);

        const QString firstQueueItemId = roleValue(queue, 0, "id").toString();
        QVERIFY(QMetaObject::invokeMethod(&controller, "playQueueItem", Q_ARG(QString, firstQueueItemId)));
        QCOMPARE(fakeBackend->playCalls, 1);

        QCOMPARE(recents->rowCount(), 1);
        QCOMPARE(roleValue(recents, 0, "track_id").toString(), firstTrackId);
        QCOMPARE(roleValue(recents, 0, "title").toString(), QStringLiteral("alpha"));
        QCOMPARE(recommendations->rowCount(), 1);
        QVERIFY(roleValue(recommendations, 0, "track_id").toString() != firstTrackId);
        QCOMPARE(roleValue(recommendations, 0, "title").toString(), QStringLiteral("beta"));

        QVERIFY(QMetaObject::invokeMethod(&controller, "clearListeningHistory"));
        QCOMPARE(recents->rowCount(), 0);
        QCOMPARE(recommendations->rowCount(), 0);
    }

    void clearSearchHistoryRemovesStoredSuggestionsSeed() {
        FakeOnlineProvider* provider = nullptr;
        const std::unique_ptr<CoreController> controller = makeController(&provider);
        provider->nextResults = QVector<OnlineTrackResult>{
            OnlineTrackResult{
                .resultId = QStringLiteral("ytmusic:video-alpha"),
                .provider = QStringLiteral("ytmusic"),
                .providerTrackId = QStringLiteral("video-alpha"),
                .title = QStringLiteral("Stone Window"),
            },
        };

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "searchOnline", Q_ARG(QString, QStringLiteral("stone"))));
        QCOMPARE(searchHistoryCountForQuery(controller->property("databasePath").toString(), QStringLiteral("stone")), 1);

        QVERIFY(QMetaObject::invokeMethod(controller.get(), "clearSearchHistory"));
        QCOMPARE(searchHistoryCountForQuery(controller->property("databasePath").toString(), QStringLiteral("stone")), 0);
        QCOMPARE(controller->property("searchStatus").toString(), QStringLiteral("Ready"));
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
    auqw::tests::TestStorage storage(QStringLiteral("AuqwCoreControllerTest"));
    if (!storage.isValid()) {
        return 1;
    }

    QCoreApplication app(argc, argv);
    storage.applyApplicationMetadata();

    CoreControllerTest test;
    return QTest::qExec(&test, argc, argv);
}

#include "core_controller_test.moc"
