#pragma once

#include <QUrl>
#include <QVector>
#include <QString>

struct YoutubeSabrFormat {
    int itag = 0;
    QString mimeType;
    int bitrate = 0;
    qint64 lastModified = 0;
    QString xtags;
    QString audioTrackId;
    bool isDrc = false;
};

struct YoutubeSabrStreamInfo {
    QString providerTrackId;
    QUrl serverAbrStreamingUrl;
    QString videoPlaybackUstreamerConfig;
    QString clientName = QStringLiteral("WEB");
    QString clientVersion;
    QString visitorData;
    QString apiKey;
    int signatureTimestamp = 0;
    QVector<YoutubeSabrFormat> audioFormats;
    QVector<YoutubeSabrFormat> videoFormats;
};

