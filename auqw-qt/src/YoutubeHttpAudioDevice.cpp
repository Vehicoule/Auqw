#include "YoutubeHttpAudioDevice.hpp"

#include <QMetaObject>
#include <QNetworkRequest>

#include <algorithm>
#include <utility>

namespace {

constexpr qint64 kPrebufferBytes = 256 * 1024;
constexpr qint64 kReplyReadChunkBytes = 64 * 1024;

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
    QNetworkRequest request(streamUrl_);
    request.setRawHeader("Range", "bytes=0-");
    for (const auto& header : requestHeaders_) {
        request.setRawHeader(header.first, header.second);
    }

    reply_ = network_.get(request);
    reply_->setReadBufferSize(4 * 1024 * 1024);
    connect(reply_, &QNetworkReply::readyRead, this, &YoutubeHttpAudioDevice::appendReplyBytes);
    connect(reply_, &QNetworkReply::finished, this, [this] {
        QNetworkReply* reply = reply_.data();
        const bool failed = reply != nullptr && reply->error() != QNetworkReply::NoError && reply->error() != QNetworkReply::OperationCanceledError;
        const int statusCode = reply != nullptr ? reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() : 0;

        if (failed || statusCode >= 400) {
            reply_.clear();
            if (reply != nullptr) {
                reply->deleteLater();
            }
            buffer_.cancel();
            emit streamError(QStringLiteral("Online stream network request failed."));
            return;
        }
        networkFinished_ = true;
        appendReplyBytes();
        finishReplyIfDrained();
    });
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
    if (!firstAudioEmitted_) {
        firstAudioEmitted_ = true;
        emit firstAudioBytes(bytes.size());
    }
    const qint64 bufferedBytes = buffer_.bytesAvailable();
    if (!prebufferEmitted_ && bufferedBytes >= kPrebufferBytes) {
        prebufferEmitted_ = true;
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
    reply_.clear();
    if (reply != nullptr) {
        reply->deleteLater();
    }

    const qint64 bufferedBytes = buffer_.bytesAvailable();
    if (!prebufferEmitted_ && bufferedBytes > 0) {
        prebufferEmitted_ = true;
        emit prebufferReady(bufferedBytes);
    }
    buffer_.finish();
    emit readChannelFinished();
}
