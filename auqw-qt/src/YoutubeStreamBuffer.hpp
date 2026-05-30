#pragma once

#include <QByteArray>
#include <QMutex>
#include <QMutexLocker>
#include <QWaitCondition>

#include <algorithm>
#include <cstring>

class YoutubeStreamBuffer {
public:
    explicit YoutubeStreamBuffer(qint64 maxBufferedBytes = 4 * 1024 * 1024)
        : maxBufferedBytes_(maxBufferedBytes) {}

    YoutubeStreamBuffer(const YoutubeStreamBuffer&) = delete;
    YoutubeStreamBuffer& operator=(const YoutubeStreamBuffer&) = delete;

    void reset() {
        QMutexLocker locker(&mutex_);
        buffer_.clear();
        finished_ = false;
        canceled_ = false;
        ready_.wakeAll();
    }

    void append(const QByteArray& bytes) {
        if (bytes.isEmpty()) {
            return;
        }

        QMutexLocker locker(&mutex_);
        if (finished_ || canceled_) {
            return;
        }
        buffer_.append(bytes);
        ready_.wakeAll();
    }

    qint64 read(char* data, qint64 maxSize) {
        if (maxSize <= 0) {
            return 0;
        }

        QMutexLocker locker(&mutex_);
        while (buffer_.isEmpty() && !finished_ && !canceled_) {
            ready_.wait(&mutex_);
        }

        if (buffer_.isEmpty()) {
            return -1;
        }

        const qint64 count = std::min<qint64>(maxSize, buffer_.size());
        std::memcpy(data, buffer_.constData(), static_cast<size_t>(count));
        buffer_.remove(0, static_cast<qsizetype>(count));
        ready_.wakeAll();
        return count;
    }

    void finish() {
        QMutexLocker locker(&mutex_);
        finished_ = true;
        ready_.wakeAll();
    }

    void cancel() {
        QMutexLocker locker(&mutex_);
        canceled_ = true;
        finished_ = true;
        ready_.wakeAll();
    }

    [[nodiscard]] qint64 bytesAvailable() const {
        QMutexLocker locker(&mutex_);
        return buffer_.size();
    }

    [[nodiscard]] qint64 writableBytes() const {
        QMutexLocker locker(&mutex_);
        return std::max<qint64>(0, maxBufferedBytes_ - buffer_.size());
    }

    [[nodiscard]] bool isCanceled() const {
        QMutexLocker locker(&mutex_);
        return canceled_;
    }

private:
    mutable QMutex mutex_;
    QWaitCondition ready_;
    QByteArray buffer_;
    qint64 maxBufferedBytes_;
    bool finished_ = false;
    bool canceled_ = false;
};
