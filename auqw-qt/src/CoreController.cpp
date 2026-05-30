#include "CoreController.hpp"
#include "OnlineProvider.hpp"
#include "PlaybackBackend.hpp"
#include "YoutubeHttpAudioDevice.hpp"
#include "YoutubeSabrAudioDevice.hpp"

#include <QAbstractListModel>
#include <QCryptographicHash>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QJsonValue>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRandomGenerator>
#include <QSaveFile>
#include <QStandardPaths>
#include <QVariantMap>

#include <exception>
#include <string>
#include <utility>

class JsonListModel final : public QAbstractListModel {
public:
    explicit JsonListModel(QStringList roles)
        : roles_(std::move(roles)) {}

    [[nodiscard]] int rowCount(const QModelIndex& parent = {}) const override {
        return parent.isValid() ? 0 : static_cast<int>(items_.size());
    }

    [[nodiscard]] QVariant data(const QModelIndex& index, int role) const override {
        if (!index.isValid() || index.row() < 0 || index.row() >= items_.size()) {
            return {};
        }

        const int roleIndex = role - Qt::UserRole - 1;
        if (roleIndex < 0 || roleIndex >= roles_.size()) {
            return {};
        }

        const QVariant value = items_.at(index.row()).value(roles_.at(roleIndex));
        return value.isNull() ? QString{} : value;
    }

    [[nodiscard]] QHash<int, QByteArray> roleNames() const override {
        QHash<int, QByteArray> names;
        for (int i = 0; i < roles_.size(); ++i) {
            names.insert(Qt::UserRole + 1 + i, roles_.at(i).toUtf8());
        }
        return names;
    }

    void setItems(QVector<QVariantMap> items) {
        beginResetModel();
        items_ = std::move(items);
        endResetModel();
    }

    [[nodiscard]] QVariantMap itemAt(int row) const {
        if (row < 0 || row >= items_.size()) {
            return {};
        }
        return items_.at(row);
    }

private:
    QStringList roles_;
    QVector<QVariantMap> items_;
};

struct CoreController::CommandResult {
    bool ok = false;
    QJsonObject data;
    QString error;
};

namespace {

QVector<QVariantMap> mapsFromArray(const QJsonArray& array) {
    QVector<QVariantMap> items;
    items.reserve(array.size());

    for (const QJsonValue& value : array) {
        if (value.isObject()) {
            items.push_back(value.toObject().toVariantMap());
        }
    }

    return items;
}

QVector<QVariantMap> mapsWithAliasFromArray(
    const QJsonArray& array,
    const QString& aliasRole,
    const QString& sourceRole) {
    QVector<QVariantMap> items = mapsFromArray(array);
    for (QVariantMap& item : items) {
        item.insert(aliasRole, item.value(sourceRole));
    }
    return items;
}

QString errorMessageFromResponse(const QJsonObject& root) {
    const QJsonObject error = root.value(QStringLiteral("error")).toObject();
    const QString code = error.value(QStringLiteral("code")).toString();
    const QString message = error.value(QStringLiteral("message")).toString();

    if (!code.isEmpty() && !message.isEmpty()) {
        return QStringLiteral("%1: %2").arg(code, message);
    }
    if (!message.isEmpty()) {
        return message;
    }
    if (!code.isEmpty()) {
        return code;
    }
    return QStringLiteral("unknown core error");
}

bool isSupportedAudioFile(const QFileInfo& fileInfo) {
    const QString suffix = fileInfo.suffix().toLower();
    return suffix == QStringLiteral("mp3")
        || suffix == QStringLiteral("flac")
        || suffix == QStringLiteral("wav")
        || suffix == QStringLiteral("m4a")
        || suffix == QStringLiteral("aac")
        || suffix == QStringLiteral("ogg")
        || suffix == QStringLiteral("opus")
        || suffix == QStringLiteral("aiff")
        || suffix == QStringLiteral("aif");
}

QString normalizedArtworkSuffix(QString suffix) {
    suffix = suffix.toLower();
    if (suffix == QStringLiteral("jpeg")) {
        return QStringLiteral("jpg");
    }
    if (suffix == QStringLiteral("jpg")
        || suffix == QStringLiteral("png")
        || suffix == QStringLiteral("webp")
        || suffix == QStringLiteral("gif")
        || suffix == QStringLiteral("bmp")
        || suffix == QStringLiteral("avif")
        || suffix == QStringLiteral("heic")
        || suffix == QStringLiteral("svg")) {
        return suffix;
    }
    return QStringLiteral("img");
}

QString artworkSuffixFromUrl(const QUrl& url) {
    return normalizedArtworkSuffix(QFileInfo(url.path()).suffix());
}

QString artworkSuffixFromContentType(const QString& contentType, const QString& fallback) {
    const QString normalized = contentType.toLower();
    if (normalized.contains(QStringLiteral("jpeg")) || normalized.contains(QStringLiteral("jpg"))) {
        return QStringLiteral("jpg");
    }
    if (normalized.contains(QStringLiteral("png"))) {
        return QStringLiteral("png");
    }
    if (normalized.contains(QStringLiteral("webp"))) {
        return QStringLiteral("webp");
    }
    if (normalized.contains(QStringLiteral("gif"))) {
        return QStringLiteral("gif");
    }
    if (normalized.contains(QStringLiteral("bmp"))) {
        return QStringLiteral("bmp");
    }
    if (normalized.contains(QStringLiteral("avif"))) {
        return QStringLiteral("avif");
    }
    if (normalized.contains(QStringLiteral("svg"))) {
        return QStringLiteral("svg");
    }
    return normalizedArtworkSuffix(fallback);
}

QString artworkCacheRoot() {
    return QDir(QStandardPaths::writableLocation(QStandardPaths::CacheLocation)).filePath(QStringLiteral("artwork"));
}

QString artworkCachePathForSource(const QString& sourceUrl, const QString& suffix) {
    const QByteArray digest = QCryptographicHash::hash(sourceUrl.toUtf8(), QCryptographicHash::Sha256).toHex();
    return QDir(artworkCacheRoot()).filePath(QString::fromLatin1(digest.left(32)) + QLatin1Char('.') + normalizedArtworkSuffix(suffix));
}

bool ensureParentDirectory(const QString& path) {
    return QDir().mkpath(QFileInfo(path).absolutePath());
}

bool replaceFileWithBytes(const QString& path, const QByteArray& bytes) {
    if (bytes.isEmpty() || !ensureParentDirectory(path)) {
        return false;
    }

    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        return false;
    }
    if (file.write(bytes) != bytes.size()) {
        return false;
    }
    return file.commit();
}

bool copyFileReplacing(const QString& sourcePath, const QString& cachePath) {
    if (!ensureParentDirectory(cachePath)) {
        return false;
    }
    if (QFileInfo::exists(cachePath)) {
        QFile::remove(cachePath);
    }
    return QFile::copy(sourcePath, cachePath);
}

} // namespace

CoreController::CoreController(QObject* parent)
    : CoreController(createDefaultPlaybackBackend(), createDefaultOnlineProvider(), parent) {}

