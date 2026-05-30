#pragma once

#include <QByteArray>
#include <QString>
#include <QVector>

enum class YoutubeUmpEventType {
    MediaHeader,
    Media,
    MediaEnd,
    Redirect,
    SabrError,
    ReloadPlayer,
    NextRequestPolicy,
    StreamProtectionStatus,
    SabrContextUpdate,
    SabrContextSendingPolicy,
};

struct YoutubeUmpMediaHeader {
    int headerId = 0;
    int itag = 0;
    qint64 sequenceNumber = 0;
    qint64 durationMs = 0;
    qint64 contentLength = 0;
};

struct YoutubeUmpEvent {
    YoutubeUmpEventType type = YoutubeUmpEventType::Media;
    YoutubeUmpMediaHeader mediaHeader;
    QString text;
    int code = 0;
    QByteArray bytes;
};

struct YoutubeUmpParseResult {
    bool ok = true;
    QVector<YoutubeUmpEvent> events;
    QByteArray audioBytes;
    QString errorMessage;
};

class YoutubeUmpParser {
public:
    YoutubeUmpParseResult append(const QByteArray& chunk);
    void reset();

private:
    QByteArray buffer_;
};

