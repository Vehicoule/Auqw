#include "InnertubeProvider.hpp"
#include "YoutubePlaybackResolver.hpp"

#include <QDebug>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QJsonValue>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QSslSocket>
#include <QUrl>
#include <QUrlQuery>

#include <algorithm>
#include <optional>

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

QString joinedRuns(const QJsonObject& textObject) {
    QString text;
    const QJsonArray runs = textObject.value(QStringLiteral("runs")).toArray();
    for (const QJsonValue& run : runs) {
        text += run.toObject().value(QStringLiteral("text")).toString();
    }
    if (text.isEmpty()) {
        text = textObject.value(QStringLiteral("simpleText")).toString();
    }
    return text.trimmed();
}

QString flexColumnText(const QJsonObject& renderer, int index) {
    const QJsonArray columns = renderer.value(QStringLiteral("flexColumns")).toArray();
    if (index < 0 || index >= columns.size()) {
        return {};
    }

    const QJsonObject column = columns.at(index)
                                   .toObject()
                                   .value(QStringLiteral("musicResponsiveListItemFlexColumnRenderer"))
                                   .toObject();
    return joinedRuns(column.value(QStringLiteral("text")).toObject());
}

QString fixedColumnText(const QJsonObject& renderer, int index) {
    const QJsonArray columns = renderer.value(QStringLiteral("fixedColumns")).toArray();
    if (index < 0 || index >= columns.size()) {
        return {};
    }

    const QJsonObject column = columns.at(index)
                                   .toObject()
                                   .value(QStringLiteral("musicResponsiveListItemFixedColumnRenderer"))
                                   .toObject();
    return joinedRuns(column.value(QStringLiteral("text")).toObject());
}

QString lastThumbnailUrl(const QJsonObject& renderer) {
    const QJsonArray thumbnails = renderer.value(QStringLiteral("thumbnail"))
                                      .toObject()
                                      .value(QStringLiteral("musicThumbnailRenderer"))
                                      .toObject()
                                      .value(QStringLiteral("thumbnail"))
                                      .toObject()
                                      .value(QStringLiteral("thumbnails"))
                                      .toArray();
    if (thumbnails.isEmpty()) {
        return {};
    }
    return thumbnails.last().toObject().value(QStringLiteral("url")).toString();
}

QString lastThumbnailUrlFromObject(const QJsonObject& object) {
    const QJsonArray thumbnails = object.value(QStringLiteral("thumbnails")).toArray();
    if (thumbnails.isEmpty()) {
        return {};
    }
    return thumbnails.last().toObject().value(QStringLiteral("url")).toString();
}

qint64 durationFromText(const QString& text) {
    if (text.isEmpty()) {
        return 0;
    }

    const QStringList parts = text.split(QStringLiteral(":"));
    if (parts.size() < 2 || parts.size() > 3) {
        return 0;
    }

    qint64 seconds = 0;
    for (const QString& part : parts) {
        bool ok = false;
        const int value = part.toInt(&ok);
        if (!ok) {
            return 0;
        }
        seconds = seconds * 60 + value;
    }
    return seconds * 1000;
}

qint64 durationFromSecondsValue(const QJsonValue& value) {
    bool ok = false;
    qint64 seconds = 0;
    if (value.isString()) {
        seconds = value.toString().toLongLong(&ok);
    } else if (value.isDouble()) {
        seconds = static_cast<qint64>(value.toDouble());
        ok = true;
    }
    return ok && seconds > 0 ? seconds * 1000 : 0;
}

QStringList splitDetailText(const QString& text) {
    QString normalized = text;
    normalized.replace(QStringLiteral(" • "), QStringLiteral(" | "));
    normalized.replace(QStringLiteral(" - "), QStringLiteral(" | "));

    QStringList parts;
    for (const QString& part : normalized.split(QStringLiteral("|"))) {
        const QString trimmed = part.trimmed();
        if (!trimmed.isEmpty()) {
            parts.push_back(trimmed);
        }
    }
    if (parts.isEmpty() && !normalized.trimmed().isEmpty()) {
        parts.push_back(normalized.trimmed());
    }
    return parts;
}

std::optional<OnlineTrackResult> trackFromRenderer(const QJsonObject& renderer) {
    const QString videoId = renderer.value(QStringLiteral("playlistItemData"))
                                .toObject()
                                .value(QStringLiteral("videoId"))
                                .toString();
    const QString title = flexColumnText(renderer, 0);
    if (videoId.isEmpty() || title.isEmpty()) {
        return std::nullopt;
    }

    const QStringList detailParts = splitDetailText(flexColumnText(renderer, 1));
    const QString artist = detailParts.isEmpty() ? QString{} : detailParts.first();
    const QString album = detailParts.size() > 1 ? detailParts.last() : QString{};

    return OnlineTrackResult{
        .resultId = QStringLiteral("%1:%2").arg(QString::fromLatin1(providerId), videoId),
        .provider = QString::fromLatin1(providerId),
        .providerTrackId = videoId,
        .title = title,
        .artist = artist,
        .album = album,
        .durationMs = durationFromText(fixedColumnText(renderer, 0)),
        .artworkUrl = lastThumbnailUrl(renderer),
    };
}

