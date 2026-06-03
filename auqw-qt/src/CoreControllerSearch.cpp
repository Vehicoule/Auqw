#include "CoreController.hpp"
#include "JsonListModel.hpp"
#include "OnlineProvider.hpp"
#include "PlaybackBackend.hpp"
#include "YoutubeSabrAudioDevice.hpp"

#include <QDateTime>
#include <QDebug>
#include <QJsonObject>
#include <QTimer>
#include <QVariantMap>

#include <algorithm>
#include <memory>
#include <optional>
#include <utility>

void CoreController::searchOnline(const QString& query) {
    const QString trimmedQuery = query.trimmed();
    activeSearchQuery_ = trimmedQuery;
    activeSuggestionQuery_.clear();
    cancelSearchPrewarm();
    if (trimmedQuery.isEmpty()) {
        applySearchResults({});
        applySearchSuggestions({});
        setSearchState(QStringLiteral("Idle"), {});
        return;
    }

    if (!onlineEnabled_) {
        applySearchResults({});
        applySearchSuggestions({});
        setSearchState(QStringLiteral("Disabled"), QStringLiteral("Online search disabled."));
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

    if (!onlineEnabled_) {
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

    const std::optional<QString> trackId = upsertTrackForSearchResult(*result);
    if (!trackId.has_value()) {
        return;
    }

    addTrackToQueue(*trackId);
    refreshTracksFromCore();
}

void CoreController::playSearchResult(const QString& resultId) {
    const std::optional<OnlineTrackResult> result = searchResultById(resultId);
    if (!result.has_value()) {
        setCoreStatus(QStringLiteral("Search result unavailable"));
        return;
    }

    beginSearchPlaybackTiming(*result);
    std::optional<QString> queueItemId = queueItemIdForProviderTrack(result->provider, result->providerTrackId);
    if (!queueItemId.has_value()) {
        const std::optional<QString> trackId = upsertTrackForSearchResult(*result);
        if (!trackId.has_value()) {
            return;
        }

        const CommandResult queued = invokeCommand(
            QStringLiteral("queue.add.search_result.play"),
            QStringLiteral("queue.add"),
            QJsonObject{{QStringLiteral("track_id"), *trackId}});
        if (!queued.ok) {
            setCoreStatus(queued.error);
            return;
        }

        const QString addedQueueItemId = queued.data.value(QStringLiteral("item")).toObject().value(QStringLiteral("id")).toString();
        if (addedQueueItemId.isEmpty()) {
            setCoreStatus(QStringLiteral("Queue item unavailable"));
            return;
        }

        refreshTracksFromCore();
        if (!refreshQueueFromCore()) {
            return;
        }
        queueItemId = addedQueueItemId;
    }

    if (!queueItemId.has_value() || queueItemId->isEmpty()) {
        setCoreStatus(QStringLiteral("Queue item unavailable"));
        return;
    }

    playQueueItem(*queueItemId);
}

void CoreController::favoriteSearchResult(const QString& resultId) {
    const std::optional<OnlineTrackResult> result = searchResultById(resultId);
    if (!result.has_value()) {
        setCoreStatus(QStringLiteral("Search result unavailable"));
        return;
    }

    const std::optional<QString> trackId = upsertTrackForSearchResult(*result);
    if (!trackId.has_value()) {
        return;
    }

    favoriteTrack(*trackId);
    refreshTracksFromCore();
}

std::optional<QString> CoreController::upsertTrackForSearchResult(const OnlineTrackResult& result) {
    QJsonObject params{
        {QStringLiteral("provider"), result.provider},
        {QStringLiteral("provider_track_id"), result.providerTrackId},
        {QStringLiteral("title"), result.title},
    };
    if (!result.artist.isEmpty()) {
        params.insert(QStringLiteral("artist"), result.artist);
    }
    if (!result.album.isEmpty()) {
        params.insert(QStringLiteral("album"), result.album);
    }
    if (result.durationMs > 0) {
        params.insert(QStringLiteral("duration_ms"), result.durationMs);
    }
    if (!result.artworkUrl.isEmpty()) {
        params.insert(QStringLiteral("artwork_url"), result.artworkUrl);
    }

    const CommandResult upsert = invokeCommand(
        QStringLiteral("tracks.upsert.online"),
        QStringLiteral("tracks.upsert"),
        params);
    if (!upsert.ok) {
        setCoreStatus(upsert.error);
        return std::nullopt;
    }

    const QString trackId = upsert.data.value(QStringLiteral("track")).toObject().value(QStringLiteral("id")).toString();
    cacheArtworkForTrack(trackId, result.artworkUrl);
    return trackId;
}

std::optional<QString> CoreController::queueItemIdForProviderTrack(const QString& provider, const QString& providerTrackId) const {
    if (provider.isEmpty() || providerTrackId.isEmpty()) {
        return std::nullopt;
    }

    const int count = queueModel_->rowCount();
    for (int row = 0; row < count; ++row) {
        const QVariantMap item = queueModel_->itemAt(row);
        if (item.value(QStringLiteral("provider")).toString() == provider
            && item.value(QStringLiteral("provider_track_id")).toString() == providerTrackId) {
            const QString queueItemId = item.value(QStringLiteral("id")).toString();
            if (!queueItemId.isEmpty()) {
                return queueItemId;
            }
        }
    }
    return std::nullopt;
}

QString CoreController::streamCacheKey(const QString& provider, const QString& providerTrackId) const {
    return provider + QLatin1Char(':') + providerTrackId;
}

std::optional<OnlineStreamResult> CoreController::cachedStreamFor(const QString& provider, const QString& providerTrackId) {
    const QString key = streamCacheKey(provider, providerTrackId);
    const auto it = streamCache_.find(key);
    if (it == streamCache_.end()) {
        return std::nullopt;
    }

    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (it->validUntilMs <= now) {
        streamCache_.erase(it);
        return std::nullopt;
    }
    return it->stream;
}

void CoreController::storeStreamInCache(const OnlineStreamResult& stream) {
    if (stream.provider.isEmpty() || stream.providerTrackId.isEmpty()) {
        return;
    }

    const bool validSabr = (stream.streamKind == OnlineStreamKind::Sabr || stream.isSabr)
        && stream.sabr.serverAbrStreamingUrl.isValid()
        && !stream.sabr.serverAbrStreamingUrl.isEmpty()
        && !stream.sabr.audioFormats.isEmpty();
    const bool validDirect = stream.streamUrl.isValid() && !stream.streamUrl.isEmpty();
    if (!validSabr && !validDirect) {
        return;
    }

    constexpr qint64 defaultTtlMs = 120000;
    constexpr qint64 expirySafetyMs = 30000;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const qint64 validUntilMs = stream.expiresAtMs > 0
        ? stream.expiresAtMs - expirySafetyMs
        : now + defaultTtlMs;
    if (validUntilMs <= now) {
        return;
    }

    streamCache_.insert(streamCacheKey(stream.provider, stream.providerTrackId), StreamCacheEntry{
        .stream = stream,
        .validUntilMs = validUntilMs,
    });
}

void CoreController::requestStreamForPlayback(const QString& queueItemId, const QString& provider, const QString& providerTrackId) {
    pendingStreamQueueItemId_ = queueItemId;
    pendingStreamProvider_ = provider;
    pendingStreamProviderTrackId_ = providerTrackId;
    if (playbackTiming_.active) {
        playbackTiming_.queueItemId = queueItemId;
    }
    setCoreStatus(QStringLiteral("Loading playback"));
    logPlaybackTiming(QStringLiteral("resolve-start"));

    if (std::optional<OnlineStreamResult> cached = cachedStreamFor(provider, providerTrackId); cached.has_value()) {
        logPlaybackTiming(QStringLiteral("stream-ready cache"));
        playResolvedStream(*cached);
        return;
    }

    if (isActiveSearchPrewarm(provider, providerTrackId)) {
        qInfo() << "auqw playback timing wait-for-prewarm"
                << provider
                << providerTrackId
                << playbackTiming_.timer.elapsed();
        return;
    }

    if (!activePrewarmProvider_.isEmpty()) {
        ++prewarmGeneration_;
        pendingPrewarmResults_.clear();
        activePrewarmProvider_.clear();
        activePrewarmProviderTrackId_.clear();
    }

    onlineProvider_->resolveStream(provider, providerTrackId);
}

void CoreController::playResolvedStream(const OnlineStreamResult& stream) {
    logPlaybackTiming(QStringLiteral("stream-ready"));
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
}

void CoreController::cancelSearchPrewarm() {
    ++prewarmGeneration_;
    pendingPrewarmResults_.clear();
    activePrewarmProvider_.clear();
    activePrewarmProviderTrackId_.clear();
}

void CoreController::scheduleSearchPrewarm(const QVector<OnlineTrackResult>& results) {
    ++prewarmGeneration_;
    pendingPrewarmResults_.clear();
    activePrewarmProvider_.clear();
    activePrewarmProviderTrackId_.clear();

    if (!onlineProvider_ || results.isEmpty()) {
        return;
    }

    pendingPrewarmResults_.reserve(std::min<qsizetype>(results.size(), 3));
    for (const OnlineTrackResult& result : results) {
        if (result.provider.isEmpty() || result.providerTrackId.isEmpty()) {
            continue;
        }
        pendingPrewarmResults_.push_back(result);
        if (pendingPrewarmResults_.size() >= 3) {
            break;
        }
    }

    if (pendingPrewarmResults_.isEmpty()) {
        return;
    }

    const int generation = prewarmGeneration_;
    QTimer::singleShot(0, this, [this, generation] {
        if (generation != prewarmGeneration_) {
            return;
        }
        startNextSearchPrewarm();
    });
}

void CoreController::startNextSearchPrewarm() {
    if (!onlineProvider_ || !activePrewarmProvider_.isEmpty()) {
        return;
    }

    while (!pendingPrewarmResults_.isEmpty()) {
        const OnlineTrackResult result = pendingPrewarmResults_.takeFirst();
        if (result.provider.isEmpty() || result.providerTrackId.isEmpty()) {
            continue;
        }
        if (cachedStreamFor(result.provider, result.providerTrackId).has_value()) {
            continue;
        }
        if (isPendingStreamResolve(result.provider, result.providerTrackId)) {
            continue;
        }

        activePrewarmProvider_ = result.provider;
        activePrewarmProviderTrackId_ = result.providerTrackId;
        onlineProvider_->resolveStream(result.provider, result.providerTrackId);
        return;
    }
}

void CoreController::finishActiveSearchPrewarm(const QString& provider, const QString& providerTrackId) {
    if (!isActiveSearchPrewarm(provider, providerTrackId)) {
        return;
    }
    activePrewarmProvider_.clear();
    activePrewarmProviderTrackId_.clear();
    startNextSearchPrewarm();
}

bool CoreController::isActiveSearchPrewarm(const QString& provider, const QString& providerTrackId) const {
    return !activePrewarmProvider_.isEmpty()
        && provider == activePrewarmProvider_
        && providerTrackId == activePrewarmProviderTrackId_;
}

void CoreController::beginSearchPlaybackTiming(const OnlineTrackResult& result) {
    playbackTiming_.provider = result.provider;
    playbackTiming_.providerTrackId = result.providerTrackId;
    playbackTiming_.queueItemId.clear();
    playbackTiming_.active = true;
    playbackTiming_.timer.restart();
    qInfo() << "auqw playback timing search-click"
            << result.provider
            << result.providerTrackId;
}

void CoreController::logPlaybackTiming(const QString& stage) {
    if (!playbackTiming_.active) {
        return;
    }
    qInfo() << "auqw playback timing"
            << stage
            << playbackTiming_.provider
            << playbackTiming_.providerTrackId
            << playbackTiming_.timer.elapsed();
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
        scheduleSearchPrewarm(results);
    });

    connect(onlineProvider_.get(), &OnlineProvider::searchFailed, this, [this](const QString& query, const QString& message) {
        if (query != activeSearchQuery_) {
            return;
        }

        applySearchResults({});
        setSearchState(
            QStringLiteral("Error"),
            message.trimmed().isEmpty() ? QStringLiteral("Search unavailable. Try again.") : message.trimmed());
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
        const bool pendingPlayback = isPendingStreamResolve(provider, providerTrackId);
        const bool activePrewarm = isActiveSearchPrewarm(provider, providerTrackId);
        if (!pendingPlayback && !activePrewarm) {
            return;
        }

        storeStreamInCache(stream);
        if (pendingPlayback) {
            if (playbackQueueItemId_ == pendingStreamQueueItemId_) {
                finishActiveSearchPrewarm(provider, providerTrackId);
                playResolvedStream(stream);
            }
            return;
        }

        finishActiveSearchPrewarm(provider, providerTrackId);
    });

    connect(onlineProvider_.get(), &OnlineProvider::streamResolveFailed, this, [this](
        const QString& provider,
        const QString& providerTrackId,
        const QString&) {
        const bool pendingPlayback = isPendingStreamResolve(provider, providerTrackId);
        const bool activePrewarm = isActiveSearchPrewarm(provider, providerTrackId);
        if (activePrewarm) {
            finishActiveSearchPrewarm(provider, providerTrackId);
        }
        if (!pendingPlayback) {
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
    QString activeProvider;
    QString activeProviderTrackId;
    const int activeQueueIndex = queueIndexForItem(playbackQueueItemId_);
    if (activeQueueIndex >= 0) {
        const QVariantMap activeItem = queueModel_->itemAt(activeQueueIndex);
        activeProvider = activeItem.value(QStringLiteral("provider")).toString();
        activeProviderTrackId = activeItem.value(QStringLiteral("provider_track_id")).toString();
    }

    QVector<QVariantMap> items;
    items.reserve(results.size());
    for (const OnlineTrackResult& result : results) {
        const bool isCurrent = !activeProvider.isEmpty()
            && result.provider == activeProvider
            && result.providerTrackId == activeProviderTrackId;
        QVariantMap item{
            {QStringLiteral("result_id"), result.resultId},
            {QStringLiteral("provider"), result.provider},
            {QStringLiteral("provider_track_id"), result.providerTrackId},
            {QStringLiteral("title"), result.title},
            {QStringLiteral("artist"), result.artist},
            {QStringLiteral("album"), result.album},
            {QStringLiteral("duration_ms"), result.durationMs},
            {QStringLiteral("artwork_url"), result.artworkUrl},
            {QStringLiteral("is_playing"), isCurrent && playbackState_ == QStringLiteral("playing")},
            {QStringLiteral("is_loading"), isCurrent && playbackState_ == QStringLiteral("loading")},
        };
        items.push_back(std::move(item));
    }

    searchResultsModel_->setItems(std::move(items));
    refreshMoodArtworkUrl();
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
