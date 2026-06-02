#include "InnertubeProvider.hpp"
#include "YoutubePlaybackResolver.hpp"

#include <QDebug>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QUrl>
#include <QUrlQuery>
#include <QtGlobal>

#include <memory>
#include <optional>
#include <utility>

namespace {

constexpr auto providerId = "ytmusic";
constexpr auto modernBrowserUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
constexpr auto defaultSearchClientVersion = "1.20240522.01.00";

struct YoutubeWebBootstrap {
    bool ok = false;
    QByteArray playerResponse;
    QString apiKey;
    QString clientVersion;
    QString visitorData;
    QString videoPlaybackUstreamerConfig;
    int signatureTimestamp = 0;
    QString errorMessage;
};

struct InnertubeBootstrap {
    bool ok = false;
    QString apiKey;
    QString clientVersion;
    QString errorMessage;
};

#ifndef QT_NO_DEBUG
bool playbackTraceEnabled() {
    static const bool enabled = [] {
        bool ok = false;
        const int value = qEnvironmentVariableIntValue("AUQW_PLAYBACK_TRACE", &ok);
        return ok ? value != 0 : qEnvironmentVariableIsSet("AUQW_PLAYBACK_TRACE");
    }();
    return enabled;
}

QString streamKindName(OnlineStreamKind kind) {
    switch (kind) {
    case OnlineStreamKind::DirectUrl:
        return QStringLiteral("direct_url");
    case OnlineStreamKind::HeaderedDirectUrl:
        return QStringLiteral("headered_direct_url");
    case OnlineStreamKind::Sabr:
        return QStringLiteral("sabr");
    }
    return QStringLiteral("unknown");
}

void logSearchNetworkFailure(const QNetworkReply* reply, int statusCode) {
    qWarning().noquote() << "Auqw search network error="
                         << (reply == nullptr ? QNetworkReply::UnknownNetworkError : reply->error())
                         << "errorString="
                         << (reply == nullptr ? QStringLiteral("missing QNetworkReply") : reply->errorString())
                         << "httpStatus=" << statusCode;
}

void logBootstrapNetworkFailure(const QNetworkReply* reply, int statusCode) {
    qWarning().noquote() << "Auqw bootstrap network error="
                         << (reply == nullptr ? QNetworkReply::UnknownNetworkError : reply->error())
                         << "errorString="
                         << (reply == nullptr ? QStringLiteral("missing QNetworkReply") : reply->errorString())
                         << "httpStatus=" << statusCode;
}

void logBootstrapParseFailure(qsizetype payloadSize) {
    qWarning().noquote() << "Auqw bootstrap parse failed"
                         << "payloadBytes=" << payloadSize;
}

void logStreamResolveChoice(const char* event, const OnlineStreamResult& stream) {
    if (!playbackTraceEnabled()) {
        return;
    }

    const QUrl playbackUrl = stream.streamKind == OnlineStreamKind::Sabr || stream.isSabr
        ? stream.sabr.serverAbrStreamingUrl
        : stream.streamUrl;
    qDebug().noquote()
        << "Auqw stream resolve"
        << "event=" << QString::fromLatin1(event)
        << "kind=" << streamKindName(stream.streamKind)
        << "isSabr=" << stream.isSabr
        << "mimeType=" << (stream.mimeType.isEmpty() ? QStringLiteral("<empty>") : stream.mimeType)
        << "itag=" << stream.itag
        << "client=" << (stream.clientName.isEmpty() ? QStringLiteral("<none>") : stream.clientName)
        << "host=" << (playbackUrl.host().isEmpty() ? QStringLiteral("<none>") : playbackUrl.host())
        << "sabrFormats=" << stream.sabr.audioFormats.size()
        << "hasUstreamerConfig=" << !stream.sabr.videoPlaybackUstreamerConfig.isEmpty();
}
#else
void logSearchNetworkFailure(const QNetworkReply*, int) {}
void logBootstrapNetworkFailure(const QNetworkReply*, int) {}
void logBootstrapParseFailure(qsizetype) {}
void logStreamResolveChoice(const char*, const OnlineStreamResult&) {}
#endif

QJsonObject searchContext(const QString& clientVersion = {}) {
    const QString normalizedClientVersion = clientVersion.trimmed().isEmpty()
        ? QString::fromLatin1(defaultSearchClientVersion)
        : clientVersion.trimmed();
    return QJsonObject{
        {QStringLiteral("client"),
         QJsonObject{
             {QStringLiteral("clientName"), QStringLiteral("WEB_REMIX")},
             {QStringLiteral("clientVersion"), normalizedClientVersion},
         }},
    };
}

QUrl youtubeMusicBaseUrl() {
    const QString configuredBaseUrl = qEnvironmentVariable("AUQW_YTMUSIC_BASE_URL").trimmed();
    if (!configuredBaseUrl.isEmpty()) {
        QUrl url(configuredBaseUrl);
        if (url.isValid() && !url.scheme().isEmpty() && !url.host().isEmpty()) {
            if (url.path().isEmpty()) {
                url.setPath(QStringLiteral("/"));
            }
            return url;
        }
    }

    return QUrl(QStringLiteral("https://music.youtube.com/"));
}

QUrl youtubeMusicBootstrapUrl() {
    QUrl url = youtubeMusicBaseUrl();

    QUrlQuery query;
    query.addQueryItem(QStringLiteral("ucbcb"), QStringLiteral("1"));
    url.setQuery(query);
    return url;
}

QUrl innertubeEndpointUrl(const QString& endpoint, const QString& apiKey) {
    QUrl url = youtubeMusicBaseUrl();
    url.setPath(QStringLiteral("/youtubei/v1/") + endpoint);

    QUrlQuery query;
    query.addQueryItem(QStringLiteral("prettyPrint"), QStringLiteral("false"));
    query.addQueryItem(QStringLiteral("key"), apiKey);
    url.setQuery(query);
    return url;
}

QNetworkRequest innertubeJsonRequest(const QUrl& url) {
    QNetworkRequest request(url);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setRawHeader("Origin", "https://music.youtube.com");
    request.setRawHeader("Referer", "https://music.youtube.com/");
    request.setRawHeader("User-Agent", modernBrowserUserAgent);
    return request;
}

QNetworkRequest youtubeWatchRequest(const QUrl& url) {
    QNetworkRequest request(url);
    request.setRawHeader("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    request.setRawHeader("Accept-Language", "en-US,en;q=0.9");
    request.setRawHeader("User-Agent", modernBrowserUserAgent);
    return request;
}

QString capturedText(const QByteArray& payload, const QString& pattern) {
    const QRegularExpression expression(pattern);
    const QRegularExpressionMatch match = expression.match(QString::fromUtf8(payload));
    return match.hasMatch() ? match.captured(1) : QString{};
}

InnertubeBootstrap parseInnertubeBootstrap(const QByteArray& payload) {
    const QString apiKey = capturedText(payload, QStringLiteral("\\\"INNERTUBE_API_KEY\\\"\\s*:\\s*\\\"([^\\\"]+)"));
    if (apiKey.isEmpty()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Provider returned invalid bootstrap data."),
        };
    }

    QString clientVersion = capturedText(payload, QStringLiteral("\\\"INNERTUBE_CLIENT_VERSION\\\"\\s*:\\s*\\\"([^\\\"]+)"));
    if (clientVersion.isEmpty()) {
        clientVersion = QString::fromLatin1(defaultSearchClientVersion);
    }

    return {
        .ok = true,
        .apiKey = apiKey,
        .clientVersion = clientVersion,
    };
}

QByteArray extractJsonObject(const QByteArray& payload, const QByteArray& marker) {
    const qsizetype markerIndex = payload.indexOf(marker);
    if (markerIndex < 0) {
        return {};
    }
    const qsizetype start = payload.indexOf('{', markerIndex + marker.size());
    if (start < 0) {
        return {};
    }

    bool inString = false;
    bool escaped = false;
    int depth = 0;
    for (qsizetype index = start; index < payload.size(); ++index) {
        const char ch = payload.at(index);
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch == '\\') {
                escaped = true;
            } else if (ch == '"') {
                inString = false;
            }
            continue;
        }

