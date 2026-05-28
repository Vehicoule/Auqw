#include "CoreController.hpp"

#include <QAbstractListModel>
#include <QDir>
#include <QDirIterator>
#include <QFileInfo>
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

} // namespace

CoreController::CoreController(QObject* parent)
    : QObject(parent),
      tracksModel_(std::make_unique<JsonListModel>(QStringList{
          QStringLiteral("id"),
          QStringLiteral("track_id"),
          QStringLiteral("title"),
          QStringLiteral("artist"),
          QStringLiteral("album"),
          QStringLiteral("duration_ms"),
          QStringLiteral("artwork_url"),
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
          QStringLiteral("title"),
          QStringLiteral("artist"),
          QStringLiteral("album"),
          QStringLiteral("duration_ms"),
          QStringLiteral("artwork_url"),
          QStringLiteral("local_path"),
      })),
      coreStatus_(QStringLiteral("Starting")),
      importStatus_(QStringLiteral("Import a folder")) {
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

QString CoreController::themeSetting() const {
    return themeSetting_;
}

QString CoreController::importStatus() const {
    return importStatus_;
}

int CoreController::importedTrackCount() const {
    return importedTrackCount_;
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

    queueModel_->setItems(mapsWithAliasFromArray(
        result.data.value(QStringLiteral("items")).toArray(),
        QStringLiteral("queue_item_id"),
        QStringLiteral("id")));
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

    queueModel_->setItems(mapsWithAliasFromArray(
        result.data.value(QStringLiteral("items")).toArray(),
        QStringLiteral("queue_item_id"),
        QStringLiteral("id")));
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

    const CommandResult tracks = invokeCommand(
        QStringLiteral("tracks.list"),
        QStringLiteral("tracks.list"));
    if (!tracks.ok) {
        setCoreStatus(tracks.error);
        return;
    }
    tracksModel_->setItems(mapsWithAliasFromArray(
        tracks.data.value(QStringLiteral("tracks")).toArray(),
        QStringLiteral("track_id"),
        QStringLiteral("id")));

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

    queueModel_->setItems(mapsWithAliasFromArray(
        queue.data.value(QStringLiteral("items")).toArray(),
        QStringLiteral("queue_item_id"),
        QStringLiteral("id")));
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
