#pragma once

#include "OnlineProvider.hpp"

#include <QNetworkAccessManager>

#include <functional>

class InnertubeProvider final : public OnlineProvider {
    Q_OBJECT

public:
    explicit InnertubeProvider(QObject* parent = nullptr);

    [[nodiscard]] QString name() const override;
    [[nodiscard]] OnlineProviderCapabilities capabilities() const override;
    void searchTracks(const QString& query) override;
    void suggestTracks(const QString& query) override;
    void fetchTrackMetadata(const QString& provider, const QString& providerTrackId) override;
    void resolveStream(const QString& provider, const QString& providerTrackId) override;

    static OnlineSearchParseResult parseTrackSearchResults(const QByteArray& payload);
    static OnlineSuggestionsParseResult parseSearchSuggestions(const QByteArray& payload);
    static OnlineTrackMetadataParseResult parseTrackMetadata(const QByteArray& payload, const QString& providerTrackId);
    static OnlineStreamResolveResult parseStreamResolution(const QByteArray& payload, const QString& providerTrackId);

private:
    void withInnertubeBootstrap(std::function<void(const QString& apiKey, const QString& clientVersion)> onReady, std::function<void()> onFailed);
    void postSearchRequest(const QString& trimmedQuery, const QString& apiKey, const QString& clientVersion);
    void postSuggestionsRequest(const QString& trimmedQuery, const QString& apiKey, const QString& clientVersion);

    QNetworkAccessManager network_;
    QString innertubeApiKey_;
    QString innertubeClientVersion_;
};
