#include "YoutubeHttpAudioDevice.hpp"

#include <QDebug>
#include <QMetaObject>
#include <QNetworkRequest>
#include <QTimer>
#include <QtGlobal>

#include <algorithm>
#include <utility>

namespace {

constexpr qint64 kPrebufferBytes = 256 * 1024;
constexpr qint64 kReplyReadChunkBytes = 64 * 1024;
constexpr int kMaxResumeAttempts = 12;

#ifndef QT_NO_DEBUG
bool playbackTraceEnabled() {
    static const bool enabled = [] {
        bool ok = false;
        const int value = qEnvironmentVariableIntValue("AUQW_PLAYBACK_TRACE", &ok);
        return ok ? value != 0 : qEnvironmentVariableIsSet("AUQW_PLAYBACK_TRACE");
    }();
    return enabled;
}

void logHttpAudioDeviceEvent(
    const char* event,
    const QUrl& url,
    qint64 nextOffset,
    qint64 expectedTotal,
    qint64 bufferedBytes = -1,
    int statusCode = -1,
    const QByteArray& contentRange = {}) {
    if (!playbackTraceEnabled()) {
        return;
    }

    qDebug().noquote()
        << "Auqw HTTP audio"
        << "event=" << QString::fromLatin1(event)
        << "host=" << (url.host().isEmpty() ? QStringLiteral("<none>") : url.host())
        << "path=" << (url.path().isEmpty() ? QStringLiteral("<none>") : url.path())
        << "nextOffset=" << nextOffset
        << "expectedTotal=" << expectedTotal
        << "bufferedBytes=" << bufferedBytes
        << "status=" << statusCode
        << "contentRange=" << (contentRange.isEmpty() ? QByteArrayLiteral("<empty>") : contentRange);
}
#else
void logHttpAudioDeviceEvent(const char*, const QUrl&, qint64, qint64, qint64 = -1, int = -1, const QByteArray& = {}) {}
#endif

qint64 parseTotalBytesFromContentRange(const QByteArray& contentRange) {
    const qsizetype slash = contentRange.lastIndexOf('/');
    if (slash < 0 || slash + 1 >= contentRange.size()) {
        return -1;
    }
    const QByteArray total = contentRange.mid(slash + 1).trimmed();
    if (total == "*") {
        return -1;
    }
    bool ok = false;
    const qint64 value = total.toLongLong(&ok);
    return ok && value >= 0 ? value : -1;
}

} // namespace

YoutubeHttpAudioDevice::YoutubeHttpAudioDevice(
    QUrl streamUrl,
    QList<QPair<QByteArray, QByteArray>> requestHeaders,
    QObject* parent)
    : QIODevice(parent),
      streamUrl_(std::move(streamUrl)),
      requestHeaders_(std::move(requestHeaders)) {}

YoutubeHttpAudioDevice::~YoutubeHttpAudioDevice() {
    close();
}

bool YoutubeHttpAudioDevice::open(OpenMode mode) {
    if (!(mode & ReadOnly) || mode & WriteOnly) {
        setErrorString(QStringLiteral("Online stream device is read-only."));
        return false;
    }
    if (!streamUrl_.isValid() || streamUrl_.isEmpty()) {
        setErrorString(QStringLiteral("Playback URL is empty"));
        return false;
    }

    buffer_.reset();
    nextRequestOffset_ = 0;
    expectedTotalBytes_ = -1;
    resumeAttempts_ = 0;
    networkFinished_ = false;
    firstAudioEmitted_ = false;
    prebufferEmitted_ = false;
    QIODevice::open(mode);
    startRequest();
    return true;
}

void YoutubeHttpAudioDevice::close() {
    if (reply_) {
        QNetworkReply* reply = reply_.data();
        reply_.clear();
        QObject::disconnect(reply, nullptr, this, nullptr);
        reply->abort();
        delete reply;
    }
    buffer_.cancel();
    networkFinished_ = false;
    QIODevice::close();
}

