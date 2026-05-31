#include "CoreController.hpp"
#include "JsonListModel.hpp"
#include "OnlineProvider.hpp"
#include "PlaybackBackend.hpp"

#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QJsonValue>
#include <QStandardPaths>
#include <QVariantMap>

#include <exception>
#include <string>
#include <utility>

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
          QStringLiteral("bytes_received"),
          QStringLiteral("bytes_total"),
          QStringLiteral("mime_type"),
          QStringLiteral("stream_kind"),
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
