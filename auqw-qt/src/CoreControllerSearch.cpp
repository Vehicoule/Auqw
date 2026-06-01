#include "CoreController.hpp"
#include "JsonListModel.hpp"
#include "OnlineProvider.hpp"
#include "PlaybackBackend.hpp"
#include "YoutubeSabrAudioDevice.hpp"

#include <QJsonObject>
#include <QVariantMap>

#include <memory>
#include <optional>
#include <utility>

void CoreController::searchOnline(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    activeSearchQuery_ = trimmedQuery;
    activeSuggestionQuery_.clear();
    if (trimmedQuery.isEmpty()) {
        applySearchResults({});
        applySearchSuggestions({});
        setSearchState(QStringLiteral("Idle"), {});
        return;
    }

    if (!onlineProvider_) {
        applySearchResults({});
        setSearchState(QStringLiteral("Error"), QStringLiteral("Search unavailable. Try again."));
        return;
    }

    applySearchResults({});
    applySearchSuggestions({});
    setSearchState(QStringLiteral("Searching"), {});
    onlineProvider_->searchTracks(trimmedQuery);
}

void CoreController::suggestOnline(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    activeSuggestionQuery_ = trimmedQuery;
    if (trimmedQuery.isEmpty()) {
        applySearchSuggestions({});
        return;
    }

    if (!onlineProvider_) {
        applySearchSuggestions({});
        return;
    }

    onlineProvider_->suggestTracks(trimmedQuery);
}

void CoreController::acceptSearchSuggestion(const QString& suggestion) {
    const QString trimmedSuggestion = suggestion.trimmed();
    activeSuggestionQuery_.clear();
    applySearchSuggestions({});
    if (trimmedSuggestion.isEmpty()) {
        return;
    }

    searchOnline(trimmedSuggestion);
}

void CoreController::addSearchResultToQueue(const QString& resultId) {
    const std::optional<OnlineTrackResult> result = searchResultById(resultId);
    if (!result.has_value()) {
        setCoreStatus(QStringLiteral("Search result unavailable"));
        return;
    }

    QJsonObject params{
        {QStringLiteral("provider"), result->provider},
        {QStringLiteral("provider_track_id"), result->providerTrackId},
        {QStringLiteral("title"), result->title},
    };
    if (!result->artist.isEmpty()) {
        params.insert(QStringLiteral("artist"), result->artist);
    }
    if (!result->album.isEmpty()) {
        params.insert(QStringLiteral("album"), result->album);
    }
    if (result->durationMs > 0) {
        params.insert(QStringLiteral("duration_ms"), result->durationMs);
    }
    if (!result->artworkUrl.isEmpty()) {
        params.insert(QStringLiteral("artwork_url"), result->artworkUrl);
    }

    const CommandResult upsert = invokeCommand(
        QStringLiteral("tracks.upsert.online"),
        QStringLiteral("tracks.upsert"),
        params);
    if (!upsert.ok) {
        setCoreStatus(upsert.error);
        return;
    }

    const QString trackId = upsert.data.value(QStringLiteral("track")).toObject().value(QStringLiteral("id")).toString();
    cacheArtworkForTrack(trackId, result->artworkUrl);
    addTrackToQueue(trackId);
    refreshTracksFromCore();
}