bool YoutubeHttpAudioDevice::isSequential() const {
    return true;
}

qint64 YoutubeHttpAudioDevice::bytesAvailable() const {
    return buffer_.bytesAvailable() + QIODevice::bytesAvailable();
}

qint64 YoutubeHttpAudioDevice::readData(char* data, qint64 maxSize) {
    const qint64 bytesRead = buffer_.read(data, maxSize);
    if (bytesRead > 0 && reply_) {
        QMetaObject::invokeMethod(this, &YoutubeHttpAudioDevice::appendReplyBytes, Qt::QueuedConnection);
    }
    return bytesRead;
}

qint64 YoutubeHttpAudioDevice::writeData(const char*, qint64) {
    return -1;
}

void YoutubeHttpAudioDevice::startRequest() {
    networkFinished_ = false;
    logHttpAudioDeviceEvent("request_start", streamUrl_, nextRequestOffset_, expectedTotalBytes_, buffer_.bytesAvailable());
    QNetworkRequest request(streamUrl_);
    request.setRawHeader("Range", QByteArrayLiteral("bytes=") + QByteArray::number(nextRequestOffset_) + QByteArrayLiteral("-"));
    for (const auto& header : requestHeaders_) {
        request.setRawHeader(header.first, header.second);
    }

    reply_ = network_.get(request);
    reply_->setReadBufferSize(4 * 1024 * 1024);
    connect(reply_, &QNetworkReply::readyRead, this, &YoutubeHttpAudioDevice::appendReplyBytes);
    connect(reply_, &QNetworkReply::finished, this, &YoutubeHttpAudioDevice::handleReplyFinished);
}

void YoutubeHttpAudioDevice::handleReplyFinished() {
    QNetworkReply* reply = reply_.data();
    const bool failed = reply != nullptr
        && reply->error() != QNetworkReply::NoError
        && reply->error() != QNetworkReply::OperationCanceledError;
    const int statusCode = reply != nullptr ? reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() : 0;
    const QByteArray contentRange = reply != nullptr ? reply->rawHeader("Content-Range") : QByteArray{};

    updateExpectedTotalBytes(reply, statusCode);
    logHttpAudioDeviceEvent("reply_finished", streamUrl_, nextRequestOffset_, expectedTotalBytes_, buffer_.bytesAvailable(), statusCode, contentRange);
    while (reply_ && reply_->bytesAvailable() > 0 && buffer_.writableBytes() > 0) {
        appendReplyBytes();
    }

    if (canResumeAfterFailure(failed, statusCode)) {
        resumeAfterFailure(reply);
        return;
    }

    if (failed || statusCode >= 400) {
        reply_.clear();
        if (reply != nullptr) {
            reply->deleteLater();
        }
        buffer_.cancel();
        logHttpAudioDeviceEvent("request_failed", streamUrl_, nextRequestOffset_, expectedTotalBytes_, buffer_.bytesAvailable(), statusCode, contentRange);
        emit streamError(QStringLiteral("Online stream network request failed."));
        return;
    }

    networkFinished_ = true;
    finishReplyIfDrained();
}

void YoutubeHttpAudioDevice::appendReplyBytes() {
    if (!reply_) {
        return;
    }

    const qint64 writableBytes = buffer_.writableBytes();
    if (writableBytes <= 0) {
        finishReplyIfDrained();
        return;
    }

    const QByteArray bytes = reply_->read(std::min<qint64>(writableBytes, kReplyReadChunkBytes));
    if (bytes.isEmpty()) {
        finishReplyIfDrained();
        return;
    }

    buffer_.append(bytes);
    nextRequestOffset_ += bytes.size();
    resumeAttempts_ = 0;
    if (!firstAudioEmitted_) {
        firstAudioEmitted_ = true;
        logHttpAudioDeviceEvent("first_audio_bytes", streamUrl_, nextRequestOffset_, expectedTotalBytes_, buffer_.bytesAvailable());
        emit firstAudioBytes(bytes.size());
    }
    const qint64 bufferedBytes = buffer_.bytesAvailable();
    if (!prebufferEmitted_ && bufferedBytes >= kPrebufferBytes) {
        prebufferEmitted_ = true;
        logHttpAudioDeviceEvent("prebuffer_ready", streamUrl_, nextRequestOffset_, expectedTotalBytes_, bufferedBytes);
        emit prebufferReady(bufferedBytes);
    }
    emit readyRead();
    finishReplyIfDrained();
}

