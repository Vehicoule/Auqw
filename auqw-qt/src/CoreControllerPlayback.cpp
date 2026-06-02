#include "CoreController.hpp"
#include "JsonListModel.hpp"
#include "OnlineProvider.hpp"
#include "PlaybackBackend.hpp"

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QRandomGenerator>
#include <QVariantMap>

#include <optional>

namespace {

QVector<QVariantMap> mapsFromArray(const QJsonArray& array) {
    QVector<QVariantMap> items;
    items.reserve(array.size());

    for (const QJsonValue& value : array) {
        if (value.isObject()) {
            items.push_back(value.toObject().toVariantMap());
        }
    }

    return items;
}

QVector<QVariantMap> mapsWithAliasFromArray(
    const QJsonArray& array,
    const QString& aliasRole,
    const QString& sourceRole) {
    QVector<QVariantMap> items = mapsFromArray(array);
    for (QVariantMap& item : items) {
        item.insert(aliasRole, item.value(sourceRole));
    }
    return items;
}

} // namespace

void CoreController::addTrackToQueue(const QString& trackId) {
    if (trackId.isEmpty()) {
        setCoreStatus(QStringLiteral("Track unavailable"));
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("queue.add"),
        QStringLiteral("queue.add"),
        QJsonObject{{QStringLiteral("track_id"), trackId}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    if (refreshQueueFromCore()) {
        setCoreStatus(QStringLiteral("Ready"));
    }
}

void CoreController::removeQueueItem(const QString& queueItemId) {
    if (queueItemId.isEmpty()) {
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("queue.remove"),
        QStringLiteral("queue.remove"),
        QJsonObject{{QStringLiteral("id"), queueItemId}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyQueueItems(result.data.value(QStringLiteral("items")).toArray());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::moveQueueItem(const QString& queueItemId, int toIndex) {
    if (queueItemId.isEmpty()) {
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("queue.move"),
        QStringLiteral("queue.move"),
        QJsonObject{
            {QStringLiteral("id"), queueItemId},
            {QStringLiteral("to_index"), toIndex},
        });

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyQueueItems(result.data.value(QStringLiteral("items")).toArray());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::clearQueue() {
    const CommandResult result = invokeCommand(
        QStringLiteral("queue.clear"),
        QStringLiteral("queue.clear"));

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyQueueItems(result.data.value(QStringLiteral("items")).toArray());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::playQueueItem(const QString& queueItemId) {
    if (queueItemId.isEmpty()) {
        setCoreStatus(QStringLiteral("Queue item unavailable"));
        return;
    }

    const bool hadActivePlayback = playbackState_ == QStringLiteral("playing")
        || playbackState_ == QStringLiteral("paused")
        || playbackState_ == QStringLiteral("loading");
    const bool hadActiveStreamPlayback = sabrPlaybackActive_;
    const int targetQueueIndex = queueIndexForItem(queueItemId);
    const QVariantMap targetQueueItem = targetQueueIndex >= 0 ? queueModel_->itemAt(targetQueueIndex) : QVariantMap{};
    const bool targetNeedsStreamResolve = targetQueueItem.value(QStringLiteral("local_path")).toString().isEmpty()
        && !targetQueueItem.value(QStringLiteral("provider")).toString().isEmpty()
        && !targetQueueItem.value(QStringLiteral("provider_track_id")).toString().isEmpty();
    clearPendingStreamResolve();
    stopActivePlaybackBeforeLoad(hadActiveStreamPlayback || (targetNeedsStreamResolve && hadActivePlayback));

    const CommandResult result = invokeCommand(
        QStringLiteral("playback.load_queue_item"),
        QStringLiteral("playback.load_queue_item"),
        QJsonObject{{QStringLiteral("id"), queueItemId}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackObject(result.data.value(QStringLiteral("playback")).toObject());
    if (!playbackLocalPath_.isEmpty()) {
        setCoreStatus(QStringLiteral("Loading playback"));
        playbackBackend_->playLocalFile(playbackLocalPath_);
        return;
    }

    const QJsonObject item = result.data.value(QStringLiteral("item")).toObject();
    const QString provider = item.value(QStringLiteral("provider")).toString();
    const QString providerTrackId = item.value(QStringLiteral("provider_track_id")).toString();
    if (!provider.isEmpty() && !providerTrackId.isEmpty() && onlineProvider_) {
        requestStreamForPlayback(queueItemId, provider, providerTrackId);
        return;
    }

    clearPendingStreamResolve();
    setCoreStatus(playbackErrorMessage_.isEmpty() ? QStringLiteral("Playback unsupported") : playbackErrorMessage_);
}

void CoreController::playFirstQueuedTrack() {
    const QVariantMap first = queueModel_->itemAt(0);
    const QString queueItemId = first.value(QStringLiteral("id")).toString();
    if (queueItemId.isEmpty()) {
        setCoreStatus(QStringLiteral("Queue empty"));
        return;
    }
    playQueueItem(queueItemId);
}

void CoreController::playNextQueuedTrack() {
    const int count = queueModel_->rowCount();
    if (count <= 0) {
        setCoreStatus(QStringLiteral("Queue empty"));
        return;
    }

    const int currentIndex = queueIndexForItem(playbackQueueItemId_);
    if (repeatMode_ == QStringLiteral("one") && !playbackQueueItemId_.isEmpty()) {
        playQueueItem(playbackQueueItemId_);
        return;
    }

    if (shuffleEnabled_ && count > 1) {
        int nextIndex = QRandomGenerator::global()->bounded(currentIndex >= 0 ? count - 1 : count);
        if (currentIndex >= 0 && nextIndex >= currentIndex) {
            ++nextIndex;
        }
        playQueueItem(queueItemIdAt(nextIndex));
        return;
    }

    if (currentIndex < 0) {
        playQueueItem(queueItemIdAt(0));
        return;
    }

    int nextIndex = currentIndex + 1;
    if (nextIndex >= count) {
        if (repeatMode_ == QStringLiteral("all")) {
            nextIndex = 0;
        } else {
            setCoreStatus(QStringLiteral("Queue ended"));
            return;
        }
    }

    playQueueItem(queueItemIdAt(nextIndex));
}

void CoreController::playPreviousQueuedTrack() {
    const int count = queueModel_->rowCount();
    if (count <= 0) {
        setCoreStatus(QStringLiteral("Queue empty"));
        return;
    }

    const int currentIndex = queueIndexForItem(playbackQueueItemId_);
    if (currentIndex < 0) {
        playQueueItem(queueItemIdAt(0));
        return;
    }

    int previousIndex = currentIndex - 1;
    if (previousIndex < 0) {
        if (repeatMode_ == QStringLiteral("all")) {
            previousIndex = count - 1;
        } else {
            previousIndex = 0;
        }
    }

    playQueueItem(queueItemIdAt(previousIndex));
}

void CoreController::pausePlayback() {
    playbackBackend_->pause();
}

void CoreController::resumePlayback() {
    playbackBackend_->resume();
}

void CoreController::stopPlayback() {
    stopRequested_ = true;
    clearPendingStreamResolve();
    sabrPlaybackActive_ = false;
    playbackBackend_->stop();
}

void CoreController::seekPlayback(qint64 positionMs) {
    if (sabrPlaybackActive_) {
        setCoreStatus(QStringLiteral("Seek unavailable for this online stream."));
        return;
    }
    playbackBackend_->seek(positionMs);
}

void CoreController::toggleRepeatMode() {
    const QString nextMode = repeatMode_ == QStringLiteral("off")
        ? QStringLiteral("one")
        : repeatMode_ == QStringLiteral("one")
            ? QStringLiteral("all")
            : QStringLiteral("off");

    const CommandResult result = invokeCommand(
        QStringLiteral("playback.options.update.repeat"),
        QStringLiteral("playback.options.update"),
        QJsonObject{{QStringLiteral("repeat_mode"), nextMode}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackOptionsObject(result.data.value(QStringLiteral("options")).toObject());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::toggleShuffle() {
    const CommandResult result = invokeCommand(
        QStringLiteral("playback.options.update.shuffle"),
        QStringLiteral("playback.options.update"),
        QJsonObject{{QStringLiteral("shuffle_enabled"), !shuffleEnabled_}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackOptionsObject(result.data.value(QStringLiteral("options")).toObject());
    setCoreStatus(QStringLiteral("Ready"));
}

bool CoreController::refreshQueueFromCore() {
    const CommandResult queue = invokeCommand(
        QStringLiteral("queue.list"),
        QStringLiteral("queue.list"));
    if (!queue.ok) {
        setCoreStatus(queue.error);
        return false;
    }

    applyQueueItems(queue.data.value(QStringLiteral("items")).toArray());
    return true;
}

bool CoreController::refreshPlaybackFromCore() {
    const CommandResult playback = invokeCommand(
        QStringLiteral("playback.get"),
        QStringLiteral("playback.get"));
    if (!playback.ok) {
        setCoreStatus(playback.error);
        return false;
    }

    applyPlaybackObject(playback.data.value(QStringLiteral("playback")).toObject());
    return true;
}

bool CoreController::refreshPlaybackOptionsFromCore() {
    const CommandResult options = invokeCommand(
        QStringLiteral("playback.options.get"),
        QStringLiteral("playback.options.get"));
    if (!options.ok) {
        setCoreStatus(options.error);
        return false;
    }

    applyPlaybackOptionsObject(options.data.value(QStringLiteral("options")).toObject());
    return true;
}

void CoreController::configurePlaybackBackend() {
    playbackBackend_->setStateChangedCallback([this](const PlaybackBackendState& state) {
        updatePlaybackFromBackend(state.state, state.positionMs, state.durationMs);
    });
    playbackBackend_->setErrorCallback([this](const QString& message) {
        updatePlaybackFromBackend(QStringLiteral("error"), std::nullopt, std::nullopt, message);
    });
}

bool CoreController::applyPlaybackObject(const QJsonObject& playback) {
    const QString nextState = playback.value(QStringLiteral("state")).toString(QStringLiteral("stopped"));
    const QString nextQueueItemId = playback.value(QStringLiteral("queue_item_id")).toString();
    const QString nextTrackId = playback.value(QStringLiteral("track_id")).toString();
    const QString nextTitle = playback.value(QStringLiteral("title")).toString();
    const QString nextArtist = playback.value(QStringLiteral("artist")).toString();
    const QString nextAlbum = playback.value(QStringLiteral("album")).toString();
    const QString nextArtworkUrl = playback.value(QStringLiteral("artwork_url")).toString();
    const QString nextLocalPath = playback.value(QStringLiteral("local_path")).toString();
    const qint64 nextPositionMs = playback.value(QStringLiteral("position_ms")).isDouble()
        ? static_cast<qint64>(playback.value(QStringLiteral("position_ms")).toDouble())
        : 0;
    const qint64 nextDurationMs = playback.value(QStringLiteral("duration_ms")).isDouble()
        ? static_cast<qint64>(playback.value(QStringLiteral("duration_ms")).toDouble())
        : 0;
    const QString nextErrorMessage = playback.value(QStringLiteral("error_message")).toString();

    const bool changed = playbackState_ != nextState
        || playbackQueueItemId_ != nextQueueItemId
        || playbackTrackId_ != nextTrackId
        || playbackTitle_ != nextTitle
        || playbackArtist_ != nextArtist
        || playbackAlbum_ != nextAlbum
        || playbackArtworkUrl_ != nextArtworkUrl
        || playbackLocalPath_ != nextLocalPath
        || playbackPositionMs_ != nextPositionMs
        || playbackDurationMs_ != nextDurationMs
        || playbackErrorMessage_ != nextErrorMessage;

    playbackState_ = nextState;
    playbackQueueItemId_ = nextQueueItemId;
    playbackTrackId_ = nextTrackId;
    playbackTitle_ = nextTitle;
    playbackArtist_ = nextArtist;
    playbackAlbum_ = nextAlbum;
    playbackArtworkUrl_ = nextArtworkUrl;
    playbackLocalPath_ = nextLocalPath;
    playbackPositionMs_ = nextPositionMs;
    playbackDurationMs_ = nextDurationMs;
    playbackErrorMessage_ = nextErrorMessage;

    if (changed) {
        emit playbackStateChanged();
        if (!searchResults_.isEmpty()) {
            applySearchResults(searchResults_);
        }
    }
    return changed;
}

bool CoreController::applyPlaybackOptionsObject(const QJsonObject& options) {
    const QString nextRepeatMode = options.value(QStringLiteral("repeat_mode")).toString(QStringLiteral("off"));
    const bool nextShuffleEnabled = options.value(QStringLiteral("shuffle_enabled")).toBool(false);

    const bool changed = repeatMode_ != nextRepeatMode
        || shuffleEnabled_ != nextShuffleEnabled;

    repeatMode_ = nextRepeatMode;
    shuffleEnabled_ = nextShuffleEnabled;

    if (changed) {
        emit playbackOptionsChanged();
    }
    return changed;
}

void CoreController::updatePlaybackFromBackend(
    const QString& playbackState,
    std::optional<qint64> positionMs,
    std::optional<qint64> durationMs,
    const QString& errorMessage) {
    const bool wasPlaying = playbackState_ == QStringLiteral("playing");
    const bool endedNaturally = playbackState == QStringLiteral("stopped")
        && wasPlaying
        && positionMs.has_value()
        && durationMs.has_value()
        && *durationMs > 0
        && *positionMs >= *durationMs;
    const bool skipAutoAdvance = stopRequested_;

    QJsonObject params{
        {QStringLiteral("state"), playbackState},
    };
    if (positionMs.has_value()) {
        params.insert(QStringLiteral("position_ms"), *positionMs);
    }
    if (durationMs.has_value()) {
        params.insert(QStringLiteral("duration_ms"), *durationMs);
    }
    if (!errorMessage.isEmpty()) {
        params.insert(QStringLiteral("error_message"), errorMessage);
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("playback.update"),
        QStringLiteral("playback.update"),
        params);

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applyPlaybackObject(result.data.value(QStringLiteral("playback")).toObject());
    if (endedNaturally && !skipAutoAdvance) {
        stopRequested_ = false;
        playNextQueuedTrack();
        return;
    }

    if (playbackState_ == QStringLiteral("playing")) {
        recordRecentIfNeeded();
        setCoreStatus(QStringLiteral("Playing"));
        finishPlaybackTimingIfPlaying();
    } else if (playbackState_ == QStringLiteral("paused")) {
        setCoreStatus(QStringLiteral("Paused"));
    } else if (playbackState_ == QStringLiteral("stopped")) {
        stopRequested_ = false;
        sabrPlaybackActive_ = false;
        setCoreStatus(QStringLiteral("Stopped"));
    } else if (playbackState_ == QStringLiteral("error")) {
        stopRequested_ = false;
        sabrPlaybackActive_ = false;
        setCoreStatus(playbackErrorMessage_.isEmpty() ? QStringLiteral("Playback error") : playbackErrorMessage_);
    }
}

int CoreController::queueIndexForItem(const QString& queueItemId) const {
    if (queueItemId.isEmpty()) {
        return -1;
    }

    const int count = queueModel_->rowCount();
    for (int row = 0; row < count; ++row) {
        if (queueItemIdAt(row) == queueItemId) {
            return row;
        }
    }
    return -1;
}

QString CoreController::queueItemIdAt(int row) const {
    return queueModel_->itemAt(row).value(QStringLiteral("id")).toString();
}

void CoreController::applyQueueItems(const QJsonArray& items) {
    queueModel_->setItems(mapsWithAliasFromArray(
        items,
        QStringLiteral("queue_item_id"),
        QStringLiteral("id")));
}

void CoreController::stopActivePlaybackBeforeLoad(bool shouldStop) {
    sabrPlaybackActive_ = false;
    if (!shouldStop) {
        return;
    }

    stopRequested_ = true;
    playbackBackend_->stop();
}

bool CoreController::isPendingStreamResolve(const QString& provider, const QString& providerTrackId) const {
    return !pendingStreamQueueItemId_.isEmpty()
        && provider == pendingStreamProvider_
        && providerTrackId == pendingStreamProviderTrackId_;
}

void CoreController::clearPendingStreamResolve() {
    pendingStreamQueueItemId_.clear();
    pendingStreamProvider_.clear();
    pendingStreamProviderTrackId_.clear();
}

void CoreController::finishPlaybackTimingIfPlaying() {
    if (!playbackTiming_.active || playbackState_ != QStringLiteral("playing")) {
        return;
    }
    logPlaybackTiming(QStringLiteral("backend-playing"));
    playbackTiming_.active = false;
}

void CoreController::recordRecentIfNeeded() {
    if (playbackQueueItemId_.isEmpty()
        || playbackTrackId_.isEmpty()
        || recentRecordedQueueItemId_ == playbackQueueItemId_) {
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("recent.add.playback"),
        QStringLiteral("recent.add"),
        QJsonObject{{QStringLiteral("track_id"), playbackTrackId_}});

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    recentRecordedQueueItemId_ = playbackQueueItemId_;
    refreshRecentTracksFromCore();
}
