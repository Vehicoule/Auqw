#include "YoutubePlaybackResolver.hpp"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QJsonValue>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QUrlQuery>

#include <algorithm>
#include <utility>

namespace {

constexpr auto providerId = "ytmusic";
constexpr auto musicOrigin = "https://music.youtube.com";
constexpr auto musicReferer = "https://music.youtube.com/";
constexpr auto playerEndpoint = "https://music.youtube.com/youtubei/v1/player?prettyPrint=false";
constexpr auto directPlaybackFailedMessage = "Online playback unavailable. YouTube rejected all stream clients.";

bool isAudioMimeType(const QString& mimeType) {
    return mimeType.startsWith(QStringLiteral("audio/"), Qt::CaseInsensitive);
}

int codecRank(const QString& mimeType) {
    if (mimeType.contains(QStringLiteral("opus"), Qt::CaseInsensitive)) {
        return 3;
    }
    if (mimeType.contains(QStringLiteral("mp4a"), Qt::CaseInsensitive)) {
        return 2;
    }
    return 1;
}

qint64 jsonInt64(const QJsonObject& object, const QString& key) {
    const QJsonValue value = object.value(key);
    if (value.isString()) {
        bool ok = false;
        const qint64 number = value.toString().toLongLong(&ok);
        return ok ? number : 0;
    }
    if (value.isDouble()) {
        return static_cast<qint64>(value.toDouble());
    }
    return 0;
}

QUrl patchClientVersion(QUrl url, const QString& clientVersion) {
    QUrlQuery query(url);
    if (query.hasQueryItem(QStringLiteral("cver"))) {
        query.removeAllQueryItems(QStringLiteral("cver"));
        query.addQueryItem(QStringLiteral("cver"), clientVersion);
        url.setQuery(query);
    }
    return url;
}

QList<QPair<QByteArray, QByteArray>> mediaRequestHeaders(const YoutubeClientProfile& profile) {
    return {
        {QByteArrayLiteral("User-Agent"), profile.userAgent.toUtf8()},
    };
}

QNetworkRequest playerRequest(const YoutubeClientProfile& profile, const QString& visitorData) {
    QNetworkRequest request(QUrl(QString::fromLatin1(playerEndpoint)));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setRawHeader("X-Goog-Api-Format-Version", "1");
    request.setRawHeader("X-YouTube-Client-Name", profile.clientId.toUtf8());
    request.setRawHeader("X-YouTube-Client-Version", profile.clientVersion.toUtf8());
    request.setRawHeader("X-Origin", musicOrigin);
    request.setRawHeader("Origin", musicOrigin);
    request.setRawHeader("Referer", musicReferer);
    request.setRawHeader("User-Agent", profile.userAgent.toUtf8());
    if (!visitorData.isEmpty()) {
        request.setRawHeader("X-Goog-Visitor-Id", visitorData.toUtf8());
    }
    return request;
}

QNetworkRequest streamProbeRequest(const OnlineStreamResult& stream) {
    QNetworkRequest request(stream.streamUrl);
    request.setRawHeader("Range", "bytes=0-0");
    for (const auto& header : stream.requestHeaders) {
        request.setRawHeader(header.first, header.second);
    }
    return request;
}

QString friendlyPlayabilityError(const QJsonObject& root) {
    const QJsonObject status = root.value(QStringLiteral("playabilityStatus")).toObject();
    const QString reason = status.value(QStringLiteral("reason")).toString();
    const QString code = status.value(QStringLiteral("status")).toString();
    const QString lower = reason.toLower();
    if (code == QStringLiteral("LOGIN_REQUIRED")
        || lower.contains(QStringLiteral("bot"))
        || lower.contains(QStringLiteral("not a bot"))
        || lower.contains(QStringLiteral("unusual traffic"))) {
        return QStringLiteral("Stream protection required for this YouTube stream.");
    }
    if (!reason.isEmpty()) {
        return reason;
    }
    return QString::fromLatin1(directPlaybackFailedMessage);
}

} // namespace

YoutubePlaybackResolver::YoutubePlaybackResolver(
    QString providerTrackId,
    QString visitorData,
    std::optional<OnlineStreamResult> fallbackStream,
    QObject* parent)
    : QObject(parent),
      providerTrackId_(std::move(providerTrackId)),
      visitorData_(std::move(visitorData)),
      fallbackStream_(std::move(fallbackStream)),
      profiles_(playbackClientProfiles()) {}

