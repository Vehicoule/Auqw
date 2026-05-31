#include "DownloadWorker.hpp"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSaveFile>

#include <algorithm>
#include <utility>

namespace {

QString sanitizedBaseName(QString value, const QString& fallback) {
    value = value.trimmed();
    if (value.isEmpty()) {
        value = fallback.trimmed();
    }
    if (value.isEmpty()) {
        value = QStringLiteral("download");
    }

    for (QChar& ch : value) {
        if (ch == QLatin1Char('/') || ch == QLatin1Char('\\') || ch == QLatin1Char(':')
            || ch == QLatin1Char('*') || ch == QLatin1Char('?') || ch == QLatin1Char('"')
            || ch == QLatin1Char('<') || ch == QLatin1Char('>') || ch == QLatin1Char('|')) {
            ch = QLatin1Char('_');
        }
    }
    return value;
}

QString extensionForStream(const OnlineStreamResult& stream, const QString& streamKind) {
    const QString mime = stream.mimeType.toLower();
    if (mime.contains(QStringLiteral("mp4"))
        || mime.contains(QStringLiteral("m4a"))
        || stream.itag == 140 || stream.itag == 141) {
        return QStringLiteral("m4a");
    }
    if (mime.contains(QStringLiteral("webm"))
        || mime.contains(QStringLiteral("opus"))
        || stream.itag == 249 || stream.itag == 250 || stream.itag == 251
        || streamKind == QStringLiteral("sabr")) {
        return QStringLiteral("webm");
    }
    if (mime.contains(QStringLiteral("mpeg")) || mime.contains(QStringLiteral("mp3"))) {
        return QStringLiteral("mp3");
    }
    return QStringLiteral("bin");
}

QString uniquePath(const QString& directory, const QString& baseName, const QString& extension) {
    QDir dir(directory);
    QString path = dir.filePath(baseName + QLatin1Char('.') + extension);
    if (!QFileInfo::exists(path)) {
        return path;
    }

    for (int index = 1; index < 1000; ++index) {
        path = dir.filePath(QStringLiteral("%1 (%2).%3").arg(baseName).arg(index).arg(extension));
        if (!QFileInfo::exists(path)) {
            return path;
        }
    }

    const QByteArray digest = QCryptographicHash::hash(path.toUtf8(), QCryptographicHash::Sha1).toHex();
    return dir.filePath(baseName + QLatin1Char('-') + QString::fromLatin1(digest.left(8)) + QLatin1Char('.') + extension);
}

int progressForBytes(qint64 received, qint64 total) {
    if (total <= 0) {
        return received > 0 ? 1 : 0;
    }
    return std::clamp(static_cast<int>((received * 100) / total), 1, 99);
}

QVariantMap baseFields(const QString& state, int progress, qint64 bytesReceived) {
    return QVariantMap{
        {QStringLiteral("state"), state},
        {QStringLiteral("progress"), progress},
        {QStringLiteral("bytes_received"), bytesReceived},
    };
}

} // namespace

DownloadWorker::DownloadWorker(Job job, OnlineProvider* provider, QObject* parent)
    : QObject(parent),
      job_(std::move(job)),
      provider_(provider) {}

DownloadWorker::~DownloadWorker() {
    cancel();
}

QString DownloadWorker::downloadId() const {
    return job_.downloadId;
}

QString DownloadWorker::targetPath() const {
    return targetPath_;
}

void DownloadWorker::start() {
    if (started_) {
        return;
    }
    started_ = true;

    if (!provider_ || job_.downloadId.isEmpty() || job_.provider.isEmpty() || job_.providerTrackId.isEmpty()) {
        fail(QStringLiteral("Download source unavailable."));
        return;
    }

    emit updateRequested(job_.downloadId, QVariantMap{
        {QStringLiteral("state"), QStringLiteral("resolving")},
        {QStringLiteral("progress"), 0},
        {QStringLiteral("bytes_received"), 0},
    });

    connect(provider_, &OnlineProvider::streamResolved, this, &DownloadWorker::handleStreamResolved);
    connect(provider_, &OnlineProvider::streamResolveFailed, this, &DownloadWorker::handleStreamResolveFailed);
    provider_->resolveStream(job_.provider, job_.providerTrackId);
}

void DownloadWorker::cancel() {
    if (finished_ || cancelled_) {
        return;
    }
    cancelled_ = true;
    if (reply_) {
        QNetworkReply* reply = reply_.data();
        reply_.clear();
        reply->abort();
        reply->deleteLater();
    }
    if (sabrSession_) {
        sabrSession_->cancel();
        sabrSession_.reset();
    }
    cleanupOutput(true);
    finished_ = true;
    emit cancelled(job_.downloadId, targetPath_);
}

