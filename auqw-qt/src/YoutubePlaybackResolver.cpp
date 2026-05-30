#include "YoutubePlaybackResolver.hpp"

#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>

#include <utility>

namespace {

constexpr auto musicOrigin = "https://music.youtube.com";
constexpr auto musicReferer = "https://music.youtube.com/";
constexpr auto playerEndpoint = "https://music.youtube.com/youtubei/v1/player?prettyPrint=false";
constexpr auto directPlaybackFailedMessage = "Online playback unavailable. YouTube rejected all stream clients.";

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