void YoutubePlaybackResolver::start() {
    profileIndex_ = 0;
    tryNextClient();
}

QVector<YoutubeClientProfile> YoutubePlaybackResolver::playbackClientProfiles() {
    // Client profile values follow OpenTune's Android VR-first playback matrix.
    return {
        YoutubeClientProfile{
            .key = QStringLiteral("ANDROID_VR_NO_AUTH"),
            .clientName = QStringLiteral("ANDROID_VR"),
            .clientVersion = QStringLiteral("1.37"),
            .clientId = QStringLiteral("28"),
            .userAgent = QStringLiteral("com.google.android.apps.youtube.vr.oculus/1.37 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/107.0.5284.2)"),
            .osName = QStringLiteral("Android"),
            .osVersion = QStringLiteral("12"),
            .deviceMake = QStringLiteral("Oculus"),
            .deviceModel = QStringLiteral("Quest 3"),
            .androidSdkVersion = QStringLiteral("32"),
        },
        YoutubeClientProfile{
            .key = QStringLiteral("ANDROID_VR_1_61_48"),
            .clientName = QStringLiteral("ANDROID_VR"),
            .clientVersion = QStringLiteral("1.61.48"),
            .clientId = QStringLiteral("28"),
            .userAgent = QStringLiteral("com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3)"),
            .osName = QStringLiteral("Android"),
            .osVersion = QStringLiteral("12"),
            .deviceMake = QStringLiteral("Oculus"),
            .deviceModel = QStringLiteral("Quest 3"),
            .androidSdkVersion = QStringLiteral("32"),
        },
        YoutubeClientProfile{
            .key = QStringLiteral("ANDROID_VR_1_43_32"),
            .clientName = QStringLiteral("ANDROID_VR"),
            .clientVersion = QStringLiteral("1.43.32"),
            .clientId = QStringLiteral("28"),
            .userAgent = QStringLiteral("com.google.android.apps.youtube.vr.oculus/1.43.32 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/107.0.5284.2)"),
            .osName = QStringLiteral("Android"),
            .osVersion = QStringLiteral("12"),
            .deviceMake = QStringLiteral("Oculus"),
            .deviceModel = QStringLiteral("Quest 3"),
            .androidSdkVersion = QStringLiteral("32"),
        },
        YoutubeClientProfile{
            .key = QStringLiteral("IOS"),
            .clientName = QStringLiteral("IOS"),
            .clientVersion = QStringLiteral("19.29.1"),
            .clientId = QStringLiteral("5"),
            .userAgent = QStringLiteral("com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)"),
            .osName = QStringLiteral("iOS"),
            .osVersion = QStringLiteral("17.5.1.21F90"),
        },
        YoutubeClientProfile{
            .key = QStringLiteral("ANDROID"),
            .clientName = QStringLiteral("ANDROID"),
            .clientVersion = QStringLiteral("21.10.38"),
            .clientId = QStringLiteral("3"),
            .userAgent = QStringLiteral("com.google.android.youtube/21.10.38 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/AP4A.250205.002; Cronet/132.0.6834.79) gzip"),
            .osName = QStringLiteral("Android"),
            .osVersion = QStringLiteral("15"),
            .deviceMake = QStringLiteral("Google"),
            .deviceModel = QStringLiteral("Pixel 9 Pro"),
            .androidSdkVersion = QStringLiteral("35"),
            .useSignatureTimestamp = true,
        },
        YoutubeClientProfile{
            .key = QStringLiteral("ANDROID_MUSIC"),
            .clientName = QStringLiteral("ANDROID_MUSIC"),
            .clientVersion = QStringLiteral("7.27.52"),
            .clientId = QStringLiteral("21"),
            .userAgent = QStringLiteral("com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/AP4A.250205.002; Cronet/132.0.6834.79) gzip"),
            .osName = QStringLiteral("Android"),
            .osVersion = QStringLiteral("15"),
            .deviceMake = QStringLiteral("Google"),
            .deviceModel = QStringLiteral("Pixel 9 Pro"),
            .androidSdkVersion = QStringLiteral("35"),
            .useSignatureTimestamp = true,
        },
        YoutubeClientProfile{
            .key = QStringLiteral("IOS_MUSIC"),
            .clientName = QStringLiteral("IOS_MUSIC"),
            .clientVersion = QStringLiteral("7.27.0"),
            .clientId = QStringLiteral("26"),
            .userAgent = QStringLiteral("com.google.ios.youtubemusic/7.27.0 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)"),
            .osName = QStringLiteral("iOS"),
            .osVersion = QStringLiteral("17.5.1.21F90"),
            .deviceMake = QStringLiteral("Apple"),
            .deviceModel = QStringLiteral("iPhone16,2"),
        },
        YoutubeClientProfile{
            .key = QStringLiteral("TVHTML5"),
            .clientName = QStringLiteral("TVHTML5"),
            .clientVersion = QStringLiteral("7.20260114.00.00"),
            .clientId = QStringLiteral("7"),
            .userAgent = QStringLiteral("Mozilla/5.0(SMART-TV; Linux; Tizen 4.0.0.2) AppleWebkit/605.1.15 (KHTML, like Gecko) SamsungBrowser/9.2 TV Safari/605.1.15"),
            .loginRequired = true,
            .useSignatureTimestamp = true,
        },
        YoutubeClientProfile{
            .key = QStringLiteral("WEB_REMIX"),
            .clientName = QStringLiteral("WEB_REMIX"),
            .clientVersion = QStringLiteral("1.20260114.01.00"),
            .clientId = QStringLiteral("67"),
            .userAgent = QStringLiteral("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"),
            .useSignatureTimestamp = true,
        },
    };
}

