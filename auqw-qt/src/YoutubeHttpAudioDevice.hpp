#pragma once

#include "YoutubeStreamBuffer.hpp"

#include <QByteArray>
#include <QIODevice>
#include <QList>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QPointer>
#include <QUrl>

class YoutubeHttpAudioDevice final : public QIODevice {
    Q_OBJECT

public:
    YoutubeHttpAudioDevice(
        QUrl streamUrl,
        QList<QPair<QByteArray, QByteArray>> requestHeaders,
        QObject* parent = nullptr);
    ~YoutubeHttpAudioDevice() override;

    bool open(OpenMode mode) override;
    void close() override;
    [[nodiscard]] bool isSequential() const override;
    [[nodiscard]] qint64 bytesAvailable() const override;

signals:
    void streamError(const QString& message);
    void firstAudioBytes(qint64 bytes);
    void prebufferReady(qint64 bytes);

protected:
    qint64 readData(char* data, qint64 maxSize) override;
    qint64 writeData(const char* data, qint64 maxSize) override;

private:
    void startRequest();
    void handleReplyFinished();
    void appendReplyBytes();
    void finishReplyIfDrained();
    void updateExpectedTotalBytes(QNetworkReply* reply, int statusCode);
    [[nodiscard]] bool canResumeAfterFailure(bool failed, int statusCode) const;
    void resumeAfterFailure(QNetworkReply* reply);

    QNetworkAccessManager network_;
    QPointer<QNetworkReply> reply_;
    QUrl streamUrl_;
    QList<QPair<QByteArray, QByteArray>> requestHeaders_;
    YoutubeStreamBuffer buffer_;
    qint64 nextRequestOffset_ = 0;
    qint64 expectedTotalBytes_ = -1;
    int resumeAttempts_ = 0;
    bool networkFinished_ = false;
    bool firstAudioEmitted_ = false;
    bool prebufferEmitted_ = false;
};