        if (ch == '"') {
            inString = true;
        } else if (ch == '{') {
            ++depth;
        } else if (ch == '}') {
            --depth;
            if (depth == 0) {
                return payload.mid(start, index - start + 1);
            }
        }
    }

    return {};
}

YoutubeWebBootstrap parseWebBootstrap(const QByteArray& payload) {
    const QByteArray playerResponse = extractJsonObject(payload, QByteArrayLiteral("ytInitialPlayerResponse"));
    if (playerResponse.isEmpty()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Provider returned invalid stream data."),
        };
    }

    bool signatureOk = false;
    const int signatureTimestamp = capturedText(payload, QStringLiteral("\\\"signatureTimestamp\\\"\\s*:\\s*(\\d+)")).toInt(&signatureOk);

    return {
        .ok = true,
        .playerResponse = playerResponse,
        .apiKey = capturedText(payload, QStringLiteral("\\\"INNERTUBE_API_KEY\\\"\\s*:\\s*\\\"([^\\\"]+)")),
        .clientVersion = capturedText(payload, QStringLiteral("\\\"INNERTUBE_CLIENT_VERSION\\\"\\s*:\\s*\\\"([^\\\"]+)")),
        .visitorData = capturedText(payload, QStringLiteral("\\\"visitorData\\\"\\s*:\\s*\\\"([^\\\"]+)")),
        .videoPlaybackUstreamerConfig = capturedText(payload, QStringLiteral("\\\"videoPlaybackUstreamerConfig\\\"\\s*:\\s*\\\"([^\\\"]+)")),
        .signatureTimestamp = signatureOk ? signatureTimestamp : 0,
    };
}

} // namespace