void DownloadWorker::handleStreamResolved(const QString& provider, const QString& providerTrackId, const OnlineStreamResult& stream) {
    if (finished_ || cancelled_ || !matches(provider, providerTrackId)) {
        return;
    }

    if (stream.streamKind == OnlineStreamKind::Sabr || stream.isSabr) {
        startSabr(stream);
        return;
    }

    const QString streamKind = stream.streamKind == OnlineStreamKind::HeaderedDirectUrl
        ? QStringLiteral("headered_direct")
        : QStringLiteral("direct");
    startDirect(stream, streamKind);
}

void DownloadWorker::handleStreamResolveFailed(const QString& provider, const QString& providerTrackId, const QString&) {
    if (finished_ || cancelled_ || !matches(provider, providerTrackId)) {
        return;
    }
    fail(QStringLiteral("Download stream unavailable."));
}

void DownloadWorker::startDirect(const OnlineStreamResult& stream, const QString& streamKind) {
    if (!stream.streamUrl.isValid() || stream.streamUrl.isEmpty()) {
        fail(QStringLiteral("Download stream unavailable."));
        return;
    }

    streamKind_ = streamKind;
    mimeType_ = stream.mimeType;
    targetPath_ = resolvedTargetPath(stream, streamKind_);
    QDir().mkpath(QFileInfo(targetPath_).absolutePath());

    output_ = std::make_unique<QSaveFile>(targetPath_);
    if (!output_->open(QIODevice::WriteOnly)) {
        fail(QStringLiteral("Download file unavailable."));
        return;
    }

    QVariantMap fields = baseFields(QStringLiteral("downloading"), 1, 0);
    fields.insert(QStringLiteral("target_path"), targetPath_);
    fields.insert(QStringLiteral("mime_type"), mimeType_);
    fields.insert(QStringLiteral("stream_kind"), streamKind_);
    emit updateRequested(job_.downloadId, fields);

    QNetworkRequest request(stream.streamUrl);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
    for (const auto& header : stream.requestHeaders) {
        request.setRawHeader(header.first, header.second);
    }

    QNetworkReply* reply = network_.get(request);
    reply_ = reply;
    connect(reply, &QNetworkReply::metaDataChanged, this, [this, reply] {
        if (reply_ != reply || finished_ || cancelled_) {
            return;
        }
        const QVariant contentLength = reply->header(QNetworkRequest::ContentLengthHeader);
        if (contentLength.isValid()) {
            bytesTotal_ = contentLength.toLongLong();
        }
    });
    connect(reply, &QNetworkReply::readyRead, this, [this, reply] {
        if (reply_ != reply || finished_ || cancelled_) {
            return;
        }
        appendDirectReplyBytes();
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        if (reply_ != reply) {
            reply->deleteLater();
            return;
        }
        handleDirectFinished();
    });
}

void DownloadWorker::startSabr(const OnlineStreamResult& stream) {
    if (!stream.sabr.serverAbrStreamingUrl.isValid() || stream.sabr.serverAbrStreamingUrl.isEmpty() || stream.sabr.audioFormats.isEmpty()) {
        fail(QStringLiteral("Download stream unavailable."));
        return;
    }

    streamKind_ = QStringLiteral("sabr");
    mimeType_ = stream.mimeType;
    targetPath_ = resolvedTargetPath(stream, streamKind_);
    QDir().mkpath(QFileInfo(targetPath_).absolutePath());

    output_ = std::make_unique<QSaveFile>(targetPath_);
    if (!output_->open(QIODevice::WriteOnly)) {
        fail(QStringLiteral("Download file unavailable."));
        return;
    }

    QVariantMap fields = baseFields(QStringLiteral("downloading"), 1, 0);
    fields.insert(QStringLiteral("target_path"), targetPath_);
    fields.insert(QStringLiteral("mime_type"), mimeType_);
    fields.insert(QStringLiteral("stream_kind"), streamKind_);
    emit updateRequested(job_.downloadId, fields);

    sabrSession_ = std::make_unique<YoutubeSabrSession>(stream.sabr);
    connect(sabrSession_.get(), &YoutubeSabrSession::audioBytesReady, this, [this](const QByteArray& bytes) {
        appendBytes(bytes);
    });
    connect(sabrSession_.get(), &YoutubeSabrSession::streamEnded, this, &DownloadWorker::handleSabrEnded);
    connect(sabrSession_.get(), &YoutubeSabrSession::streamError, this, [this](const QString& message) {
        fail(message.isEmpty() ? QStringLiteral("Download stream unavailable.") : message);
    });
    sabrSession_->start();
}

