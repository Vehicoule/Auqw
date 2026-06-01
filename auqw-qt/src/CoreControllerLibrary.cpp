#include "CoreController.hpp"
#include "JsonListModel.hpp"

#include <QDirIterator>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QSet>
#include <QUrl>
#include <QVariantMap>

#include <algorithm>

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

bool isSupportedAudioFile(const QFileInfo& fileInfo) {
    const QString suffix = fileInfo.suffix().toLower();
    return suffix == QStringLiteral("mp3")
        || suffix == QStringLiteral("flac")
        || suffix == QStringLiteral("wav")
        || suffix == QStringLiteral("m4a")
        || suffix == QStringLiteral("aac")
        || suffix == QStringLiteral("ogg")
        || suffix == QStringLiteral("opus")
        || suffix == QStringLiteral("aiff")
        || suffix == QStringLiteral("aif");
}

QString trackIdFromItem(const QVariantMap& item) {
    const QString trackId = item.value(QStringLiteral("track_id")).toString();
    return trackId.isEmpty() ? item.value(QStringLiteral("id")).toString() : trackId;
}

} // namespace

void CoreController::setThemeSetting(const QString& value) {
    const CommandResult result = invokeCommand(
        QStringLiteral("settings.set.theme"),
        QStringLiteral("settings.set"),
        QJsonObject{
            {QStringLiteral("key"), QStringLiteral("theme")},
            {QStringLiteral("value"), value},
        });

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    const QJsonObject setting = result.data.value(QStringLiteral("setting")).toObject();
    setThemeSettingFromCore(setting.value(QStringLiteral("value")).toString());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::setOnlineEnabled(bool enabled) {
    const CommandResult result = invokeCommand(
        QStringLiteral("settings.set.online.enabled"),
        QStringLiteral("settings.set"),
        QJsonObject{
            {QStringLiteral("key"), QStringLiteral("online.enabled")},
            {QStringLiteral("value"), enabled ? QStringLiteral("true") : QStringLiteral("false")},
        });

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    setOnlineEnabledFromCore(enabled);
    if (!enabled) {
        applySearchResults({});
        applySearchSuggestions({});
    }
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::importLocalFolder(const QUrl& folderUrl) {
    const QString folderPath = folderUrl.toLocalFile();
    const QFileInfo folderInfo(folderPath);
    if (folderPath.isEmpty() || !folderInfo.exists() || !folderInfo.isDir()) {
        setImportResult(QStringLiteral("No audio files found"), 0);
        return;
    }

    int imported = 0;
    QDirIterator iterator(
        folderInfo.absoluteFilePath(),
        QDir::Files | QDir::NoDotAndDotDot | QDir::Readable,
        QDirIterator::Subdirectories);

    while (iterator.hasNext()) {
        const QFileInfo fileInfo(iterator.next());
        if (!isSupportedAudioFile(fileInfo)) {
            continue;
        }

        const QString title = fileInfo.completeBaseName();
        const CommandResult result = invokeCommand(
            QStringLiteral("local_files.upsert"),
            QStringLiteral("local_files.upsert"),
            QJsonObject{
                {QStringLiteral("path"), fileInfo.absoluteFilePath()},
                {QStringLiteral("title"), title},
            });

        if (!result.ok) {
            setImportResult(result.error, imported);
            refreshState();
            return;
        }

        ++imported;
    }

    refreshState();

    if (imported == 0) {
        setImportResult(QStringLiteral("No audio files found"), 0);
        return;
    }

    setImportResult(QStringLiteral("Imported %1 tracks").arg(imported), imported);
}

bool CoreController::refreshTracksFromCore() {
    const CommandResult tracks = invokeCommand(
        QStringLiteral("tracks.list"),
        QStringLiteral("tracks.list"));
    if (!tracks.ok) {
        setCoreStatus(tracks.error);
        return false;
    }

    tracksModel_->setItems(mapsWithAliasFromArray(
        tracks.data.value(QStringLiteral("tracks")).toArray(),
        QStringLiteral("track_id"),
        QStringLiteral("id")));
    refreshRecommendationsFromModels();
    return true;
}

bool CoreController::refreshRecentTracksFromCore() {
    const CommandResult recents = invokeCommand(
        QStringLiteral("recent.list"),
        QStringLiteral("recent.list"));
    if (!recents.ok) {
        setCoreStatus(recents.error);
        return false;
    }

    recentTracksModel_->setItems(mapsFromArray(recents.data.value(QStringLiteral("items")).toArray()));
    refreshRecommendationsFromModels();
    return true;
}

bool CoreController::refreshFavoriteTracksFromCore() {
    const CommandResult favorites = invokeCommand(
        QStringLiteral("favorites.list"),
        QStringLiteral("favorites.list"));
    if (!favorites.ok) {
        setCoreStatus(favorites.error);
        return false;
    }

    favoriteTracksModel_->setItems(mapsFromArray(favorites.data.value(QStringLiteral("items")).toArray()));
    refreshRecommendationsFromModels();
    return true;
}

void CoreController::refreshRecommendationsFromModels() {
    QSet<QString> seedTrackIds;
    QSet<QString> seedArtists;
    QSet<QString> seedAlbums;

    auto collectSeed = [&](JsonListModel* model) {
        if (model == nullptr) {
            return;
        }
        for (int row = 0; row < model->rowCount(); ++row) {
            const QVariantMap item = model->itemAt(row);
            const QString trackId = trackIdFromItem(item);
            if (!trackId.isEmpty()) {
                seedTrackIds.insert(trackId);
            }
            const QString artist = item.value(QStringLiteral("artist")).toString();
            if (!artist.isEmpty()) {
                seedArtists.insert(artist);
            }
            const QString album = item.value(QStringLiteral("album")).toString();
            if (!album.isEmpty()) {
                seedAlbums.insert(album);
            }
        }
    };

    collectSeed(recentTracksModel_.get());
    collectSeed(favoriteTracksModel_.get());

    if (seedTrackIds.isEmpty()) {
        recommendationsModel_->setItems({});
        return;
    }

    struct Candidate {
        QVariantMap item;
        int score = 0;
    };

    QVector<Candidate> candidates;
    for (int row = 0; row < tracksModel_->rowCount(); ++row) {
        QVariantMap item = tracksModel_->itemAt(row);
        const QString trackId = trackIdFromItem(item);
        if (trackId.isEmpty() || seedTrackIds.contains(trackId)) {
            continue;
        }

        int score = 1;
        const QString artist = item.value(QStringLiteral("artist")).toString();
        const QString album = item.value(QStringLiteral("album")).toString();
        if (!artist.isEmpty() && seedArtists.contains(artist)) {
            score += 8;
            item.insert(QStringLiteral("reason"), QStringLiteral("Same artist"));
        } else if (!album.isEmpty() && seedAlbums.contains(album)) {
            score += 4;
            item.insert(QStringLiteral("reason"), QStringLiteral("Same album"));
        } else {
            item.insert(QStringLiteral("reason"), QStringLiteral("From library"));
        }
        item.insert(QStringLiteral("track_id"), trackId);
        candidates.push_back(Candidate{.item = std::move(item), .score = score});
    }

    std::sort(candidates.begin(), candidates.end(), [](const Candidate& left, const Candidate& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        return left.item.value(QStringLiteral("title")).toString().localeAwareCompare(
            right.item.value(QStringLiteral("title")).toString()) < 0;
    });

    QVector<QVariantMap> recommendations;
    recommendations.reserve(static_cast<int>(std::min<qsizetype>(candidates.size(), 12)));
    for (int i = 0; i < candidates.size() && i < 12; ++i) {
        recommendations.push_back(std::move(candidates[i].item));
    }
    recommendationsModel_->setItems(std::move(recommendations));
}

void CoreController::favoriteTrack(const QString& trackId) {
    if (trackId.trimmed().isEmpty()) {
        setCoreStatus(QStringLiteral("Track unavailable"));
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("favorites.add.track"),
        QStringLiteral("favorites.add"),
        QJsonObject{{QStringLiteral("track_id"), trackId}});
    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    refreshFavoriteTracksFromCore();
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::unfavoriteTrack(const QString& trackId) {
    if (trackId.trimmed().isEmpty()) {
        setCoreStatus(QStringLiteral("Track unavailable"));
        return;
    }

    const CommandResult result = invokeCommand(
        QStringLiteral("favorites.remove.track"),
        QStringLiteral("favorites.remove"),
        QJsonObject{{QStringLiteral("track_id"), trackId}});
    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    refreshFavoriteTracksFromCore();
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::clearListeningHistory() {
    const CommandResult result = invokeCommand(
        QStringLiteral("recent.clear"),
        QStringLiteral("recent.clear"));
    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    refreshRecentTracksFromCore();
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::clearSearchHistory() {
    const CommandResult result = invokeCommand(
        QStringLiteral("search_history.clear"),
        QStringLiteral("search_history.clear"));
    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    applySearchSuggestions({});
    setCoreStatus(QStringLiteral("Ready"));
}