InnertubeProvider::InnertubeProvider(QObject* parent)
    : OnlineProvider(parent) {}

QString InnertubeProvider::name() const {
    return QString::fromLatin1(providerId);
}

OnlineProviderCapabilities InnertubeProvider::capabilities() const {
    return OnlineProviderCapabilities{
        .search = true,
        .suggestions = true,
        .metadata = true,
        .playback = true,
        .downloads = true,
    };
}

void InnertubeProvider::searchTracks(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    if (trimmedQuery.isEmpty()) {
        emit searchSucceeded(trimmedQuery, {});
        return;
    }

    withInnertubeBootstrap(
        [this, trimmedQuery](const QString& apiKey, const QString& clientVersion) {
            postSearchRequest(trimmedQuery, apiKey, clientVersion);
        },
        [this, trimmedQuery] {
            emit searchFailed(trimmedQuery, QStringLiteral("Search unavailable. Try again."));
        });
}

void InnertubeProvider::postSearchRequest(const QString& trimmedQuery, const QString& apiKey, const QString& clientVersion) {
    QNetworkRequest request = innertubeJsonRequest(innertubeEndpointUrl(QStringLiteral("search"), apiKey));

    const QJsonObject body{
        {QStringLiteral("context"), searchContext(clientVersion)},
        {QStringLiteral("query"), trimmedQuery},
        {QStringLiteral("params"), QStringLiteral("EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D")},
    };

    QNetworkReply* reply = network_.post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [this, reply, trimmedQuery] {
        const QByteArray payload = reply->readAll();
        const bool networkFailed = reply->error() != QNetworkReply::NoError;
        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        reply->deleteLater();

        if (networkFailed || statusCode >= 400) {
            logSearchNetworkFailure(reply, statusCode);
            emit searchFailed(trimmedQuery, QStringLiteral("Search unavailable. Try again."));
            return;
        }

        const OnlineSearchParseResult parsed = parseTrackSearchResults(payload);
        if (!parsed.ok) {
            emit searchFailed(trimmedQuery, parsed.errorMessage);
            return;
        }

        emit searchSucceeded(trimmedQuery, parsed.tracks);
    });
}

void InnertubeProvider::suggestTracks(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    if (trimmedQuery.isEmpty()) {
        emit suggestionsSucceeded(trimmedQuery, {});
        return;
    }

    withInnertubeBootstrap(
        [this, trimmedQuery](const QString& apiKey, const QString& clientVersion) {
            postSuggestionsRequest(trimmedQuery, apiKey, clientVersion);
        },
        [this, trimmedQuery] {
            emit suggestionsFailed(trimmedQuery, QStringLiteral("Suggestions unavailable. Try again."));
        });
}