CoreController::CoreController(std::unique_ptr<PlaybackBackend> playbackBackend, QObject* parent)
    : CoreController(std::move(playbackBackend), createDefaultOnlineProvider(), parent) {}

CoreController::CoreController(
    std::unique_ptr<PlaybackBackend> playbackBackend,
    std::unique_ptr<OnlineProvider> onlineProvider,
    QObject* parent)
    : QObject(parent),
      playbackBackend_(std::move(playbackBackend)),
      onlineProvider_(std::move(onlineProvider)),
      tracksModel_(std::make_unique<JsonListModel>(QStringList{
          QStringLiteral("id"),
          QStringLiteral("track_id"),
          QStringLiteral("provider"),
          QStringLiteral("provider_track_id"),
          QStringLiteral("title"),
          QStringLiteral("artist"),
          QStringLiteral("album"),
          QStringLiteral("duration_ms"),
          QStringLiteral("artwork_url"),
          QStringLiteral("metadata_cached_at"),
          QStringLiteral("created_at"),
          QStringLiteral("updated_at"),
      })),
      playlistsModel_(std::make_unique<JsonListModel>(QStringList{
          QStringLiteral("id"),
          QStringLiteral("name"),
          QStringLiteral("created_at"),
          QStringLiteral("updated_at"),
      })),
      queueModel_(std::make_unique<JsonListModel>(QStringList{
          QStringLiteral("id"),
          QStringLiteral("queue_item_id"),
          QStringLiteral("track_id"),
          QStringLiteral("position"),
          QStringLiteral("added_at"),
          QStringLiteral("provider"),
          QStringLiteral("provider_track_id"),
          QStringLiteral("title"),
          QStringLiteral("artist"),
          QStringLiteral("album"),
          QStringLiteral("duration_ms"),
          QStringLiteral("artwork_url"),
          QStringLiteral("local_path"),
      })),
      downloadsModel_(std::make_unique<JsonListModel>(QStringList{
          QStringLiteral("id"),
          QStringLiteral("download_id"),
          QStringLiteral("track_id"),
          QStringLiteral("state"),
          QStringLiteral("progress"),
          QStringLiteral("error_text"),
          QStringLiteral("target_path"),
          QStringLiteral("created_at"),
          QStringLiteral("updated_at"),
          QStringLiteral("provider"),
          QStringLiteral("provider_track_id"),
          QStringLiteral("title"),
          QStringLiteral("artist"),
          QStringLiteral("album"),
          QStringLiteral("duration_ms"),
          QStringLiteral("artwork_url"),
      })),
      searchResultsModel_(std::make_unique<JsonListModel>(QStringList{
          QStringLiteral("result_id"),
          QStringLiteral("provider"),
          QStringLiteral("provider_track_id"),
          QStringLiteral("title"),
          QStringLiteral("artist"),
          QStringLiteral("album"),
          QStringLiteral("duration_ms"),
          QStringLiteral("artwork_url"),
      })),
      searchSuggestionsModel_(std::make_unique<JsonListModel>(QStringList{
          QStringLiteral("provider"),
          QStringLiteral("text"),
      })),
      coreStatus_(QStringLiteral("Starting")),
      importStatus_(QStringLiteral("Import a folder")) {
    if (!playbackBackend_) {
        playbackBackend_ = createDefaultPlaybackBackend();
    }
    if (!onlineProvider_) {
        onlineProvider_ = createDefaultOnlineProvider();
    }
    configurePlaybackBackend();
    configureOnlineProvider();

    try {
        auqw::InitOptions options;
        const QString dataDir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
        const QString cacheDir = QStandardPaths::writableLocation(QStandardPaths::CacheLocation);

        if (!dataDir.isEmpty()) {
            QDir().mkpath(dataDir);
            options.dataDir = dataDir.toStdString();
        }
        if (!cacheDir.isEmpty()) {
            QDir().mkpath(cacheDir);
            options.cacheDir = cacheDir.toStdString();
        }

        core_.emplace(options);
        helloText_ = QString::fromStdString(core_->helloText());
        loadInitialState();
    } catch (const std::exception& error) {
        helloText_ = QStringLiteral("Auqw Core unavailable");
        coreStatus_ = QStringLiteral("Core unavailable: %1").arg(QString::fromLocal8Bit(error.what()));
    }
}

CoreController::~CoreController() = default;

QString CoreController::helloText() const {
    return helloText_;
}

QString CoreController::appName() const {
    return appName_;
}

QString CoreController::appId() const {
    return appId_;
}

QString CoreController::databasePath() const {
    return databasePath_;
}

int CoreController::schemaVersion() const {
    return schemaVersion_;
}

QString CoreController::coreStatus() const {
    return coreStatus_;
}

QAbstractItemModel* CoreController::tracksModel() const {
    return tracksModel_.get();
}

QAbstractItemModel* CoreController::playlistsModel() const {
    return playlistsModel_.get();
}

QAbstractItemModel* CoreController::queueModel() const {
    return queueModel_.get();
}

QAbstractItemModel* CoreController::downloadsModel() const {
    return downloadsModel_.get();
}

QAbstractItemModel* CoreController::searchResultsModel() const {
    return searchResultsModel_.get();
}

QAbstractItemModel* CoreController::searchSuggestionsModel() const {
    return searchSuggestionsModel_.get();
}

QString CoreController::themeSetting() const {
    return themeSetting_;
}

QString CoreController::importStatus() const {
    return importStatus_;
}

int CoreController::importedTrackCount() const {
    return importedTrackCount_;
}

QString CoreController::searchStatus() const {
    return searchStatus_;
}

QString CoreController::searchErrorMessage() const {
    return searchErrorMessage_;
}

QString CoreController::downloadStatus() const {
    return downloadStatus_;
}

QString CoreController::downloadDirectory() const {
    return downloadDirectory_;
}

QString CoreController::playbackState() const {
    return playbackState_;
}

QString CoreController::playbackQueueItemId() const {
    return playbackQueueItemId_;
}

QString CoreController::playbackTrackId() const {
    return playbackTrackId_;
}

QString CoreController::playbackTitle() const {
    return playbackTitle_;
}

QString CoreController::playbackArtist() const {
    return playbackArtist_;
}

QString CoreController::playbackAlbum() const {
    return playbackAlbum_;
}

QString CoreController::playbackArtworkUrl() const {
    return playbackArtworkUrl_;
}

QString CoreController::playbackLocalPath() const {
    return playbackLocalPath_;
}

qint64 CoreController::playbackPositionMs() const {
    return playbackPositionMs_;
}

qint64 CoreController::playbackDurationMs() const {
    return playbackDurationMs_;
}

QString CoreController::playbackErrorMessage() const {
    return playbackErrorMessage_;
}

QString CoreController::repeatMode() const {
    return repeatMode_;
}

bool CoreController::shuffleEnabled() const {
    return shuffleEnabled_;
}

