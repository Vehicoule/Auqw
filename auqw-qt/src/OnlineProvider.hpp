#pragma once

#include "YoutubeSabrTypes.hpp"

#include <QByteArray>
#include <QList>
#include <QObject>
#include <QPair>
#include <QString>
#include <QUrl>
#include <QVector>

#include <memory>

enum class OnlineStreamKind {
    DirectUrl,
    HeaderedDirectUrl,
    Sabr,
};

struct OnlineTrackResult {
    QString resultId;
    QString provider;
    QString providerTrackId;
    QString title;
    QString artist;
    QString album;
    qint64 durationMs = 0;
    QString artworkUrl;
};

struct OnlineSearchParseResult {
    bool ok = false;
    QVector<OnlineTrackResult> tracks;
    QString errorMessage;
};

struct OnlineSuggestionResult {
    QString provider;
    QString text;
};

struct OnlineSuggestionsParseResult {
    bool ok = false;
    QVector<OnlineSuggestionResult> suggestions;
    QString errorMessage;
};

struct OnlineTrackMetadata {
    QString provider;
    QString providerTrackId;
    QString title;
    QString artist;
    QString album;
    qint64 durationMs = 0;
    QString artworkUrl;
};

struct OnlineTrackMetadataParseResult {
    bool ok = false;
    OnlineTrackMetadata metadata;
    QString errorMessage;
};

struct OnlineStreamResult {
    QString provider;
    QString providerTrackId;
    QUrl streamUrl;
    QString mimeType;
    bool isSabr = false;
    YoutubeSabrStreamInfo sabr;
    OnlineStreamKind streamKind = OnlineStreamKind::DirectUrl;
    QList<QPair<QByteArray, QByteArray>> requestHeaders;
    QString clientName;
    QString clientVersion;
    int itag = 0;
    qint64 expiresAtMs = 0;
};

struct OnlineStreamResolveResult {
    bool ok = false;
    OnlineStreamResult stream;
    QString errorMessage;
};

class OnlineProvider : public QObject {
    Q_OBJECT

public:
    explicit OnlineProvider(QObject* parent = nullptr);
    ~OnlineProvider() override;

    [[nodiscard]] virtual QString name() const = 0;
    virtual void searchTracks(const QString& query) = 0;
    virtual void suggestTracks(const QString& query) = 0;
    virtual void fetchTrackMetadata(const QString& provider, const QString& providerTrackId) = 0;
    virtual void resolveStream(const QString& provider, const QString& providerTrackId) = 0;

signals:
    void searchSucceeded(const QString& query, const QVector<OnlineTrackResult>& results);
    void searchFailed(const QString& query, const QString& message);
    void suggestionsSucceeded(const QString& query, const QVector<OnlineSuggestionResult>& suggestions);
    void suggestionsFailed(const QString& query, const QString& message);
    void metadataSucceeded(const QString& provider, const QString& providerTrackId, const OnlineTrackMetadata& metadata);
    void metadataFailed(const QString& provider, const QString& providerTrackId, const QString& message);
    void streamResolved(const QString& provider, const QString& providerTrackId, const OnlineStreamResult& stream);
    void streamResolveFailed(const QString& provider, const QString& providerTrackId, const QString& message);
};

std::unique_ptr<OnlineProvider> createDefaultOnlineProvider();

Q_DECLARE_METATYPE(OnlineTrackResult)
Q_DECLARE_METATYPE(QVector<OnlineTrackResult>)
Q_DECLARE_METATYPE(OnlineSuggestionResult)
Q_DECLARE_METATYPE(QVector<OnlineSuggestionResult>)
Q_DECLARE_METATYPE(OnlineTrackMetadata)
Q_DECLARE_METATYPE(OnlineStreamKind)
Q_DECLARE_METATYPE(OnlineStreamResult)