void InnertubeProvider::postSuggestionsRequest(const QString& trimmedQuery, const QString& apiKey, const QString& clientVersion) {
    QNetworkRequest request = innertubeJsonRequest(innertubeEndpointUrl(QStringLiteral("music/get_search_suggestions"), apiKey));
    const QJsonObject body{
        {QStringLiteral("context"), searchContext(clientVersion)},
        {QStringLiteral("input"), trimmedQuery},
    };

    QNetworkReply* reply = network_.post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [this, reply, trimmedQuery] {
        const QByteArray payload = reply->readAll();
        const bool networkFailed = reply->error() != QNetworkReply::NoError;
        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        reply->deleteLater();

        if (networkFailed || statusCode >= 400) {
            emit suggestionsFailed(trimmedQuery, QStringLiteral("Suggestions unavailable. Try again."));
            return;
        }

        const OnlineSuggestionsParseResult parsed = parseSearchSuggestions(payload);
        if (!parsed.ok) {
            emit suggestionsFailed(trimmedQuery, parsed.errorMessage);
            return;
        }

        emit suggestionsSucceeded(trimmedQuery, parsed.suggestions);
    });
}

void InnertubeProvider::withInnertubeBootstrap(
    std::function<void(const QString& apiKey, const QString& clientVersion)> onReady,
    std::function<void()> onFailed) {
    const QString configuredApiKey = qEnvironmentVariable("AUQW_INNERTUBE_API_KEY").trimmed();
    if (!configuredApiKey.isEmpty()) {
        onReady(configuredApiKey, QString::fromLatin1(defaultSearchClientVersion));
        return;
    }

    if (!innertubeApiKey_.isEmpty()) {
        onReady(innertubeApiKey_, innertubeClientVersion_);
        return;
    }

    QNetworkReply* reply = network_.get(youtubeWatchRequest(youtubeMusicBootstrapUrl()));
    connect(reply, &QNetworkReply::finished, this, [this, reply, onReady = std::move(onReady), onFailed = std::move(onFailed)]() mutable {
        const QByteArray payload = reply->readAll();
        const bool networkFailed = reply->error() != QNetworkReply::NoError;
        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        reply->deleteLater();

        if (networkFailed || statusCode >= 400) {
            logBootstrapNetworkFailure(reply, statusCode);
            onFailed();
            return;
        }

        const InnertubeBootstrap bootstrap = parseInnertubeBootstrap(payload);
        if (!bootstrap.ok) {
            logBootstrapParseFailure(payload.size());
            onFailed();
            return;
        }

        innertubeApiKey_ = bootstrap.apiKey;
        innertubeClientVersion_ = bootstrap.clientVersion;
        onReady(innertubeApiKey_, innertubeClientVersion_);
    });
}

void InnertubeProvider::fetchTrackMetadata(const QString& provider, const QString& providerTrackId) {
    if (provider != name() || providerTrackId.trimmed().isEmpty()) {
        emit metadataFailed(provider, providerTrackId, QStringLiteral("Metadata unavailable for this track."));
        return;
    }

    QUrl watchUrl(QStringLiteral("https://www.youtube.com/watch"));
    QUrlQuery query;
    query.addQueryItem(QStringLiteral("v"), providerTrackId.trimmed());
    query.addQueryItem(QStringLiteral("bpctr"), QStringLiteral("9999999999"));
    query.addQueryItem(QStringLiteral("has_verified"), QStringLiteral("1"));
    watchUrl.setQuery(query);

    QNetworkReply* reply = network_.get(youtubeWatchRequest(watchUrl));
    connect(reply, &QNetworkReply::finished, this, [this, reply, provider, providerTrackId] {
        const QByteArray payload = reply->readAll();
        const bool networkFailed = reply->error() != QNetworkReply::NoError;
        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        reply->deleteLater();

        if (networkFailed || statusCode >= 400) {
            emit metadataFailed(provider, providerTrackId, QStringLiteral("Metadata unavailable for this track."));
            return;
        }

        const YoutubeWebBootstrap bootstrap = parseWebBootstrap(payload);
        if (!bootstrap.ok) {
            emit metadataFailed(provider, providerTrackId, bootstrap.errorMessage);
            return;
        }

        const OnlineTrackMetadataParseResult parsed = parseTrackMetadata(bootstrap.playerResponse, providerTrackId);
        if (!parsed.ok) {
            emit metadataFailed(provider, providerTrackId, parsed.errorMessage);
            return;
        }

        emit metadataSucceeded(provider, providerTrackId, parsed.metadata);
    });
}

