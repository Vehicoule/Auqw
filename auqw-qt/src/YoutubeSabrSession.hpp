#pragma once

#include "YoutubeSabrTypes.hpp"
#include "YoutubeUmpParser.hpp"

#include <QByteArray>
#include <QHash>
#include <QNetworkAccessManager>
#include <QObject>
#include <QPointer>
#include <QUrl>

class QNetworkReply;

class YoutubeSabrSession final : public QObject {
    Q_OBJECT

public:
    explicit YoutubeSabrSession(YoutubeSabrStreamInfo streamInfo, QObject* parent = nullptr);
    ~YoutubeSabrSession() override;

    void start();
    void cancel();

signals:
    void audioBytesReady(const QByteArray& bytes);
    void streamEnded();
    void streamError(const QString& message);
    void firstAudioBytes(qint64 bytes);

private:
    void sendRequest();
    void handleReplyBytes(const QByteArray& bytes);
    void handleReplyFinished();
    void scheduleNextRequest(int backoffMs);
    [[nodiscard]] QByteArray buildRequestBody() const;
    [[nodiscard]] YoutubeSabrFormat selectedAudioFormat() const;

    YoutubeSabrStreamInfo streamInfo_;
    YoutubeUmpParser parser_;
    QNetworkAccessManager network_;
    QPointer<QNetworkReply> reply_;
    QUrl streamingUrl_;
    QHash<int, QByteArray> sabrContexts_;
    QByteArray playbackCookie_;
    qint64 playerTimeMs_ = 0;
    qint64 lastMediaDurationMs_ = 0;
    int nextBackoffMs_ = 0;
    int requestNumber_ = 0;
    bool started_ = false;
    bool cancelled_ = false;
    bool firstAudioEmitted_ = false;
    bool mediaSeenInRequest_ = false;
    bool mediaEndSeenInRequest_ = false;
    bool streamProtectionRequired_ = false;
};
