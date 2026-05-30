#pragma once

#include "OnlineProvider.hpp"

#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QString>
#include <QUrl>
#include <QVector>

#include <optional>

struct YoutubeClientProfile {
    QString key;
    QString clientName;
    QString clientVersion;
    QString clientId;
    QString userAgent;
    QString osName;
    QString osVersion;
    QString deviceMake;
    QString deviceModel;
    QString androidSdkVersion;
    bool loginRequired = false;
    bool useSignatureTimestamp = false;
    bool embedded = false;
};

class YoutubePlaybackResolver final : public QObject {
    Q_OBJECT

public:
    explicit YoutubePlaybackResolver(
        QString providerTrackId,
        QString visitorData,
        std::optional<OnlineStreamResult> fallbackStream = std::nullopt,
        QObject* parent = nullptr);

    void start();

    static QVector<YoutubeClientProfile> playbackClientProfiles();
    static OnlineStreamResolveResult parsePlayerResponse(
        const QByteArray& payload,
        const QString& providerTrackId,
        const YoutubeClientProfile& profile);
    static QJsonObject playerRequestBody(
        const YoutubeClientProfile& profile,
        const QString& providerTrackId,
        const QString& visitorData,
        int signatureTimestamp = 0);

signals:
    void resolved(const OnlineStreamResult& stream);
    void failed(const QString& message);

private:
    void tryNextClient();
    void validateStream(OnlineStreamResult stream, const YoutubeClientProfile& profile);
    void finishWithFallbackOrError(const QString& message);

    QNetworkAccessManager network_;
    QString providerTrackId_;
    QString visitorData_;
    std::optional<OnlineStreamResult> fallbackStream_;
    QVector<YoutubeClientProfile> profiles_;
    qsizetype profileIndex_ = 0;
    QString lastErrorMessage_;
};