void InnertubeProvider::resolveStream(const QString& provider, const QString& providerTrackId) {
    if (provider != name() || providerTrackId.trimmed().isEmpty()) {
        emit streamResolveFailed(provider, providerTrackId, QStringLiteral("Online playback unavailable for this track."));
        return;
    }

    QUrl watchUrl(QStringLiteral("https://www.youtube.com/watch"));
    QUrlQuery query;
    query.addQueryItem(QStringLiteral("v"), providerTrackId.trimmed());
    query.addQueryItem(QStringLiteral("bpctr"), QStringLiteral("9999999999"));
    query.addQueryItem(QStringLiteral("has_verified"), QStringLiteral("1"));
    watchUrl.setQuery(query);

    QNetworkReply* reply = network_.get(youtubeWatchRequest(watchUrl));
    connect(reply, &QNetworkReply::finished, this, [this, reply, provider, providerTrackId] {
        const QByteArray payload = reply->readAll();
        const bool networkFailed = reply->error() != QNetworkReply::NoError;
        const int statusCode = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        reply->deleteLater();

        if (networkFailed || statusCode >= 400) {
            emit streamResolveFailed(provider, providerTrackId, QStringLiteral("Online playback unavailable for this track."));
            return;
        }

        const YoutubeWebBootstrap bootstrap = parseWebBootstrap(payload);
        if (!bootstrap.ok) {
            emit streamResolveFailed(provider, providerTrackId, bootstrap.errorMessage);
            return;
        }

        std::optional<OnlineStreamResult> fallbackStream;
        OnlineStreamResolveResult parsed = parseStreamResolution(bootstrap.playerResponse, providerTrackId);
        if (parsed.ok) {
            if (parsed.stream.isSabr) {
                parsed.stream.streamKind = OnlineStreamKind::Sabr;
                parsed.stream.sabr.apiKey = bootstrap.apiKey;
                parsed.stream.sabr.clientVersion = bootstrap.clientVersion;
                if (parsed.stream.sabr.visitorData.isEmpty()) {
                    parsed.stream.sabr.visitorData = bootstrap.visitorData;
                }
                if (parsed.stream.sabr.videoPlaybackUstreamerConfig.isEmpty()) {
                    parsed.stream.sabr.videoPlaybackUstreamerConfig = bootstrap.videoPlaybackUstreamerConfig;
                }
                if (!parsed.stream.sabr.videoPlaybackUstreamerConfig.isEmpty()) {
                    parsed.stream.sabr.signatureTimestamp = bootstrap.signatureTimestamp;
                    fallbackStream = parsed.stream;
                    logStreamResolveChoice("bootstrap_sabr_fallback", *fallbackStream);
                }
            } else {
                fallbackStream = parsed.stream;
                logStreamResolveChoice("bootstrap_direct_fallback", *fallbackStream);
            }
        }

        auto* resolver = new YoutubePlaybackResolver(providerTrackId, bootstrap.visitorData, std::move(fallbackStream), this);
        connect(resolver, &YoutubePlaybackResolver::resolved, this, [this, resolver, provider, providerTrackId](const OnlineStreamResult& stream) {
            resolver->deleteLater();
            logStreamResolveChoice("resolved", stream);
            emit streamResolved(provider, providerTrackId, stream);
        });
        connect(resolver, &YoutubePlaybackResolver::failed, this, [this, resolver, provider, providerTrackId](const QString& message) {
            resolver->deleteLater();
            emit streamResolveFailed(provider, providerTrackId, message);
        });
        resolver->start();
    });
}

std::unique_ptr<OnlineProvider> createDefaultOnlineProvider() {
    return std::make_unique<InnertubeProvider>();
}