void DownloadWorker::appendDirectReplyBytes() {
    if (!reply_) {
        return;
    }
    const QVariant contentLength = reply_->header(QNetworkRequest::ContentLengthHeader);
    if (contentLength.isValid()) {
        bytesTotal_ = contentLength.toLongLong();
    }
    appendBytes(reply_->readAll());
}

void DownloadWorker::appendBytes(const QByteArray& bytes) {
    if (finished_ || cancelled_ || bytes.isEmpty()) {
        return;
    }
    if (!output_ || output_->write(bytes) != bytes.size()) {
        fail(QStringLiteral("Download file write failed."));
        return;
    }

    bytesReceived_ += bytes.size();
    emitProgress(progressForBytes(bytesReceived_, bytesTotal_));
}

void DownloadWorker::handleDirectFinished() {
    QNetworkReply* reply = reply_.data();
    reply_.clear();
    if (reply == nullptr) {
        fail(QStringLiteral("Download network request failed."));
        return;
    }

    if (cancelled_) {
        reply->deleteLater();
        return;
    }

    appendBytes(reply->readAll());
    const bool networkFailed = reply->error() != QNetworkReply::NoError && reply->error() != QNetworkReply::OperationCanceledError;
    const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    reply->deleteLater();

    if (networkFailed || (statusCode != 0 && (statusCode < 200 || statusCode >= 300))) {
        fail(QStringLiteral("Download network request failed."));
        return;
    }
    if (bytesTotal_ < 0) {
        bytesTotal_ = bytesReceived_;
    }
    complete();
}

void DownloadWorker::handleSabrEnded() {
    if (finished_ || cancelled_) {
        return;
    }
    complete();
}

void DownloadWorker::emitProgress(int progress) {
    QVariantMap fields = baseFields(QStringLiteral("downloading"), progress, bytesReceived_);
    if (bytesTotal_ >= 0) {
        fields.insert(QStringLiteral("bytes_total"), bytesTotal_);
    }
    emit updateRequested(job_.downloadId, fields);
}

void DownloadWorker::complete() {
    if (finished_ || cancelled_) {
        return;
    }

    emit updateRequested(job_.downloadId, baseFields(QStringLiteral("verifying"), 100, bytesReceived_));
    if (!output_ || !output_->commit()) {
        fail(QStringLiteral("Download file write failed."));
        return;
    }
    output_.reset();
    finished_ = true;

    QVariantMap fields = baseFields(QStringLiteral("completed"), 100, bytesReceived_);
    fields.insert(QStringLiteral("target_path"), targetPath_);
    fields.insert(QStringLiteral("mime_type"), mimeType_);
    fields.insert(QStringLiteral("stream_kind"), streamKind_);
    if (bytesTotal_ >= 0) {
        fields.insert(QStringLiteral("bytes_total"), bytesTotal_);
    }
    emit updateRequested(job_.downloadId, fields);
    emit completed(job_.downloadId, targetPath_);
}

void DownloadWorker::fail(const QString& message) {
    if (finished_ || cancelled_) {
        return;
    }
    cleanupOutput(true);
    finished_ = true;

    QVariantMap fields = baseFields(QStringLiteral("failed"), 0, bytesReceived_);
    fields.insert(QStringLiteral("error_text"), message);
    if (!targetPath_.isEmpty()) {
        fields.insert(QStringLiteral("target_path"), targetPath_);
    }
    if (!mimeType_.isEmpty()) {
        fields.insert(QStringLiteral("mime_type"), mimeType_);
    }
    if (!streamKind_.isEmpty()) {
        fields.insert(QStringLiteral("stream_kind"), streamKind_);
    }
    emit updateRequested(job_.downloadId, fields);
    emit failed(job_.downloadId, message, targetPath_);
}

void DownloadWorker::cleanupOutput(bool removeTarget) {
    if (output_) {
        output_->cancelWriting();
        output_.reset();
    }
    if (removeTarget && !targetPath_.isEmpty()) {
        QFile::remove(targetPath_);
    }
}

bool DownloadWorker::matches(const QString& provider, const QString& providerTrackId) const {
    return provider == job_.provider && providerTrackId == job_.providerTrackId;
}

QString DownloadWorker::resolvedTargetPath(const OnlineStreamResult& stream, const QString& streamKind) const {
    const QString baseName = sanitizedBaseName(job_.title, job_.providerTrackId);
    return uniquePath(job_.downloadDirectory, baseName, extensionForStream(stream, streamKind));
}