QJsonObject YoutubePlaybackResolver::playerRequestBody(
    const YoutubeClientProfile& profile,
    const QString& providerTrackId,
    const QString& visitorData,
    int signatureTimestamp) {
    QJsonObject client{
        {QStringLiteral("clientName"), profile.clientName},
        {QStringLiteral("clientVersion"), profile.clientVersion},
        {QStringLiteral("hl"), QStringLiteral("en")},
        {QStringLiteral("gl"), QStringLiteral("US")},
    };
    if (!profile.osName.isEmpty()) {
        client.insert(QStringLiteral("osName"), profile.osName);
    }
    if (!profile.osVersion.isEmpty()) {
        client.insert(QStringLiteral("osVersion"), profile.osVersion);
    }
    if (!profile.deviceMake.isEmpty()) {
        client.insert(QStringLiteral("deviceMake"), profile.deviceMake);
    }
    if (!profile.deviceModel.isEmpty()) {
        client.insert(QStringLiteral("deviceModel"), profile.deviceModel);
    }
    if (!profile.androidSdkVersion.isEmpty()) {
        client.insert(QStringLiteral("androidSdkVersion"), profile.androidSdkVersion);
    }
    if (!visitorData.isEmpty()) {
        client.insert(QStringLiteral("visitorData"), visitorData);
    }

    QJsonObject body{
        {QStringLiteral("context"), QJsonObject{{QStringLiteral("client"), client}}},
        {QStringLiteral("videoId"), providerTrackId},
        {QStringLiteral("contentCheckOk"), true},
        {QStringLiteral("racyCheckOk"), true},
    };
    if (profile.embedded) {
        body[QStringLiteral("context")] = QJsonObject{
            {QStringLiteral("client"), client},
            {QStringLiteral("thirdParty"), QJsonObject{{QStringLiteral("embedUrl"), QStringLiteral("https://www.youtube.com/watch?v=%1").arg(providerTrackId)}}},
        };
    }
    if (profile.useSignatureTimestamp && signatureTimestamp > 0) {
        body.insert(QStringLiteral("playbackContext"), QJsonObject{
            {QStringLiteral("contentPlaybackContext"), QJsonObject{{QStringLiteral("signatureTimestamp"), signatureTimestamp}}},
        });
    }
    return body;
}

