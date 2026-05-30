#include "InnertubeProvider.hpp"
#include "YoutubePlaybackResolver.hpp"

#include <QDebug>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QSslSocket>
#include <QUrl>
#include <QUrlQuery>

#include <memory>
#include <optional>
#include <utility>

namespace {

constexpr auto providerId = "ytmusic";
constexpr auto modernBrowserUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

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

#ifndef QT_NO_DEBUG
void logSearchSslDiagnosticsOnce() {
    static bool logged = false;
    if (logged) {
        return;
    }
    logged = true;

    qWarning().noquote() << "Auqw search supportsSsl=" << QSslSocket::supportsSsl()
                         << "sslBuildVersion=" << QSslSocket::sslLibraryBuildVersionString()
                         << "sslRuntimeVersion=" << QSslSocket::sslLibraryVersionString();
}

void logSearchNetworkFailure(const QNetworkReply* reply, int statusCode) {
    qWarning().noquote() << "Auqw search network error="
                         << (reply == nullptr ? QNetworkReply::UnknownNetworkError : reply->error())
                         << "errorString="
                         << (reply == nullptr ? QStringLiteral("missing QNetworkReply") : reply->errorString())
                         << "httpStatus=" << statusCode;
}
#else
void logSearchSslDiagnosticsOnce() {}
void logSearchNetworkFailure(const QNetworkReply*, int) {}
#endif

QJsonObject searchContext() {
    return QJsonObject{
        {QStringLiteral("client"),
         QJsonObject{
             {QStringLiteral("clientName"), QStringLiteral("WEB_REMIX")},
             {QStringLiteral("clientVersion"), QStringLiteral("1.20240522.01.00")},
         }},
    };
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
        .downloads = false,
    };
}

void InnertubeProvider::searchTracks(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    if (trimmedQuery.isEmpty()) {
        emit searchSucceeded(trimmedQuery, {});
        return;
    }

    logSearchSslDiagnosticsOnce();

    QNetworkRequest request = innertubeJsonRequest(QUrl(QStringLiteral("https://music.youtube.com/youtubei/v1/search?prettyPrint=false&key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8")));

    const QJsonObject body{
        {QStringLiteral("context"), searchContext()},
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

    QNetworkRequest request = innertubeJsonRequest(QUrl(QStringLiteral("https://music.youtube.com/youtubei/v1/music/get_search_suggestions?prettyPrint=false&key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8")));
    const QJsonObject body{
        {QStringLiteral("context"), searchContext()},
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
                }
            } else {
                fallbackStream = parsed.stream;
            }
        }

        auto* resolver = new YoutubePlaybackResolver(providerTrackId, bootstrap.visitorData, std::move(fallbackStream), this);
        connect(resolver, &YoutubePlaybackResolver::resolved, this, [this, resolver, provider, providerTrackId](const OnlineStreamResult& stream) {
            resolver->deleteLater();
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
