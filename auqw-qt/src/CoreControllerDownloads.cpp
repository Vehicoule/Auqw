#include "CoreController.hpp"
#include "DownloadWorker.hpp"
#include "JsonListModel.hpp"
#include "OnlineProvider.hpp"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSaveFile>
#include <QStandardPaths>
#include <QUrl>
#include <QVariantMap>

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

    QString activeTargetPath;
    if (activeDownloadWorker_ != nullptr && activeDownloadId_ == downloadId) {
        activeTargetPath = activeDownloadWorker_->targetPath();
        QObject::disconnect(activeDownloadWorker_, nullptr, this, nullptr);
        activeDownloadWorker_->cancel();
        activeDownloadWorker_->deleteLater();
        activeDownloadWorker_ = nullptr;
        activeDownloadId_.clear();
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
    if (!activeTargetPath.isEmpty() && activeTargetPath != targetPath && QFileInfo::exists(activeTargetPath)) {
        QFile::remove(activeTargetPath);
    }

    refreshDownloadsFromCore();
    setDownloadStatus(QStringLiteral("Download removed"));
    maybeStartNextDownload();
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
    maybeStartNextDownload();
    return true;
}

void CoreController::maybeStartNextDownload() {
    if (activeDownloadWorker_ != nullptr || !onlineProvider_) {
        return;
    }

    QVariantMap selected;
    QString selectedCreatedAt;
    const int count = downloadsModel_->rowCount();
    for (int row = 0; row < count; ++row) {
        const QVariantMap item = downloadsModel_->itemAt(row);
        if (item.value(QStringLiteral("state")).toString() != QStringLiteral("queued")) {
            continue;
        }

        const QString createdAt = item.value(QStringLiteral("created_at")).toString();
        if (selected.isEmpty() || createdAt < selectedCreatedAt) {
            selected = item;
            selectedCreatedAt = createdAt;
        }
    }

    if (!selected.isEmpty()) {
        startDownloadWorker(selected);
    }
}

void CoreController::startDownloadWorker(const QVariantMap& download) {
    const QString downloadId = download.value(QStringLiteral("id")).toString();
    const QString provider = download.value(QStringLiteral("provider")).toString();
    const QString providerTrackId = download.value(QStringLiteral("provider_track_id")).toString();
    const QString title = download.value(QStringLiteral("title")).toString();
    const QString directory = downloadDirectory_.isEmpty() ? defaultDownloadDirectory() : downloadDirectory_;

    if (downloadId.isEmpty() || provider.isEmpty() || providerTrackId.isEmpty()) {
        applyDownloadWorkerUpdate(downloadId, QVariantMap{
            {QStringLiteral("state"), QStringLiteral("failed")},
            {QStringLiteral("progress"), 0},
            {QStringLiteral("error_text"), QStringLiteral("Download source unavailable.")},
        });
        return;
    }

    auto* worker = new DownloadWorker(DownloadWorker::Job{
        .downloadId = downloadId,
        .provider = provider,
        .providerTrackId = providerTrackId,
        .title = title,
        .downloadDirectory = directory,
    }, onlineProvider_.get(), this);

    activeDownloadWorker_ = worker;
    activeDownloadId_ = downloadId;

    connect(worker, &DownloadWorker::updateRequested, this, &CoreController::applyDownloadWorkerUpdate);
    connect(worker, &DownloadWorker::completed, this, [this](const QString& id, const QString&) {
        finishActiveDownload(id, QStringLiteral("Download completed"));
    });
    connect(worker, &DownloadWorker::failed, this, [this](const QString& id, const QString& message, const QString&) {
        finishActiveDownload(id, message.isEmpty() ? QStringLiteral("Download failed") : message);
    });
    connect(worker, &DownloadWorker::cancelled, this, [this](const QString& id, const QString&) {
        finishActiveDownload(id, QStringLiteral("Download cancelled"));
    });

    setDownloadStatus(QStringLiteral("Resolving download"));
    worker->start();
}

void CoreController::applyDownloadWorkerUpdate(const QString& downloadId, const QVariantMap& fields) {
    if (downloadId.isEmpty()) {
        return;
    }

    QJsonObject params{{QStringLiteral("id"), downloadId}};
    for (auto it = fields.cbegin(); it != fields.cend(); ++it) {
        params.insert(it.key(), QJsonValue::fromVariant(it.value()));
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("downloads.update.worker"),
        QStringLiteral("downloads.update"),
        params);
    if (!result.ok) {
        setDownloadStatus(result.error);
        return;
    }

    refreshDownloadsFromCore();
    const QString state = fields.value(QStringLiteral("state")).toString();
    if (state == QStringLiteral("resolving")) {
        setDownloadStatus(QStringLiteral("Resolving download"));
    } else if (state == QStringLiteral("downloading")) {
        setDownloadStatus(QStringLiteral("Downloading"));
    } else if (state == QStringLiteral("verifying")) {
        setDownloadStatus(QStringLiteral("Verifying download"));
    }
}

void CoreController::finishActiveDownload(const QString& downloadId, const QString& status) {
    if (downloadId != activeDownloadId_) {
        return;
    }

    clearActiveDownloadWorker();
    refreshDownloadsFromCore();
    setDownloadStatus(status);
    maybeStartNextDownload();
}

void CoreController::clearActiveDownloadWorker() {
    if (activeDownloadWorker_ != nullptr) {
        activeDownloadWorker_->deleteLater();
        activeDownloadWorker_ = nullptr;
    }
    activeDownloadId_.clear();
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

void CoreController::applyDownloads(const QJsonArray& downloads) {
    downloadsModel_->setItems(mapsWithAliasFromArray(
        downloads,
        QStringLiteral("download_id"),
        QStringLiteral("id")));
}
