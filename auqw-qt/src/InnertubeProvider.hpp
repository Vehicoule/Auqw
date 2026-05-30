#pragma once

#include "OnlineProvider.hpp"

#include <QNetworkAccessManager>

class InnertubeProvider final : public OnlineProvider {
    Q_OBJECT

public:
    explicit InnertubeProvider(QObject* parent = nullptr);

    [[nodiscard]] QString name() const override;
    void searchTracks(const QString& query) override;
    void suggestTracks(const QString& query) override;
    void fetchTrackMetadata(const QString& provider, const QString& providerTrackId) override;
    void resolveStream(const QString& provider, const QString& providerTrackId) override;

    static OnlineSearchParseResult parseTrackSearchResults(const QByteArray& payload);
    static OnlineSuggestionsParseResult parseSearchSuggestions(const QByteArray& payload);
    static OnlineTrackMetadataParseResult parseTrackMetadata(const QByteArray& payload, const QString& providerTrackId);
    static OnlineStreamResolveResult parseStreamResolution(const QByteArray& payload, const QString& providerTrackId);

private:
    QNetworkAccessManager network_;
};