void YoutubeHttpAudioDevice::finishReplyIfDrained() {
    if (!networkFinished_ || !reply_ || !reply_->atEnd()) {
        return;
    }

    QNetworkReply* reply = reply_.data();
    if (hasIncompleteKnownLengthReply()) {
        logHttpAudioDeviceEvent("continue_incomplete", streamUrl_, nextRequestOffset_, expectedTotalBytes_, buffer_.bytesAvailable());
        continueAfterIncompleteReply(reply);
        return;
    }

    reply_.clear();
    if (reply != nullptr) {
        reply->deleteLater();
    }

    const qint64 bufferedBytes = buffer_.bytesAvailable();
    if (!prebufferEmitted_ && bufferedBytes > 0) {
        prebufferEmitted_ = true;
        logHttpAudioDeviceEvent("prebuffer_ready_on_finish", streamUrl_, nextRequestOffset_, expectedTotalBytes_, bufferedBytes);
        emit prebufferReady(bufferedBytes);
    }
    buffer_.finish();
    logHttpAudioDeviceEvent("stream_finished", streamUrl_, nextRequestOffset_, expectedTotalBytes_, bufferedBytes);
    emit readChannelFinished();
}

void YoutubeHttpAudioDevice::updateExpectedTotalBytes(QNetworkReply* reply, int statusCode) {
    if (reply == nullptr) {
        return;
    }

    if (statusCode == 206) {
        const qint64 total = parseTotalBytesFromContentRange(reply->rawHeader("Content-Range"));
        if (total >= 0) {
            expectedTotalBytes_ = total;
        }
        return;
    }

    if (statusCode == 200 && nextRequestOffset_ == 0) {
        const QVariant contentLength = reply->header(QNetworkRequest::ContentLengthHeader);
        if (contentLength.isValid()) {
            bool ok = false;
            const qint64 total = contentLength.toLongLong(&ok);
            if (ok && total >= 0) {
                expectedTotalBytes_ = total;
            }
        }
    }
}

bool YoutubeHttpAudioDevice::hasIncompleteKnownLengthReply() const {
    return expectedTotalBytes_ >= 0 && nextRequestOffset_ < expectedTotalBytes_;
}

bool YoutubeHttpAudioDevice::canResumeAfterFailure(bool failed, int statusCode) const {
    if (!failed || statusCode >= 400 || resumeAttempts_ >= kMaxResumeAttempts) {
        return false;
    }
    return expectedTotalBytes_ < 0 || nextRequestOffset_ < expectedTotalBytes_;
}

void YoutubeHttpAudioDevice::resumeAfterFailure(QNetworkReply* reply) {
    reply_.clear();
    if (reply != nullptr) {
        reply->deleteLater();
    }
    ++resumeAttempts_;
    const int backoffMs = std::min(1000, 100 * resumeAttempts_);
    logHttpAudioDeviceEvent("resume_after_failure", streamUrl_, nextRequestOffset_, expectedTotalBytes_, buffer_.bytesAvailable());
    QTimer::singleShot(backoffMs, this, [this] {
        if (isOpen()) {
            startRequest();
        }
    });
}

void YoutubeHttpAudioDevice::continueAfterIncompleteReply(QNetworkReply* reply) {
    reply_.clear();
    if (reply != nullptr) {
        reply->deleteLater();
    }
    QTimer::singleShot(0, this, [this] {
        if (isOpen()) {
            startRequest();
        }
    });
}