void collectTrackRenderers(const QJsonValue& value, QVector<OnlineTrackResult>& tracks) {
    if (value.isArray()) {
        const QJsonArray array = value.toArray();
        for (const QJsonValue& child : array) {
            collectTrackRenderers(child, tracks);
        }
        return;
    }

    if (!value.isObject()) {
        return;
    }

    const QJsonObject object = value.toObject();
    if (object.contains(QStringLiteral("musicResponsiveListItemRenderer"))) {
        if (const auto track = trackFromRenderer(object.value(QStringLiteral("musicResponsiveListItemRenderer")).toObject())) {
            tracks.push_back(*track);
        }
    }

    for (auto it = object.constBegin(); it != object.constEnd(); ++it) {
        collectTrackRenderers(it.value(), tracks);
    }
}

std::optional<OnlineSuggestionResult> suggestionFromRenderer(const QJsonObject& renderer) {
    const QString text = joinedRuns(renderer.value(QStringLiteral("suggestion")).toObject());
    if (text.isEmpty()) {
        return std::nullopt;
    }
    return OnlineSuggestionResult{
        .provider = QString::fromLatin1(providerId),
        .text = text,
    };
}

void collectSuggestionRenderers(const QJsonValue& value, QVector<OnlineSuggestionResult>& suggestions) {
    if (value.isArray()) {
        const QJsonArray array = value.toArray();
        for (const QJsonValue& child : array) {
            collectSuggestionRenderers(child, suggestions);
        }
        return;
    }

    if (!value.isObject()) {
        return;
    }

    const QJsonObject object = value.toObject();
    if (object.contains(QStringLiteral("searchSuggestionRenderer"))) {
        if (const auto suggestion = suggestionFromRenderer(object.value(QStringLiteral("searchSuggestionRenderer")).toObject())) {
            const auto duplicate = std::find_if(suggestions.cbegin(), suggestions.cend(), [&suggestion](const OnlineSuggestionResult& existing) {
                return existing.text.compare(suggestion->text, Qt::CaseInsensitive) == 0;
            });
            if (duplicate == suggestions.cend()) {
                suggestions.push_back(*suggestion);
            }
        }
    }

    for (auto it = object.constBegin(); it != object.constEnd(); ++it) {
        collectSuggestionRenderers(it.value(), suggestions);
    }
}

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

bool isAudioMimeType(const QString& mimeType) {
    return mimeType.startsWith(QStringLiteral("audio/"), Qt::CaseInsensitive);
}

bool isVideoMimeType(const QString& mimeType) {
    return mimeType.startsWith(QStringLiteral("video/"), Qt::CaseInsensitive);
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

YoutubeSabrFormat sabrFormatFromJson(const QJsonObject& format) {
    return YoutubeSabrFormat{
        .itag = format.value(QStringLiteral("itag")).toInt(),
        .mimeType = format.value(QStringLiteral("mimeType")).toString(),
        .bitrate = format.value(QStringLiteral("bitrate")).toInt(),
        .lastModified = jsonInt64(format, QStringLiteral("lastModified")),
        .xtags = format.value(QStringLiteral("xtags")).toString(),
        .audioTrackId = format.value(QStringLiteral("audioTrackId")).toString(),
        .isDrc = format.value(QStringLiteral("isDrc")).toBool(false),
    };
}

} // namespace

InnertubeProvider::InnertubeProvider(QObject* parent)
    : OnlineProvider(parent) {}

QString InnertubeProvider::name() const {
    return QString::fromLatin1(providerId);
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

OnlineSearchParseResult InnertubeProvider::parseTrackSearchResults(const QByteArray& payload) {
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Provider returned invalid search data."),
        };
    }

    QVector<OnlineTrackResult> tracks;
    collectTrackRenderers(document.object(), tracks);
    return {
        .ok = true,
        .tracks = tracks,
    };
}

OnlineSuggestionsParseResult InnertubeProvider::parseSearchSuggestions(const QByteArray& payload) {
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Provider returned invalid suggestions data."),
        };
    }

    QVector<OnlineSuggestionResult> suggestions;
    collectSuggestionRenderers(document.object(), suggestions);
    return {
        .ok = true,
        .suggestions = suggestions,
    };
}