void CoreController::configureOnlineProvider() {
    connect(onlineProvider_.get(), &OnlineProvider::searchSucceeded, this, [this](const QString& query, const QVector<OnlineTrackResult>& results) {
        if (query != activeSearchQuery_) {
            return;
        }

        applySearchResults(results);
        if (!query.isEmpty() && !results.isEmpty()) {
            recordSearchHistory(query);
        }
        setSearchState(results.isEmpty() ? QStringLiteral("No results") : QStringLiteral("Ready"), {});
    });

    connect(onlineProvider_.get(), &OnlineProvider::searchFailed, this, [this](const QString& query, const QString&) {
        if (query != activeSearchQuery_) {
            return;
        }

        applySearchResults({});
        setSearchState(QStringLiteral("Error"), QStringLiteral("Search unavailable. Try again."));
    });

    connect(onlineProvider_.get(), &OnlineProvider::suggestionsSucceeded, this, [this](const QString& query, const QVector<OnlineSuggestionResult>& suggestions) {
        if (query != activeSuggestionQuery_) {
            return;
        }

        applySearchSuggestions(suggestions);
    });

    connect(onlineProvider_.get(), &OnlineProvider::suggestionsFailed, this, [this](const QString& query, const QString&) {
        if (query != activeSuggestionQuery_) {
            return;
        }

        applySearchSuggestions({});
    });

    connect(onlineProvider_.get(), &OnlineProvider::streamResolved, this, [this](
        const QString& provider,
        const QString& providerTrackId,
        const OnlineStreamResult& stream) {
        if (!isPendingStreamResolve(provider, providerTrackId)) {
            return;
        }
        if (playbackQueueItemId_ != pendingStreamQueueItemId_) {
            return;
        }
        if (stream.streamKind == OnlineStreamKind::Sabr || stream.isSabr) {
            if (!stream.sabr.serverAbrStreamingUrl.isValid() || stream.sabr.serverAbrStreamingUrl.isEmpty() || stream.sabr.audioFormats.isEmpty()) {
                clearPendingStreamResolve();
                updatePlaybackFromBackend(
                    QStringLiteral("error"),
                    std::nullopt,
                    std::nullopt,
                    QStringLiteral("Online playback unavailable. Try another result."));
                return;
            }

            clearPendingStreamResolve();
            sabrPlaybackActive_ = true;
            setCoreStatus(QStringLiteral("Loading playback"));
            playbackBackend_->playStreamDevice(
                std::make_unique<YoutubeSabrAudioDevice>(stream.sabr),
                stream.mimeType);
            return;
        }

        if (!stream.streamUrl.isValid() || stream.streamUrl.isEmpty()) {
            clearPendingStreamResolve();
            updatePlaybackFromBackend(
                QStringLiteral("error"),
                std::nullopt,
                std::nullopt,
                QStringLiteral("Online playback unavailable. Try another result."));
            return;
        }

        clearPendingStreamResolve();
        setCoreStatus(QStringLiteral("Loading playback"));
        if (stream.streamKind == OnlineStreamKind::HeaderedDirectUrl) {
            sabrPlaybackActive_ = true;
            playbackBackend_->playHeaderedRemoteUrl(stream.streamUrl, stream.requestHeaders, stream.mimeType);
            return;
        }

        sabrPlaybackActive_ = false;
        playbackBackend_->playRemoteUrl(stream.streamUrl);
    });

    connect(onlineProvider_.get(), &OnlineProvider::streamResolveFailed, this, [this](
        const QString& provider,
        const QString& providerTrackId,
        const QString&) {
        if (!isPendingStreamResolve(provider, providerTrackId)) {
            return;
        }

        clearPendingStreamResolve();
        updatePlaybackFromBackend(
            QStringLiteral("error"),
            std::nullopt,
            std::nullopt,
            QStringLiteral("Online playback unavailable. Try another result."));
    });
}

void CoreController::setSearchState(const QString& status, const QString& errorMessage) {
    if (searchStatus_ == status && searchErrorMessage_ == errorMessage) {
        return;
    }

    searchStatus_ = status;
    searchErrorMessage_ = errorMessage;
    emit searchStateChanged();
}

void CoreController::applySearchResults(const QVector<OnlineTrackResult>& results) {
    searchResults_ = results;

    QVector<QVariantMap> items;
    items.reserve(results.size());
    for (const OnlineTrackResult& result : results) {
        QVariantMap item{
            {QStringLiteral("result_id"), result.resultId},
            {QStringLiteral("provider"), result.provider},
            {QStringLiteral("provider_track_id"), result.providerTrackId},
            {QStringLiteral("title"), result.title},
            {QStringLiteral("artist"), result.artist},
            {QStringLiteral("album"), result.album},
            {QStringLiteral("duration_ms"), result.durationMs},
            {QStringLiteral("artwork_url"), result.artworkUrl},
        };
        items.push_back(std::move(item));
    }

    searchResultsModel_->setItems(std::move(items));
}

void CoreController::applySearchSuggestions(const QVector<OnlineSuggestionResult>& suggestions) {
    searchSuggestions_ = suggestions;

    QVector<QVariantMap> items;
    items.reserve(suggestions.size());
    for (const OnlineSuggestionResult& suggestion : suggestions) {
        QVariantMap item{
            {QStringLiteral("provider"), suggestion.provider},
            {QStringLiteral("text"), suggestion.text},
        };
        items.push_back(std::move(item));
    }

    searchSuggestionsModel_->setItems(std::move(items));
}

void CoreController::recordSearchHistory(const QString& query) {
    const CommandResult result = invokeCommand(
        QStringLiteral("search_history.add.online"),
        QStringLiteral("search_history.add"),
        QJsonObject{{QStringLiteral("query"), query}});

    if (!result.ok) {
        setCoreStatus(result.error);
    }
}

std::optional<OnlineTrackResult> CoreController::searchResultById(const QString& resultId) const {
    if (resultId.isEmpty()) {
        return std::nullopt;
    }

    for (const OnlineTrackResult& result : searchResults_) {
        if (result.resultId == resultId) {
            return result;
        }
    }
    return std::nullopt;
}