void CoreController::setThemeSetting(const QString& value) {
    const CommandResult result = invokeCommand(
        QStringLiteral("settings.set.theme"),
        QStringLiteral("settings.set"),
        QJsonObject{
            {QStringLiteral("key"), QStringLiteral("theme")},
            {QStringLiteral("value"), value},
        });

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    const QJsonObject setting = result.data.value(QStringLiteral("setting")).toObject();
    setThemeSettingFromCore(setting.value(QStringLiteral("value")).toString());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::importLocalFolder(const QUrl& folderUrl) {
    const QString folderPath = folderUrl.toLocalFile();
    const QFileInfo folderInfo(folderPath);
    if (folderPath.isEmpty() || !folderInfo.exists() || !folderInfo.isDir()) {
        setImportResult(QStringLiteral("No audio files found"), 0);
        return;
    }

    int imported = 0;
    QDirIterator iterator(
        folderInfo.absoluteFilePath(),
        QDir::Files | QDir::NoDotAndDotDot | QDir::Readable,
        QDirIterator::Subdirectories);

    while (iterator.hasNext()) {
        const QFileInfo fileInfo(iterator.next());
        if (!isSupportedAudioFile(fileInfo)) {
            continue;
        }

        const QString title = fileInfo.completeBaseName();
        const CommandResult result = invokeCommand(
            QStringLiteral("local_files.upsert"),
            QStringLiteral("local_files.upsert"),
            QJsonObject{
                {QStringLiteral("path"), fileInfo.absoluteFilePath()},
                {QStringLiteral("title"), title},
            });

        if (!result.ok) {
            setImportResult(result.error, imported);
            refreshState();
            return;
        }

        ++imported;
    }

    refreshState();

    if (imported == 0) {
        setImportResult(QStringLiteral("No audio files found"), 0);
        return;
    }

    setImportResult(QStringLiteral("Imported %1 tracks").arg(imported), imported);
}

void CoreController::searchOnline(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    activeSearchQuery_ = trimmedQuery;
    activeSuggestionQuery_.clear();
    if (trimmedQuery.isEmpty()) {
        applySearchResults({});
        applySearchSuggestions({});
        setSearchState(QStringLiteral("Idle"), {});
        return;
    }

    if (!onlineProvider_) {
        applySearchResults({});
        setSearchState(QStringLiteral("Error"), QStringLiteral("Search unavailable. Try again."));
        return;
    }

    applySearchResults({});
    applySearchSuggestions({});
    setSearchState(QStringLiteral("Searching"), {});
    onlineProvider_->searchTracks(trimmedQuery);
}

void CoreController::suggestOnline(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    activeSuggestionQuery_ = trimmedQuery;
    if (trimmedQuery.isEmpty()) {
        applySearchSuggestions({});
        return;
    }

    if (!onlineProvider_) {
        applySearchSuggestions({});
        return;
    }

    onlineProvider_->suggestTracks(trimmedQuery);
}

void CoreController::acceptSearchSuggestion(const QString& suggestion) {
    const QString trimmedSuggestion = suggestion.trimmed();
    activeSuggestionQuery_.clear();
    applySearchSuggestions({});
    if (trimmedSuggestion.isEmpty()) {
        return;
    }

    searchOnline(trimmedSuggestion);
}

void CoreController::addSearchResultToQueue(const QString& resultId) {
    const std::optional<OnlineTrackResult> result = searchResultById(resultId);
    if (!result.has_value()) {
        setCoreStatus(QStringLiteral("Search result unavailable"));
        return;
    }

    QJsonObject params{
        {QStringLiteral("provider"), result->provider},
        {QStringLiteral("provider_track_id"), result->providerTrackId},
        {QStringLiteral("title"), result->title},
    };
    if (!result->artist.isEmpty()) {
        params.insert(QStringLiteral("artist"), result->artist);
    }
    if (!result->album.isEmpty()) {
        params.insert(QStringLiteral("album"), result->album);
    }
    if (result->durationMs > 0) {
        params.insert(QStringLiteral("duration_ms"), result->durationMs);
    }
    if (!result->artworkUrl.isEmpty()) {
        params.insert(QStringLiteral("artwork_url"), result->artworkUrl);
    }

    const CommandResult upsert = invokeCommand(
        QStringLiteral("tracks.upsert.online"),
        QStringLiteral("tracks.upsert"),
        params);
    if (!upsert.ok) {
        setCoreStatus(upsert.error);
        return;
    }

    const QString trackId = upsert.data.value(QStringLiteral("track")).toObject().value(QStringLiteral("id")).toString();
    cacheArtworkForTrack(trackId, result->artworkUrl);
    addTrackToQueue(trackId);
    refreshTracksFromCore();
}

void CoreController::downloadSearchResult(const QString& resultId) {
    const std::optional<OnlineTrackResult> result = searchResultById(resultId);
    if (!result.has_value()) {
        setDownloadStatus(QStringLiteral("Search result unavailable"));
        return;
    }

    if (!downloadsSupportedForProvider(result->provider)) {
        setDownloadStatus(QStringLiteral("Downloads unavailable for this provider."));
        return;
    }

    QJsonObject params{
        {QStringLiteral("provider"), result->provider},
        {QStringLiteral("provider_track_id"), result->providerTrackId},
        {QStringLiteral("title"), result->title},
    };
    if (!result->artist.isEmpty()) {
        params.insert(QStringLiteral("artist"), result->artist);
    }
    if (!result->album.isEmpty()) {
        params.insert(QStringLiteral("album"), result->album);
    }
    if (result->durationMs > 0) {
        params.insert(QStringLiteral("duration_ms"), result->durationMs);
    }
    if (!result->artworkUrl.isEmpty()) {
        params.insert(QStringLiteral("artwork_url"), result->artworkUrl);
    }

    const CommandResult upsert = invokeCommand(
        QStringLiteral("tracks.upsert.download"),
        QStringLiteral("tracks.upsert"),
        params);
    if (!upsert.ok) {
        setDownloadStatus(upsert.error);
        return;
    }

    const QString trackId = upsert.data.value(QStringLiteral("track")).toObject().value(QStringLiteral("id")).toString();
    cacheArtworkForTrack(trackId, result->artworkUrl);
    if (queueDownloadForTrack(trackId, result->provider, result->providerTrackId, result->title)) {
        refreshTracksFromCore();
    }
}

void CoreController::addTrackToQueue(const QString& trackId) {
    if (trackId.isEmpty()) {
        setCoreStatus(QStringLiteral("Track unavailable"));
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("queue.add"),
        QStringLiteral("queue.add"),
        QJsonObject{{QStringLiteral("track_id"), trackId}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    if (refreshQueueFromCore()) {
        setCoreStatus(QStringLiteral("Ready"));
    }
}

void CoreController::downloadTrack(const QString& trackId) {
    const QVariantMap track = trackById(trackId);
    if (track.isEmpty()) {
        setDownloadStatus(QStringLiteral("Track unavailable"));
        return;
    }

    const QString provider = track.value(QStringLiteral("provider")).toString();
    const QString providerTrackId = track.value(QStringLiteral("provider_track_id")).toString();
    const QString title = track.value(QStringLiteral("title")).toString();
    if (!downloadsSupportedForProvider(provider)) {
        setDownloadStatus(QStringLiteral("Downloads unavailable for this provider."));
        return;
    }

    queueDownloadForTrack(trackId, provider, providerTrackId, title);
}

void CoreController::removeDownload(const QString& downloadId) {
    if (downloadId.isEmpty()) {
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("downloads.remove"),
        QStringLiteral("downloads.remove"),
        QJsonObject{{QStringLiteral("id"), downloadId}});
    if (!result.ok) {
        setDownloadStatus(result.error);
        return;
    }

    const QString targetPath = result.data.value(QStringLiteral("download")).toObject().value(QStringLiteral("target_path")).toString();
    if (!targetPath.isEmpty() && QFileInfo::exists(targetPath)) {
        QFile::remove(targetPath);
    }

    refreshDownloadsFromCore();
    setDownloadStatus(QStringLiteral("Download removed"));
}

void CoreController::setDownloadDirectory(const QString& path) {
    const QString trimmedPath = path.trimmed();
    if (trimmedPath.isEmpty()) {
        setDownloadStatus(QStringLiteral("Download folder unavailable"));
        return;
    }

    QDir dir(trimmedPath);
    if (!dir.exists() && !dir.mkpath(QStringLiteral("."))) {
        setDownloadStatus(QStringLiteral("Download folder unavailable"));
        return;
    }

    const QString absolutePath = QFileInfo(dir.absolutePath()).absoluteFilePath();
    const CommandResult result = invokeCommand(
        QStringLiteral("settings.set.storage.download_dir"),
        QStringLiteral("settings.set"),
        QJsonObject{
            {QStringLiteral("key"), QStringLiteral("storage.download_dir")},
            {QStringLiteral("value"), absolutePath},
        });
    if (!result.ok) {
        setDownloadStatus(result.error);
        return;
    }

    setDownloadDirectoryFromCore(absolutePath);
    setDownloadStatus(QStringLiteral("Download folder saved"));
}

void CoreController::removeQueueItem(const QString& queueItemId) {
    if (queueItemId.isEmpty()) {
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("queue.remove"),
        QStringLiteral("queue.remove"),
        QJsonObject{{QStringLiteral("id"), queueItemId}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyQueueItems(result.data.value(QStringLiteral("items")).toArray());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::moveQueueItem(const QString& queueItemId, int toIndex) {
    if (queueItemId.isEmpty()) {
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("queue.move"),
        QStringLiteral("queue.move"),
        QJsonObject{
            {QStringLiteral("id"), queueItemId},
            {QStringLiteral("to_index"), toIndex},
        });

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyQueueItems(result.data.value(QStringLiteral("items")).toArray());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::clearQueue() {
    const CommandResult result = invokeCommand(
        QStringLiteral("queue.clear"),
        QStringLiteral("queue.clear"));

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyQueueItems(result.data.value(QStringLiteral("items")).toArray());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::playQueueItem(const QString& queueItemId) {
    if (queueItemId.isEmpty()) {
        setCoreStatus(QStringLiteral("Queue item unavailable"));
        return;
    }

    const bool hadActivePlayback = playbackState_ == QStringLiteral("playing")
        || playbackState_ == QStringLiteral("paused")
        || playbackState_ == QStringLiteral("loading");
    const bool hadActiveStreamPlayback = sabrPlaybackActive_;
    const int targetQueueIndex = queueIndexForItem(queueItemId);
    const QVariantMap targetQueueItem = targetQueueIndex >= 0 ? queueModel_->itemAt(targetQueueIndex) : QVariantMap{};
    const bool targetNeedsStreamResolve = targetQueueItem.value(QStringLiteral("local_path")).toString().isEmpty()
        && !targetQueueItem.value(QStringLiteral("provider")).toString().isEmpty()
        && !targetQueueItem.value(QStringLiteral("provider_track_id")).toString().isEmpty();
    clearPendingStreamResolve();
    stopActivePlaybackBeforeLoad(hadActiveStreamPlayback || (targetNeedsStreamResolve && hadActivePlayback));

    const CommandResult result = invokeCommand(
        QStringLiteral("playback.load_queue_item"),
        QStringLiteral("playback.load_queue_item"),
        QJsonObject{{QStringLiteral("id"), queueItemId}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackObject(result.data.value(QStringLiteral("playback")).toObject());
    if (!playbackLocalPath_.isEmpty()) {
        setCoreStatus(QStringLiteral("Loading playback"));
        playbackBackend_->playLocalFile(playbackLocalPath_);
        return;
    }

    const QJsonObject item = result.data.value(QStringLiteral("item")).toObject();
    const QString provider = item.value(QStringLiteral("provider")).toString();
    const QString providerTrackId = item.value(QStringLiteral("provider_track_id")).toString();
    if (!provider.isEmpty() && !providerTrackId.isEmpty() && onlineProvider_) {
        pendingStreamQueueItemId_ = queueItemId;
        pendingStreamProvider_ = provider;
        pendingStreamProviderTrackId_ = providerTrackId;
        setCoreStatus(QStringLiteral("Loading playback"));
        onlineProvider_->resolveStream(provider, providerTrackId);
        return;
    }

    clearPendingStreamResolve();
    setCoreStatus(playbackErrorMessage_.isEmpty() ? QStringLiteral("Playback unsupported") : playbackErrorMessage_);
}

void CoreController::playFirstQueuedTrack() {
    const QVariantMap first = queueModel_->itemAt(0);
    const QString queueItemId = first.value(QStringLiteral("id")).toString();
    if (queueItemId.isEmpty()) {
        setCoreStatus(QStringLiteral("Queue empty"));
        return;
    }
    playQueueItem(queueItemId);
}

void CoreController::playNextQueuedTrack() {
    const int count = queueModel_->rowCount();
    if (count <= 0) {
        setCoreStatus(QStringLiteral("Queue empty"));
        return;
    }

    const int currentIndex = queueIndexForItem(playbackQueueItemId_);
    if (repeatMode_ == QStringLiteral("one") && !playbackQueueItemId_.isEmpty()) {
        playQueueItem(playbackQueueItemId_);
        return;
    }

    if (shuffleEnabled_ && count > 1) {
        int nextIndex = QRandomGenerator::global()->bounded(currentIndex >= 0 ? count - 1 : count);
        if (currentIndex >= 0 && nextIndex >= currentIndex) {
            ++nextIndex;
        }
        playQueueItem(queueItemIdAt(nextIndex));
        return;
    }

    if (currentIndex < 0) {
        playQueueItem(queueItemIdAt(0));
        return;
    }

    int nextIndex = currentIndex + 1;
    if (nextIndex >= count) {
        if (repeatMode_ == QStringLiteral("all")) {
            nextIndex = 0;
        } else {
            setCoreStatus(QStringLiteral("Queue ended"));
            return;
        }
    }

    playQueueItem(queueItemIdAt(nextIndex));
}

void CoreController::playPreviousQueuedTrack() {
    const int count = queueModel_->rowCount();
    if (count <= 0) {
        setCoreStatus(QStringLiteral("Queue empty"));
        return;
    }

    const int currentIndex = queueIndexForItem(playbackQueueItemId_);
    if (currentIndex < 0) {
        playQueueItem(queueItemIdAt(0));
        return;
    }

    int previousIndex = currentIndex - 1;
    if (previousIndex < 0) {
        if (repeatMode_ == QStringLiteral("all")) {
            previousIndex = count - 1;
        } else {
            previousIndex = 0;
        }
    }

    playQueueItem(queueItemIdAt(previousIndex));
}

void CoreController::pausePlayback() {
    playbackBackend_->pause();
}

void CoreController::resumePlayback() {
    playbackBackend_->resume();
}

void CoreController::stopPlayback() {
    stopRequested_ = true;
    clearPendingStreamResolve();
    sabrPlaybackActive_ = false;
    playbackBackend_->stop();
}

void CoreController::seekPlayback(qint64 positionMs) {
    if (sabrPlaybackActive_) {
        setCoreStatus(QStringLiteral("Seek unavailable for this online stream."));
        return;
    }
    playbackBackend_->seek(positionMs);
}

void CoreController::toggleRepeatMode() {
    const QString nextMode = repeatMode_ == QStringLiteral("off")
        ? QStringLiteral("one")
        : repeatMode_ == QStringLiteral("one")
            ? QStringLiteral("all")
            : QStringLiteral("off");

    const CommandResult result = invokeCommand(
        QStringLiteral("playback.options.update.repeat"),
        QStringLiteral("playback.options.update"),
        QJsonObject{{QStringLiteral("repeat_mode"), nextMode}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackOptionsObject(result.data.value(QStringLiteral("options")).toObject());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::toggleShuffle() {
    const CommandResult result = invokeCommand(
        QStringLiteral("playback.options.update.shuffle"),
        QStringLiteral("playback.options.update"),
        QJsonObject{{QStringLiteral("shuffle_enabled"), !shuffleEnabled_}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackOptionsObject(result.data.value(QStringLiteral("options")).toObject());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::refreshState() {
    loadInitialState();
}

CoreController::CommandResult CoreController::invokeCommand(
    const QString& id,
    const QString& command,
    const QJsonObject& params) const {
    if (!core_.has_value()) {
        return {.ok = false, .error = QStringLiteral("Core unavailable")};
    }

    const QJsonObject request{
        {QStringLiteral("id"), id},
        {QStringLiteral("command"), command},
        {QStringLiteral("params"), params},
    };
    const QByteArray requestBytes = QJsonDocument(request).toJson(QJsonDocument::Compact);

    try {
        const std::string response = core_->invokeJson(
            std::string(requestBytes.constData(), static_cast<size_t>(requestBytes.size())));
        const QByteArray responseBytes(response.data(), static_cast<qsizetype>(response.size()));

        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(responseBytes, &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
            return {
                .ok = false,
                .error = QStringLiteral("Invalid core response: %1").arg(parseError.errorString()),
            };
        }

        const QJsonObject root = document.object();
        if (!root.value(QStringLiteral("ok")).toBool(false)) {
            return {.ok = false, .error = errorMessageFromResponse(root)};
        }

        return {.ok = true, .data = root.value(QStringLiteral("data")).toObject()};
    } catch (const std::exception& error) {
        return {
            .ok = false,
            .error = QStringLiteral("Core command failed: %1").arg(QString::fromLocal8Bit(error.what())),
        };
    }
}

void CoreController::loadInitialState() {
    const CommandResult metadata = invokeCommand(
        QStringLiteral("metadata"),
        QStringLiteral("core.get_metadata"));
    if (!metadata.ok) {
        setCoreStatus(metadata.error);
        return;
    }

    appName_ = metadata.data.value(QStringLiteral("app_name")).toString();
    appId_ = metadata.data.value(QStringLiteral("app_id")).toString();
    databasePath_ = metadata.data.value(QStringLiteral("database_path")).toString();
    schemaVersion_ = metadata.data.value(QStringLiteral("schema_version")).toInt();
    emit metadataChanged();

    if (!refreshTracksFromCore()) {
        return;
    }

    const CommandResult playlists = invokeCommand(
        QStringLiteral("playlists.list"),
        QStringLiteral("playlists.list"));
    if (!playlists.ok) {
        setCoreStatus(playlists.error);
        return;
    }
    playlistsModel_->setItems(mapsFromArray(playlists.data.value(QStringLiteral("playlists")).toArray()));

    if (!refreshQueueFromCore()) {
        return;
    }

    if (!refreshDownloadsFromCore()) {
        return;
    }

    if (!refreshPlaybackFromCore()) {
        return;
    }

    if (!refreshPlaybackOptionsFromCore()) {
        return;
    }

    const CommandResult theme = invokeCommand(
        QStringLiteral("settings.get.theme"),
        QStringLiteral("settings.get"),
        QJsonObject{{QStringLiteral("key"), QStringLiteral("theme")}});
    if (!theme.ok) {
        setCoreStatus(theme.error);
        return;
    }

    const QJsonObject setting = theme.data.value(QStringLiteral("setting")).toObject();
    setThemeSettingFromCore(setting.value(QStringLiteral("value")).toString());

    const CommandResult storage = invokeCommand(
        QStringLiteral("settings.get.storage.download_dir"),
        QStringLiteral("settings.get"),
        QJsonObject{{QStringLiteral("key"), QStringLiteral("storage.download_dir")}});
    if (!storage.ok) {
        setCoreStatus(storage.error);
        return;
    }
    const QString storedDownloadDirectory = storage.data.value(QStringLiteral("setting")).toObject().value(QStringLiteral("value")).toString();
    setDownloadDirectoryFromCore(storedDownloadDirectory.isEmpty() ? defaultDownloadDirectory() : storedDownloadDirectory);
    setCoreStatus(QStringLiteral("Ready"));
}

bool CoreController::refreshQueueFromCore() {
    const CommandResult queue = invokeCommand(
        QStringLiteral("queue.list"),
        QStringLiteral("queue.list"));
    if (!queue.ok) {
        setCoreStatus(queue.error);
        return false;
    }

    applyQueueItems(queue.data.value(QStringLiteral("items")).toArray());
    return true;
}

bool CoreController::refreshDownloadsFromCore() {
    const CommandResult downloads = invokeCommand(
        QStringLiteral("downloads.list"),
        QStringLiteral("downloads.list"));
    if (!downloads.ok) {
        setCoreStatus(downloads.error);
        return false;
    }

    applyDownloads(downloads.data.value(QStringLiteral("downloads")).toArray());
    return true;
}

bool CoreController::refreshTracksFromCore() {
    const CommandResult tracks = invokeCommand(
        QStringLiteral("tracks.list"),
        QStringLiteral("tracks.list"));
    if (!tracks.ok) {
        setCoreStatus(tracks.error);
        return false;
    }

    tracksModel_->setItems(mapsWithAliasFromArray(
        tracks.data.value(QStringLiteral("tracks")).toArray(),
        QStringLiteral("track_id"),
        QStringLiteral("id")));
    return true;
}

bool CoreController::refreshPlaybackFromCore() {
    const CommandResult playback = invokeCommand(
        QStringLiteral("playback.get"),
        QStringLiteral("playback.get"));
    if (!playback.ok) {
        setCoreStatus(playback.error);
        return false;
    }

    applyPlaybackObject(playback.data.value(QStringLiteral("playback")).toObject());
    return true;
}

bool CoreController::refreshPlaybackOptionsFromCore() {
    const CommandResult options = invokeCommand(
        QStringLiteral("playback.options.get"),
        QStringLiteral("playback.options.get"));
    if (!options.ok) {
        setCoreStatus(options.error);
        return false;
    }

    applyPlaybackOptionsObject(options.data.value(QStringLiteral("options")).toObject());
    return true;
}

void CoreController::setCoreStatus(const QString& status) {
    if (coreStatus_ == status) {
        return;
    }

    coreStatus_ = status;
    emit coreStatusChanged();
}

void CoreController::setThemeSettingFromCore(const QString& value) {
    if (themeSetting_ == value) {
        return;
    }

    themeSetting_ = value;
    emit themeSettingChanged();
}

void CoreController::setImportResult(const QString& status, int importedTrackCount) {
    if (importStatus_ == status && importedTrackCount_ == importedTrackCount) {
        return;
    }

    importStatus_ = status;
    importedTrackCount_ = importedTrackCount;
    emit importStatusChanged();
}

void CoreController::setDownloadStatus(const QString& status) {
    if (downloadStatus_ == status) {
        return;
    }

    downloadStatus_ = status;
    emit downloadStateChanged();
}

void CoreController::setDownloadDirectoryFromCore(const QString& path) {
    if (downloadDirectory_ == path) {
        return;
    }

    downloadDirectory_ = path;
    emit downloadDirectoryChanged();
}

void CoreController::configurePlaybackBackend() {
    playbackBackend_->setStateChangedCallback([this](const PlaybackBackendState& state) {
        updatePlaybackFromBackend(state.state, state.positionMs, state.durationMs);
    });
    playbackBackend_->setErrorCallback([this](const QString& message) {
        updatePlaybackFromBackend(QStringLiteral("error"), std::nullopt, std::nullopt, message);
    });
}

void CoreController::configureOnlineProvider() {
    connect(onlineProvider_.get(), &OnlineProvider::searchSucceeded, this, [this](const QString& query, const QVector<OnlineTrackResult>& results) {
        if (query != activeSearchQuery_) {
            return;
        }

        applySearchResults(results);
        if (!query.isEmpty() && !results.isEmpty()) {
            recordSearchHistory(query);
        }
        setSearchState(results.isEmpty() ? QStringLiteral("No results") : QStringLiteral("Ready"), {});
    });

    connect(onlineProvider_.get(), &OnlineProvider::searchFailed, this, [this](const QString& query, const QString&) {
        if (query != activeSearchQuery_) {
            return;
        }

        applySearchResults({});
        setSearchState(QStringLiteral("Error"), QStringLiteral("Search unavailable. Try again."));
    });

    connect(onlineProvider_.get(), &OnlineProvider::suggestionsSucceeded, this, [this](const QString& query, const QVector<OnlineSuggestionResult>& suggestions) {
        if (query != activeSuggestionQuery_) {
            return;
        }

        applySearchSuggestions(suggestions);
    });

    connect(onlineProvider_.get(), &OnlineProvider::suggestionsFailed, this, [this](const QString& query, const QString&) {
        if (query != activeSuggestionQuery_) {
            return;
        }

        applySearchSuggestions({});
    });

    connect(onlineProvider_.get(), &OnlineProvider::streamResolved, this, [this](
        const QString& provider,
        const QString& providerTrackId,
        const OnlineStreamResult& stream) {
        if (!isPendingStreamResolve(provider, providerTrackId)) {
            return;
        }
        if (playbackQueueItemId_ != pendingStreamQueueItemId_) {
            return;
        }
        if (stream.streamKind == OnlineStreamKind::Sabr || stream.isSabr) {
            if (!stream.sabr.serverAbrStreamingUrl.isValid() || stream.sabr.serverAbrStreamingUrl.isEmpty() || stream.sabr.audioFormats.isEmpty()) {
                clearPendingStreamResolve();
                updatePlaybackFromBackend(
                    QStringLiteral("error"),
                    std::nullopt,
                    std::nullopt,
                    QStringLiteral("Online playback unavailable. Try another result."));
                return;
            }

            clearPendingStreamResolve();
            sabrPlaybackActive_ = true;
            setCoreStatus(QStringLiteral("Loading playback"));
            playbackBackend_->playStreamDevice(
                std::make_unique<YoutubeSabrAudioDevice>(stream.sabr),
                stream.mimeType);
            return;
        }

        if (!stream.streamUrl.isValid() || stream.streamUrl.isEmpty()) {
            clearPendingStreamResolve();
            updatePlaybackFromBackend(
                QStringLiteral("error"),
                std::nullopt,
                std::nullopt,
                QStringLiteral("Online playback unavailable. Try another result."));
            return;
        }

        clearPendingStreamResolve();
        setCoreStatus(QStringLiteral("Loading playback"));
        if (stream.streamKind == OnlineStreamKind::HeaderedDirectUrl) {
            sabrPlaybackActive_ = true;
            playbackBackend_->playStreamDevice(
                std::make_unique<YoutubeHttpAudioDevice>(stream.streamUrl, stream.requestHeaders),
                stream.mimeType);
            return;
        }

        sabrPlaybackActive_ = false;
        playbackBackend_->playRemoteUrl(stream.streamUrl);
    });

    connect(onlineProvider_.get(), &OnlineProvider::streamResolveFailed, this, [this](
        const QString& provider,
        const QString& providerTrackId,
        const QString&) {
        if (!isPendingStreamResolve(provider, providerTrackId)) {
            return;
        }

        clearPendingStreamResolve();
        updatePlaybackFromBackend(
            QStringLiteral("error"),
            std::nullopt,
            std::nullopt,
            QStringLiteral("Online playback unavailable. Try another result."));
    });
}

void CoreController::setSearchState(const QString& status, const QString& errorMessage) {
    if (searchStatus_ == status && searchErrorMessage_ == errorMessage) {
        return;
    }

    searchStatus_ = status;
    searchErrorMessage_ = errorMessage;
    emit searchStateChanged();
}

void CoreController::applySearchResults(const QVector<OnlineTrackResult>& results) {
    searchResults_ = results;

    QVector<QVariantMap> items;
    items.reserve(results.size());
    for (const OnlineTrackResult& result : results) {
        QVariantMap item{
            {QStringLiteral("result_id"), result.resultId},
            {QStringLiteral("provider"), result.provider},
            {QStringLiteral("provider_track_id"), result.providerTrackId},
            {QStringLiteral("title"), result.title},
            {QStringLiteral("artist"), result.artist},
            {QStringLiteral("album"), result.album},
            {QStringLiteral("duration_ms"), result.durationMs},
            {QStringLiteral("artwork_url"), result.artworkUrl},
        };
        items.push_back(std::move(item));
    }

    searchResultsModel_->setItems(std::move(items));
}

void CoreController::applySearchSuggestions(const QVector<OnlineSuggestionResult>& suggestions) {
    searchSuggestions_ = suggestions;

    QVector<QVariantMap> items;
    items.reserve(suggestions.size());
    for (const OnlineSuggestionResult& suggestion : suggestions) {
        QVariantMap item{
            {QStringLiteral("provider"), suggestion.provider},
            {QStringLiteral("text"), suggestion.text},
        };
        items.push_back(std::move(item));
    }

    searchSuggestionsModel_->setItems(std::move(items));
}

void CoreController::recordSearchHistory(const QString& query) {
    const CommandResult result = invokeCommand(
        QStringLiteral("search_history.add.online"),
        QStringLiteral("search_history.add"),
        QJsonObject{{QStringLiteral("query"), query}});

    if (!result.ok) {
        setCoreStatus(result.error);
    }
}

std::optional<OnlineTrackResult> CoreController::searchResultById(const QString& resultId) const {
    if (resultId.isEmpty()) {
        return std::nullopt;
    }

    for (const OnlineTrackResult& result : searchResults_) {
        if (result.resultId == resultId) {
            return result;
        }
    }
    return std::nullopt;
}

QVariantMap CoreController::trackById(const QString& trackId) const {
    if (trackId.isEmpty()) {
        return {};
    }

    const int count = tracksModel_->rowCount();
    for (int row = 0; row < count; ++row) {
        const QVariantMap item = tracksModel_->itemAt(row);
        if (item.value(QStringLiteral("id")).toString() == trackId) {
            return item;
        }
    }
    return {};
}

bool CoreController::downloadsSupportedForProvider(const QString& provider) const {
    if (provider.isEmpty() || !onlineProvider_) {
        return false;
    }

    return onlineProvider_->capabilities().downloads;
}

QString CoreController::defaultDownloadDirectory() const {
    const QString music = QStandardPaths::writableLocation(QStandardPaths::MusicLocation);
    if (!music.isEmpty()) {
        return music;
    }
    const QString documents = QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation);
    if (!documents.isEmpty()) {
        return documents;
    }
    return QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
}

QString CoreController::targetPathForDownload(const QString& title, const QString& providerTrackId) const {
    QString baseName = title.trimmed();
    if (baseName.isEmpty()) {
        baseName = providerTrackId.trimmed();
    }
    if (baseName.isEmpty()) {
        baseName = QStringLiteral("download");
    }

    for (QChar& ch : baseName) {
        if (ch == QLatin1Char('/') || ch == QLatin1Char('\\') || ch == QLatin1Char(':')
            || ch == QLatin1Char('*') || ch == QLatin1Char('?') || ch == QLatin1Char('"')
            || ch == QLatin1Char('<') || ch == QLatin1Char('>') || ch == QLatin1Char('|')) {
            ch = QLatin1Char('_');
        }
    }

    const QString root = downloadDirectory_.isEmpty() ? defaultDownloadDirectory() : downloadDirectory_;
    return QDir(root).filePath(baseName + QStringLiteral(".m4a"));
}

bool CoreController::queueDownloadForTrack(
    const QString& trackId,
    const QString& provider,
    const QString& providerTrackId,
    const QString& title) {
    if (trackId.isEmpty()) {
        setDownloadStatus(QStringLiteral("Track unavailable"));
        return false;
    }
    if (!downloadsSupportedForProvider(provider)) {
        setDownloadStatus(QStringLiteral("Downloads unavailable for this provider."));
        return false;
    }

    const QString targetPath = targetPathForDownload(title, providerTrackId);
    QDir().mkpath(QFileInfo(targetPath).absolutePath());
    const CommandResult result = invokeCommand(
        QStringLiteral("downloads.queue"),
        QStringLiteral("downloads.queue"),
        QJsonObject{
            {QStringLiteral("track_id"), trackId},
            {QStringLiteral("target_path"), targetPath},
        });
    if (!result.ok) {
        setDownloadStatus(result.error);
        return false;
    }

    refreshDownloadsFromCore();
    setDownloadStatus(QStringLiteral("Download queued"));
    return true;
}

void CoreController::cacheArtworkForTrack(const QString& trackId, const QString& sourceUrl) {
    if (trackId.isEmpty() || sourceUrl.isEmpty()) {
        return;
    }

    const QUrl url(sourceUrl);
    if (!url.isValid()) {
        return;
    }

    const QString suffix = artworkSuffixFromUrl(url);
    if (url.isLocalFile()) {
        const QString sourcePath = url.toLocalFile();
        const QFileInfo sourceInfo(sourcePath);
        if (!sourceInfo.exists() || !sourceInfo.isFile()) {
            return;
        }

        const QString cachePath = artworkCachePathForSource(sourceUrl, sourceInfo.suffix());
        if (!copyFileReplacing(sourcePath, cachePath)) {
            return;
        }
        upsertArtworkCacheRecord(trackId, sourceUrl, cachePath);
        return;
    }

    const QString scheme = url.scheme().toLower();
    if (scheme != QStringLiteral("http") && scheme != QStringLiteral("https")) {
        return;
    }

    QNetworkRequest request(url);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
    QNetworkReply* reply = artworkNetwork_.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply, trackId, sourceUrl, suffix] {
        reply->deleteLater();

        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const bool httpFailed = statusCode != 0 && (statusCode < 200 || statusCode >= 300);
        if (reply->error() != QNetworkReply::NoError || httpFailed) {
            return;
        }

        const QString contentType = reply->header(QNetworkRequest::ContentTypeHeader).toString();
        const QString cachePath = artworkCachePathForSource(sourceUrl, artworkSuffixFromContentType(contentType, suffix));
        if (!replaceFileWithBytes(cachePath, reply->readAll())) {
            return;
        }

        upsertArtworkCacheRecord(trackId, sourceUrl, cachePath);
    });
}

void CoreController::upsertArtworkCacheRecord(const QString& trackId, const QString& sourceUrl, const QString& cachePath) {
    const CommandResult result = invokeCommand(
        QStringLiteral("cache.artwork.upsert"),
        QStringLiteral("cache.artwork.upsert"),
        QJsonObject{
            {QStringLiteral("track_id"), trackId},
            {QStringLiteral("source_url"), sourceUrl},
            {QStringLiteral("cache_path"), cachePath},
        });
    if (!result.ok) {
        QFile::remove(cachePath);
    }
}

bool CoreController::applyPlaybackObject(const QJsonObject& playback) {
    const QString nextState = playback.value(QStringLiteral("state")).toString(QStringLiteral("stopped"));
    const QString nextQueueItemId = playback.value(QStringLiteral("queue_item_id")).toString();
    const QString nextTrackId = playback.value(QStringLiteral("track_id")).toString();
    const QString nextTitle = playback.value(QStringLiteral("title")).toString();
    const QString nextArtist = playback.value(QStringLiteral("artist")).toString();
    const QString nextAlbum = playback.value(QStringLiteral("album")).toString();
    const QString nextArtworkUrl = playback.value(QStringLiteral("artwork_url")).toString();
    const QString nextLocalPath = playback.value(QStringLiteral("local_path")).toString();
    const qint64 nextPositionMs = playback.value(QStringLiteral("position_ms")).isDouble()
        ? static_cast<qint64>(playback.value(QStringLiteral("position_ms")).toDouble())
        : 0;
    const qint64 nextDurationMs = playback.value(QStringLiteral("duration_ms")).isDouble()
        ? static_cast<qint64>(playback.value(QStringLiteral("duration_ms")).toDouble())
        : 0;
    const QString nextErrorMessage = playback.value(QStringLiteral("error_message")).toString();

    const bool changed = playbackState_ != nextState
        || playbackQueueItemId_ != nextQueueItemId
        || playbackTrackId_ != nextTrackId
        || playbackTitle_ != nextTitle
        || playbackArtist_ != nextArtist
        || playbackAlbum_ != nextAlbum
        || playbackArtworkUrl_ != nextArtworkUrl
        || playbackLocalPath_ != nextLocalPath
        || playbackPositionMs_ != nextPositionMs
        || playbackDurationMs_ != nextDurationMs
        || playbackErrorMessage_ != nextErrorMessage;

    playbackState_ = nextState;
    playbackQueueItemId_ = nextQueueItemId;
    playbackTrackId_ = nextTrackId;
    playbackTitle_ = nextTitle;
    playbackArtist_ = nextArtist;
    playbackAlbum_ = nextAlbum;
    playbackArtworkUrl_ = nextArtworkUrl;
    playbackLocalPath_ = nextLocalPath;
    playbackPositionMs_ = nextPositionMs;
    playbackDurationMs_ = nextDurationMs;
    playbackErrorMessage_ = nextErrorMessage;

    if (changed) {
        emit playbackStateChanged();
    }
    return changed;
}

bool CoreController::applyPlaybackOptionsObject(const QJsonObject& options) {
    const QString nextRepeatMode = options.value(QStringLiteral("repeat_mode")).toString(QStringLiteral("off"));
    const bool nextShuffleEnabled = options.value(QStringLiteral("shuffle_enabled")).toBool(false);

    const bool changed = repeatMode_ != nextRepeatMode
        || shuffleEnabled_ != nextShuffleEnabled;

    repeatMode_ = nextRepeatMode;
    shuffleEnabled_ = nextShuffleEnabled;

    if (changed) {
        emit playbackOptionsChanged();
    }
    return changed;
}

void CoreController::updatePlaybackFromBackend(
    const QString& playbackState,
    std::optional<qint64> positionMs,
    std::optional<qint64> durationMs,
    const QString& errorMessage) {
    const bool wasPlaying = playbackState_ == QStringLiteral("playing");
    const bool endedNaturally = playbackState == QStringLiteral("stopped")
        && wasPlaying
        && positionMs.has_value()
        && durationMs.has_value()
        && *durationMs > 0
        && *positionMs >= *durationMs;
    const bool skipAutoAdvance = stopRequested_;

    QJsonObject params{
        {QStringLiteral("state"), playbackState},
    };
    if (positionMs.has_value()) {
        params.insert(QStringLiteral("position_ms"), *positionMs);
    }
    if (durationMs.has_value()) {
        params.insert(QStringLiteral("duration_ms"), *durationMs);
    }
    if (!errorMessage.isEmpty()) {
        params.insert(QStringLiteral("error_message"), errorMessage);
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("playback.update"),
        QStringLiteral("playback.update"),
        params);

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackObject(result.data.value(QStringLiteral("playback")).toObject());
    if (endedNaturally && !skipAutoAdvance) {
        stopRequested_ = false;
        playNextQueuedTrack();
        return;
    }

    if (playbackState_ == QStringLiteral("playing")) {
        recordRecentIfNeeded();
        setCoreStatus(QStringLiteral("Playing"));
    } else if (playbackState_ == QStringLiteral("paused")) {
        setCoreStatus(QStringLiteral("Paused"));
    } else if (playbackState_ == QStringLiteral("stopped")) {
        stopRequested_ = false;
        sabrPlaybackActive_ = false;
        setCoreStatus(QStringLiteral("Stopped"));
    } else if (playbackState_ == QStringLiteral("error")) {
        stopRequested_ = false;
        sabrPlaybackActive_ = false;
        setCoreStatus(playbackErrorMessage_.isEmpty() ? QStringLiteral("Playback error") : playbackErrorMessage_);
    }
}

int CoreController::queueIndexForItem(const QString& queueItemId) const {
    if (queueItemId.isEmpty()) {
        return -1;
    }

    const int count = queueModel_->rowCount();
    for (int row = 0; row < count; ++row) {
        if (queueItemIdAt(row) == queueItemId) {
            return row;
        }
    }
    return -1;
}

QString CoreController::queueItemIdAt(int row) const {
    return queueModel_->itemAt(row).value(QStringLiteral("id")).toString();
}

void CoreController::applyQueueItems(const QJsonArray& items) {
    queueModel_->setItems(mapsWithAliasFromArray(
        items,
        QStringLiteral("queue_item_id"),
        QStringLiteral("id")));
}

void CoreController::applyDownloads(const QJsonArray& downloads) {
    downloadsModel_->setItems(mapsWithAliasFromArray(
        downloads,
        QStringLiteral("download_id"),
        QStringLiteral("id")));
}

void CoreController::stopActivePlaybackBeforeLoad(bool shouldStop) {
    sabrPlaybackActive_ = false;
    if (!shouldStop) {
        return;
    }

    stopRequested_ = true;
    playbackBackend_->stop();
}

bool CoreController::isPendingStreamResolve(const QString& provider, const QString& providerTrackId) const {
    return !pendingStreamQueueItemId_.isEmpty()
        && provider == pendingStreamProvider_
        && providerTrackId == pendingStreamProviderTrackId_;
}

void CoreController::clearPendingStreamResolve() {
    pendingStreamQueueItemId_.clear();
    pendingStreamProvider_.clear();
    pendingStreamProviderTrackId_.clear();
}

void CoreController::recordRecentIfNeeded() {
    if (playbackQueueItemId_.isEmpty()
        || playbackTrackId_.isEmpty()
        || recentRecordedQueueItemId_ == playbackQueueItemId_) {
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("recent.add.playback"),
        QStringLiteral("recent.add"),
        QJsonObject{{QStringLiteral("track_id"), playbackTrackId_}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    recentRecordedQueueItemId_ = playbackQueueItemId_;
}
