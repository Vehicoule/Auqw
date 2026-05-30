#include "YoutubeSabrSession.hpp"

#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QUrlQuery>

#include <algorithm>
#include <cstring>
#include <limits>
#include <utility>

namespace {

constexpr int webClientName = 1;

void appendProtoVarint(QByteArray& bytes, quint64 value) {
    while (value >= 0x80) {
        bytes.append(static_cast<char>((value & 0x7f) | 0x80));
        value >>= 7;
    }
    bytes.append(static_cast<char>(value));
}

void appendProtoTag(QByteArray& bytes, quint32 fieldNumber, quint32 wireType) {
    appendProtoVarint(bytes, (static_cast<quint64>(fieldNumber) << 3) | wireType);
}

void appendProtoInt(QByteArray& bytes, quint32 fieldNumber, qint64 value) {
    if (value == 0) {
        return;
    }
    appendProtoTag(bytes, fieldNumber, 0);
    appendProtoVarint(bytes, static_cast<quint64>(value));
}

void appendProtoBool(QByteArray& bytes, quint32 fieldNumber, bool value) {
    if (!value) {
        return;
    }
    appendProtoTag(bytes, fieldNumber, 0);
    appendProtoVarint(bytes, 1);
}

void appendProtoFloat(QByteArray& bytes, quint32 fieldNumber, float value) {
    quint32 raw = 0;
    std::memcpy(&raw, &value, sizeof(raw));
    appendProtoTag(bytes, fieldNumber, 5);
    bytes.append(static_cast<char>(raw & 0xff));
    bytes.append(static_cast<char>((raw >> 8) & 0xff));
    bytes.append(static_cast<char>((raw >> 16) & 0xff));
    bytes.append(static_cast<char>((raw >> 24) & 0xff));
}

void appendProtoBytes(QByteArray& bytes, quint32 fieldNumber, const QByteArray& value) {
    if (value.isEmpty()) {
        return;
    }
    appendProtoTag(bytes, fieldNumber, 2);
    appendProtoVarint(bytes, static_cast<quint64>(value.size()));
    bytes.append(value);
}

void appendProtoString(QByteArray& bytes, quint32 fieldNumber, const QString& value) {
    appendProtoBytes(bytes, fieldNumber, value.toUtf8());
}

void appendProtoMessage(QByteArray& bytes, quint32 fieldNumber, const QByteArray& message) {
    appendProtoBytes(bytes, fieldNumber, message);
}

QByteArray base64UrlDecode(const QString& text) {
    return QByteArray::fromBase64(
        text.toLatin1(),
        QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

QByteArray encodeFormatId(const YoutubeSabrFormat& format) {
    QByteArray bytes;
    appendProtoInt(bytes, 1, format.itag);
    appendProtoInt(bytes, 2, format.lastModified);
    appendProtoString(bytes, 3, format.xtags);
    return bytes;
}

QByteArray encodeClientAbrState(const YoutubeSabrFormat& audioFormat, qint64 playerTimeMs) {
    QByteArray bytes;
    appendProtoInt(bytes, 21, 360);
    appendProtoInt(bytes, 28, playerTimeMs);
    appendProtoInt(bytes, 34, 1);
    appendProtoFloat(bytes, 35, 1.0F);
    appendProtoInt(bytes, 40, 1);
    appendProtoBool(bytes, 46, audioFormat.isDrc);
    appendProtoString(bytes, 69, audioFormat.audioTrackId);
    return bytes;
}

QByteArray encodeClientInfo(const YoutubeSabrStreamInfo& streamInfo) {
    QByteArray bytes;
    appendProtoInt(bytes, 16, webClientName);
    appendProtoString(bytes, 17, streamInfo.clientVersion);
    appendProtoString(bytes, 18, QStringLiteral("Linux"));
    appendProtoString(bytes, 19, QStringLiteral("x86_64"));
    appendProtoString(bytes, 21, QStringLiteral("en-US"));
    appendProtoString(bytes, 22, QStringLiteral("US"));
    appendProtoInt(bytes, 37, 1920);
    appendProtoInt(bytes, 38, 1080);
    appendProtoInt(bytes, 41, 1);
    appendProtoInt(bytes, 46, 1);
    appendProtoInt(bytes, 55, 1280);
    appendProtoInt(bytes, 56, 720);
    return bytes;
}

QByteArray encodeSabrContext(int type, const QByteArray& value) {
    QByteArray bytes;
    appendProtoInt(bytes, 1, type);
    appendProtoBytes(bytes, 2, value);
    return bytes;
}

QByteArray encodeStreamerContext(const YoutubeSabrStreamInfo& streamInfo, const QHash<int, QByteArray>& contexts, const QByteArray& playbackCookie) {
    QByteArray bytes;
    appendProtoMessage(bytes, 1, encodeClientInfo(streamInfo));
    appendProtoBytes(bytes, 3, playbackCookie);
    for (auto it = contexts.constBegin(); it != contexts.constEnd(); ++it) {
        appendProtoMessage(bytes, 5, encodeSabrContext(it.key(), it.value()));
    }
    return bytes;
}

QNetworkRequest sabrRequest(const QUrl& url, const YoutubeSabrStreamInfo& streamInfo) {
    QNetworkRequest request(url);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/x-protobuf"));
    request.setRawHeader("Accept", "application/vnd.yt-ump");
    request.setRawHeader("Accept-Encoding", "identity");
    request.setRawHeader("Origin", "https://www.youtube.com");
    request.setRawHeader("Referer", "https://www.youtube.com/");
    request.setRawHeader("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
    request.setRawHeader("X-Youtube-Client-Name", QByteArray::number(webClientName));
    request.setRawHeader("X-Youtube-Client-Version", streamInfo.clientVersion.toUtf8());
    if (!streamInfo.visitorData.isEmpty()) {
        request.setRawHeader("X-Goog-Visitor-Id", streamInfo.visitorData.toUtf8());
    }
    return request;
}

} // namespace

YoutubeSabrSession::YoutubeSabrSession(YoutubeSabrStreamInfo streamInfo, QObject* parent)
    : QObject(parent),
      streamInfo_(std::move(streamInfo)),
      streamingUrl_(streamInfo_.serverAbrStreamingUrl) {}

YoutubeSabrSession::~YoutubeSabrSession() {
    cancel();
}

void YoutubeSabrSession::start() {
    if (started_) {
        return;
    }
    started_ = true;
    cancelled_ = false;

    if (!streamingUrl_.isValid() || streamingUrl_.isEmpty() || streamInfo_.audioFormats.isEmpty()) {
        emit streamError(QStringLiteral("Online playback unavailable. Try another result."));
        return;
    }

    sendRequest();
}

void YoutubeSabrSession::cancel() {
    cancelled_ = true;
    if (reply_) {
        reply_->abort();
        reply_->deleteLater();
        reply_.clear();
    }
}

void YoutubeSabrSession::sendRequest() {
    if (cancelled_) {
        return;
    }

    mediaSeenInRequest_ = false;
    mediaEndSeenInRequest_ = false;
    streamProtectionRequired_ = false;
    parser_.reset();

    QUrl requestUrl = streamingUrl_;
    QUrlQuery query(requestUrl);
    query.removeAllQueryItems(QStringLiteral("rn"));
    query.addQueryItem(QStringLiteral("rn"), QString::number(requestNumber_));
    requestUrl.setQuery(query);

    QNetworkReply* reply = network_.post(sabrRequest(requestUrl, streamInfo_), buildRequestBody());
    reply_ = reply;
    ++requestNumber_;

    connect(reply, &QNetworkReply::readyRead, this, [this, reply] {
        if (reply_ != reply || cancelled_) {
            return;
        }
        handleReplyBytes(reply->readAll());
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        if (reply_ != reply) {
            reply->deleteLater();
            return;
        }
        handleReplyFinished();
    });
}

void YoutubeSabrSession::handleReplyBytes(const QByteArray& bytes) {
    const YoutubeUmpParseResult parsed = parser_.append(bytes);
    if (!parsed.ok) {
        cancel();
        emit streamError(parsed.errorMessage);
        return;
    }

    for (const YoutubeUmpEvent& event : parsed.events) {
        switch (event.type) {
        case YoutubeUmpEventType::MediaHeader:
            lastMediaDurationMs_ = event.mediaHeader.durationMs;
            break;
        case YoutubeUmpEventType::Media:
            mediaSeenInRequest_ = true;
            break;
        case YoutubeUmpEventType::MediaEnd:
            mediaEndSeenInRequest_ = true;
            if (lastMediaDurationMs_ > 0) {
                playerTimeMs_ += lastMediaDurationMs_;
            }
            break;
        case YoutubeUmpEventType::Redirect:
            if (!event.text.isEmpty()) {
                streamingUrl_ = QUrl(event.text);
            }
            break;
        case YoutubeUmpEventType::SabrError:
            cancel();
            emit streamError(event.text.isEmpty()
                    ? QStringLiteral("YouTube SABR stream error.")
                    : QStringLiteral("YouTube SABR stream error: %1").arg(event.text));
            return;
        case YoutubeUmpEventType::ReloadPlayer:
            cancel();
            emit streamError(QStringLiteral("YouTube asked to reload this online stream."));
            return;
        case YoutubeUmpEventType::NextRequestPolicy:
            nextBackoffMs_ = std::clamp(event.code, 0, 8000);
            playbackCookie_ = event.bytes;
            break;
        case YoutubeUmpEventType::StreamProtectionStatus:
            streamProtectionRequired_ = event.code >= 2;
            break;
        case YoutubeUmpEventType::SabrContextUpdate:
            if (event.code > 0 && !event.bytes.isEmpty()) {
                sabrContexts_.insert(event.code, event.bytes);
            }
            break;
        case YoutubeUmpEventType::SabrContextSendingPolicy:
            break;
        }
    }

    if (!parsed.audioBytes.isEmpty()) {
        if (!firstAudioEmitted_) {
            firstAudioEmitted_ = true;
            emit firstAudioBytes(parsed.audioBytes.size());
        }
        emit audioBytesReady(parsed.audioBytes);
    }
}

void YoutubeSabrSession::handleReplyFinished() {
    QNetworkReply* reply = reply_.data();
    reply_.clear();
    const bool networkFailed = reply != nullptr && reply->error() != QNetworkReply::NoError && reply->error() != QNetworkReply::OperationCanceledError;
    const int statusCode = reply != nullptr ? reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() : 0;
    if (reply != nullptr) {
        reply->deleteLater();
    }

    if (cancelled_) {
        return;
    }
    if (statusCode == 403 && !mediaSeenInRequest_) {
        emit streamError(QStringLiteral("Stream protection required for this YouTube stream."));
        return;
    }
    if (networkFailed) {
        emit streamError(QStringLiteral("Online stream network request failed."));
        return;
    }
    if (streamProtectionRequired_ && !mediaSeenInRequest_) {
        emit streamError(QStringLiteral("Stream protection required for this YouTube stream."));
        return;
    }
    if (!mediaSeenInRequest_ && !mediaEndSeenInRequest_) {
        emit streamEnded();
        return;
    }

    scheduleNextRequest(nextBackoffMs_);
}

void YoutubeSabrSession::scheduleNextRequest(int backoffMs) {
    if (cancelled_) {
        return;
    }
    QTimer::singleShot(std::clamp(backoffMs, 0, 8000), this, [this] {
        sendRequest();
    });
}

QByteArray YoutubeSabrSession::buildRequestBody() const {
    const YoutubeSabrFormat audioFormat = selectedAudioFormat();

    QByteArray bytes;
    appendProtoMessage(bytes, 1, encodeClientAbrState(audioFormat, playerTimeMs_));
    appendProtoBytes(bytes, 5, base64UrlDecode(streamInfo_.videoPlaybackUstreamerConfig));
    appendProtoMessage(bytes, 16, encodeFormatId(audioFormat));
    appendProtoMessage(bytes, 19, encodeStreamerContext(streamInfo_, sabrContexts_, playbackCookie_));
    return bytes;
}

YoutubeSabrFormat YoutubeSabrSession::selectedAudioFormat() const {
    if (streamInfo_.audioFormats.isEmpty()) {
        return {};
    }
    return *std::max_element(streamInfo_.audioFormats.cbegin(), streamInfo_.audioFormats.cend(), [](const YoutubeSabrFormat& left, const YoutubeSabrFormat& right) {
        return left.bitrate < right.bitrate;
    });
}