OnlineStreamResolveResult YoutubePlaybackResolver::parsePlayerResponse(
    const QByteArray& payload,
    const QString& providerTrackId,
    const YoutubeClientProfile& profile) {
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Provider returned invalid stream data."),
        };
    }

    const QJsonObject root = document.object();
    const QString playability = root.value(QStringLiteral("playabilityStatus")).toObject().value(QStringLiteral("status")).toString();
    if (!playability.isEmpty() && playability != QStringLiteral("OK")) {
        return {
            .ok = false,
            .errorMessage = friendlyPlayabilityError(root),
        };
    }

    const QJsonObject streamingData = root.value(QStringLiteral("streamingData")).toObject();
    const qint64 expiresInSeconds = jsonInt64(streamingData, QStringLiteral("expiresInSeconds"));
    const QJsonArray formats = streamingData.value(QStringLiteral("adaptiveFormats")).toArray();

    QJsonObject bestFormat;
    QUrl bestUrl;
    int bestBitrate = -1;
    int bestCodecRank = -1;
    for (const QJsonValue& value : formats) {
        const QJsonObject format = value.toObject();
        const QString mimeType = format.value(QStringLiteral("mimeType")).toString();
        if (!isAudioMimeType(mimeType)) {
            continue;
        }
        const QString urlText = format.value(QStringLiteral("url")).toString();
        if (urlText.isEmpty()) {
            continue;
        }
        QUrl url(urlText);
        if (!url.isValid() || url.isEmpty()) {
            continue;
        }
        url = patchClientVersion(url, profile.clientVersion);
        const int bitrate = format.value(QStringLiteral("bitrate")).toInt(0);
        const int rank = codecRank(mimeType);
        if (bestUrl.isEmpty() || bitrate > bestBitrate || (bitrate == bestBitrate && rank > bestCodecRank)) {
            bestFormat = format;
            bestUrl = url;
            bestBitrate = bitrate;
            bestCodecRank = rank;
        }
    }

    if (bestUrl.isEmpty()) {
        return {
            .ok = false,
            .errorMessage = QString::fromLatin1(directPlaybackFailedMessage),
        };
    }

    const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
    OnlineStreamResult stream;
    stream.provider = QString::fromLatin1(providerId);
    stream.providerTrackId = providerTrackId;
    stream.streamUrl = bestUrl;
    stream.mimeType = bestFormat.value(QStringLiteral("mimeType")).toString();
    stream.streamKind = OnlineStreamKind::HeaderedDirectUrl;
    stream.requestHeaders = mediaRequestHeaders(profile);
    stream.clientName = profile.clientName;
    stream.clientVersion = profile.clientVersion;
    stream.itag = bestFormat.value(QStringLiteral("itag")).toInt();
    stream.expiresAtMs = expiresInSeconds > 0 ? nowMs + (expiresInSeconds * 1000) : 0;

    return {
        .ok = true,
        .stream = stream,
    };
}

void YoutubePlaybackResolver::tryNextClient() {
    while (profileIndex_ < profiles_.size() && profiles_.at(profileIndex_).loginRequired) {
        ++profileIndex_;
    }

    if (profileIndex_ >= profiles_.size()) {
        finishWithFallbackOrError(lastErrorMessage_.isEmpty() ? QString::fromLatin1(directPlaybackFailedMessage) : lastErrorMessage_);
        return;
    }

    const YoutubeClientProfile profile = profiles_.at(profileIndex_++);
    QNetworkReply* reply = network_.post(
        playerRequest(profile, visitorData_),
        QJsonDocument(playerRequestBody(profile, providerTrackId_, visitorData_)).toJson(QJsonDocument::Compact));

    connect(reply, &QNetworkReply::finished, this, [this, reply, profile] {
        const QByteArray payload = reply->readAll();
        const bool networkFailed = reply->error() != QNetworkReply::NoError;
        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        reply->deleteLater();

        if (networkFailed || statusCode >= 400) {
            lastErrorMessage_ = QString::fromLatin1(directPlaybackFailedMessage);
            tryNextClient();
            return;
        }

        const OnlineStreamResolveResult parsed = parsePlayerResponse(payload, providerTrackId_, profile);
        if (!parsed.ok) {
            lastErrorMessage_ = parsed.errorMessage;
            tryNextClient();
            return;
        }

        validateStream(parsed.stream, profile);
    });
}

void YoutubePlaybackResolver::validateStream(OnlineStreamResult stream, const YoutubeClientProfile& profile) {
    Q_UNUSED(profile);
    QNetworkReply* reply = network_.get(streamProbeRequest(stream));
    connect(reply, &QNetworkReply::finished, this, [this, reply, stream = std::move(stream)] {
        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        reply->deleteLater();

        if ((statusCode >= 200 && statusCode < 400) || statusCode == 416) {
            emit resolved(stream);
            return;
        }

        if (statusCode == 403) {
            lastErrorMessage_ = QStringLiteral("Stream protection required for this YouTube stream.");
        } else {
            lastErrorMessage_ = QString::fromLatin1(directPlaybackFailedMessage);
        }
        tryNextClient();
    });
}

void YoutubePlaybackResolver::finishWithFallbackOrError(const QString& message) {
    if (fallbackStream_.has_value()) {
        emit resolved(*fallbackStream_);
        return;
    }
    emit failed(message);
}
