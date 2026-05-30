#include "YoutubeSabrAudioDevice.hpp"

#include <QMetaObject>

#include <algorithm>
#include <utility>

namespace {

constexpr qint64 kPrebufferBytes = 256 * 1024;

} // namespace

YoutubeSabrAudioDevice::YoutubeSabrAudioDevice(YoutubeSabrStreamInfo streamInfo, QObject* parent)
    : QIODevice(parent),
      session_(std::move(streamInfo), this) {
    connect(&session_, &YoutubeSabrSession::audioBytesReady, this, [this](const QByteArray& bytes) {
        buffer_.append(bytes);
        const qint64 bufferedBytes = buffer_.bytesAvailable();
        if (!prebufferEmitted_ && bufferedBytes >= kPrebufferBytes) {
            prebufferEmitted_ = true;
            emit prebufferReady(bufferedBytes);
        }
        emit readyRead();
    });
    connect(&session_, &YoutubeSabrSession::streamEnded, this, [this] {
        const qint64 bufferedBytes = buffer_.bytesAvailable();
        if (!prebufferEmitted_ && bufferedBytes > 0) {
            prebufferEmitted_ = true;
            emit prebufferReady(bufferedBytes);
        }
        buffer_.finish();
        emit readChannelFinished();
    });
    connect(&session_, &YoutubeSabrSession::streamError, this, &YoutubeSabrAudioDevice::streamError);
    connect(&session_, &YoutubeSabrSession::firstAudioBytes, this, &YoutubeSabrAudioDevice::firstAudioBytes);
}

YoutubeSabrAudioDevice::~YoutubeSabrAudioDevice() {
    close();
}

bool YoutubeSabrAudioDevice::open(OpenMode mode) {
    if ((mode & ReadOnly) == 0) {
        setErrorString(QStringLiteral("YouTube SABR device is read-only"));
        return false;
    }
    if (isOpen()) {
        return true;
    }

    buffer_.reset();
    prebufferEmitted_ = false;
    QIODevice::open(mode);
    session_.start();
    return true;
}

void YoutubeSabrAudioDevice::close() {
    session_.cancel();
    buffer_.cancel();
    QIODevice::close();
}

bool YoutubeSabrAudioDevice::isSequential() const {
    return true;
}

qint64 YoutubeSabrAudioDevice::bytesAvailable() const {
    return buffer_.bytesAvailable() + QIODevice::bytesAvailable();
}

qint64 YoutubeSabrAudioDevice::readData(char* data, qint64 maxSize) {
    return buffer_.read(data, maxSize);
}

qint64 YoutubeSabrAudioDevice::writeData(const char*, qint64) {
    return -1;
}