OnlineTrackMetadataParseResult InnertubeProvider::parseTrackMetadata(const QByteArray& payload, const QString& providerTrackId) {
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Provider returned invalid metadata data."),
        };
    }

    const QJsonObject root = document.object();
    const QJsonObject details = root.value(QStringLiteral("videoDetails")).toObject();
    const QString trackId = details.value(QStringLiteral("videoId")).toString(providerTrackId);
    const QString title = details.value(QStringLiteral("title")).toString();
    if (trackId.isEmpty() || title.isEmpty()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Metadata unavailable for this track."),
        };
    }

    QString artworkUrl = lastThumbnailUrlFromObject(details.value(QStringLiteral("thumbnail")).toObject());
    if (artworkUrl.isEmpty()) {
        artworkUrl = lastThumbnailUrlFromObject(root.value(QStringLiteral("microformat"))
                                                    .toObject()
                                                    .value(QStringLiteral("playerMicroformatRenderer"))
                                                    .toObject()
                                                    .value(QStringLiteral("thumbnail"))
                                                    .toObject());
    }

    return {
        .ok = true,
        .metadata = OnlineTrackMetadata{
            .provider = QString::fromLatin1(providerId),
            .providerTrackId = trackId,
            .title = title,
            .artist = details.value(QStringLiteral("author")).toString(),
            .durationMs = durationFromSecondsValue(details.value(QStringLiteral("lengthSeconds"))),
            .artworkUrl = artworkUrl,
        },
    };
}

OnlineStreamResolveResult InnertubeProvider::parseStreamResolution(const QByteArray& payload, const QString& providerTrackId) {
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Provider returned invalid stream data."),
        };
    }

    QUrl bestUrl;
    QString bestMimeType;
    int bestBitrate = -1;
    const QJsonArray formats = document.object()
                                   .value(QStringLiteral("streamingData"))
                                   .toObject()
                                   .value(QStringLiteral("adaptiveFormats"))
                                   .toArray();
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

        const QUrl url(urlText);
        if (!url.isValid() || url.isEmpty()) {
            continue;
        }

        const int bitrate = format.value(QStringLiteral("bitrate")).toInt(0);
        if (bestUrl.isEmpty() || bitrate > bestBitrate) {
            bestUrl = url;
            bestMimeType = mimeType;
            bestBitrate = bitrate;
        }
    }

    if (!bestUrl.isEmpty()) {
        return {
            .ok = true,
            .stream = OnlineStreamResult{
                .provider = QString::fromLatin1(providerId),
                .providerTrackId = providerTrackId,
                .streamUrl = bestUrl,
                .mimeType = bestMimeType,
            },
        };
    }

    const QJsonObject streamingData = document.object().value(QStringLiteral("streamingData")).toObject();
    const QUrl serverAbrStreamingUrl(streamingData.value(QStringLiteral("serverAbrStreamingUrl")).toString());
    QString videoPlaybackUstreamerConfig = streamingData.value(QStringLiteral("videoPlaybackUstreamerConfig")).toString();
    if (videoPlaybackUstreamerConfig.isEmpty()) {
        videoPlaybackUstreamerConfig = streamingData.value(QStringLiteral("mediaUstreamerRequestConfig"))
                                           .toObject()
                                           .value(QStringLiteral("videoPlaybackUstreamerConfig"))
                                           .toString();
    }
    if (!serverAbrStreamingUrl.isValid() || serverAbrStreamingUrl.isEmpty()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Online playback unavailable for this track."),
        };
    }

    QVector<YoutubeSabrFormat> audioFormats;
    QVector<YoutubeSabrFormat> videoFormats;
    for (const QJsonValue& value : formats) {
        const QJsonObject format = value.toObject();
        const QString mimeType = format.value(QStringLiteral("mimeType")).toString();
        if (isAudioMimeType(mimeType)) {
            audioFormats.push_back(sabrFormatFromJson(format));
        } else if (isVideoMimeType(mimeType)) {
            videoFormats.push_back(sabrFormatFromJson(format));
        }
    }

    if (audioFormats.isEmpty()) {
        return {
            .ok = false,
            .errorMessage = QStringLiteral("Online playback unavailable for this track."),
        };
    }

    const auto bestAudio = std::max_element(audioFormats.cbegin(), audioFormats.cend(), [](const YoutubeSabrFormat& left, const YoutubeSabrFormat& right) {
        return left.bitrate < right.bitrate;
    });

    return {
        .ok = true,
        .stream = OnlineStreamResult{
            .provider = QString::fromLatin1(providerId),
            .providerTrackId = providerTrackId,
            .mimeType = bestAudio == audioFormats.cend() ? QString{} : bestAudio->mimeType,
            .isSabr = true,
            .sabr = YoutubeSabrStreamInfo{
                .providerTrackId = providerTrackId,
                .serverAbrStreamingUrl = serverAbrStreamingUrl,
                .videoPlaybackUstreamerConfig = videoPlaybackUstreamerConfig,
                .visitorData = document.object()
                                   .value(QStringLiteral("responseContext"))
                                   .toObject()
                                   .value(QStringLiteral("visitorData"))
                                   .toString(),
                .audioFormats = audioFormats,
                .videoFormats = videoFormats,
            },
            .streamKind = OnlineStreamKind::Sabr,
        },
    };
}

std::unique_ptr<OnlineProvider> createDefaultOnlineProvider() {
    return std::make_unique<InnertubeProvider>();
}
