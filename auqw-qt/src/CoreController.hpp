#pragma once

#include "OnlineProvider.hpp"

#include <auqw/CoreBridge.hpp>

#include <QAbstractItemModel>
#include <QElapsedTimer>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QString>
#include <QStringList>
#include <QUrl>
#include <QVector>
#include <QVariantMap>

#include <memory>
#include <optional>

class JsonListModel;
class DownloadWorker;
class PlaybackBackend;

class CoreController final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString helloText READ helloText CONSTANT)
    Q_PROPERTY(QString appName READ appName NOTIFY metadataChanged)
    Q_PROPERTY(QString appId READ appId NOTIFY metadataChanged)
    Q_PROPERTY(QString databasePath READ databasePath NOTIFY metadataChanged)
    Q_PROPERTY(int schemaVersion READ schemaVersion NOTIFY metadataChanged)
    Q_PROPERTY(QString coreStatus READ coreStatus NOTIFY coreStatusChanged)
    Q_PROPERTY(QAbstractItemModel* tracksModel READ tracksModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* playlistsModel READ playlistsModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* queueModel READ queueModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* downloadsModel READ downloadsModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* searchResultsModel READ searchResultsModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* searchSuggestionsModel READ searchSuggestionsModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* recentTracksModel READ recentTracksModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* favoriteTracksModel READ favoriteTracksModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel* recommendationsModel READ recommendationsModel CONSTANT)
    Q_PROPERTY(QString themeSetting READ themeSetting NOTIFY themeSettingChanged)
    Q_PROPERTY(QString importStatus READ importStatus NOTIFY importStatusChanged)
    Q_PROPERTY(int importedTrackCount READ importedTrackCount NOTIFY importStatusChanged)
    Q_PROPERTY(QString searchStatus READ searchStatus NOTIFY searchStateChanged)
    Q_PROPERTY(QString searchErrorMessage READ searchErrorMessage NOTIFY searchStateChanged)
    Q_PROPERTY(QString downloadStatus READ downloadStatus NOTIFY downloadStateChanged)
    Q_PROPERTY(QString downloadDirectory READ downloadDirectory NOTIFY downloadDirectoryChanged)
    Q_PROPERTY(QString playbackState READ playbackState NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackQueueItemId READ playbackQueueItemId NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackTrackId READ playbackTrackId NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackTitle READ playbackTitle NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackArtist READ playbackArtist NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackAlbum READ playbackAlbum NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackArtworkUrl READ playbackArtworkUrl NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackLocalPath READ playbackLocalPath NOTIFY playbackStateChanged)
    Q_PROPERTY(qint64 playbackPositionMs READ playbackPositionMs NOTIFY playbackStateChanged)
    Q_PROPERTY(qint64 playbackDurationMs READ playbackDurationMs NOTIFY playbackStateChanged)
    Q_PROPERTY(QString playbackErrorMessage READ playbackErrorMessage NOTIFY playbackStateChanged)
    Q_PROPERTY(QString repeatMode READ repeatMode NOTIFY playbackOptionsChanged)
    Q_PROPERTY(bool shuffleEnabled READ shuffleEnabled NOTIFY playbackOptionsChanged)
    Q_PROPERTY(bool onlineEnabled READ onlineEnabled NOTIFY onlineSourceChanged)
    Q_PROPERTY(QString onlineSourceStatus READ onlineSourceStatus NOTIFY onlineSourceChanged)
    Q_PROPERTY(QStringList onlineSourceCapabilities READ onlineSourceCapabilities NOTIFY onlineSourceChanged)

public:
    explicit CoreController(QObject* parent = nullptr);
    explicit CoreController(std::unique_ptr<PlaybackBackend> playbackBackend, QObject* parent = nullptr);
    explicit CoreController(
        std::unique_ptr<PlaybackBackend> playbackBackend,
        std::unique_ptr<OnlineProvider> onlineProvider,
        QObject* parent = nullptr);
    ~CoreController() override;

    [[nodiscard]] QString helloText() const;
    [[nodiscard]] QString appName() const;
    [[nodiscard]] QString appId() const;
    [[nodiscard]] QString databasePath() const;
    [[nodiscard]] int schemaVersion() const;
    [[nodiscard]] QString coreStatus() const;
    [[nodiscard]] QAbstractItemModel* tracksModel() const;
    [[nodiscard]] QAbstractItemModel* playlistsModel() const;
    [[nodiscard]] QAbstractItemModel* queueModel() const;
    [[nodiscard]] QAbstractItemModel* downloadsModel() const;
    [[nodiscard]] QAbstractItemModel* searchResultsModel() const;
    [[nodiscard]] QAbstractItemModel* searchSuggestionsModel() const;
    [[nodiscard]] QAbstractItemModel* recentTracksModel() const;
    [[nodiscard]] QAbstractItemModel* favoriteTracksModel() const;
    [[nodiscard]] QAbstractItemModel* recommendationsModel() const;
    [[nodiscard]] QString themeSetting() const;
    [[nodiscard]] QString importStatus() const;
    [[nodiscard]] int importedTrackCount() const;
    [[nodiscard]] QString searchStatus() const;
    [[nodiscard]] QString searchErrorMessage() const;
    [[nodiscard]] QString downloadStatus() const;
    [[nodiscard]] QString downloadDirectory() const;
    [[nodiscard]] QString playbackState() const;
    [[nodiscard]] QString playbackQueueItemId() const;
    [[nodiscard]] QString playbackTrackId() const;
    [[nodiscard]] QString playbackTitle() const;
    [[nodiscard]] QString playbackArtist() const;
    [[nodiscard]] QString playbackAlbum() const;
    [[nodiscard]] QString playbackArtworkUrl() const;
    [[nodiscard]] QString playbackLocalPath() const;
    [[nodiscard]] qint64 playbackPositionMs() const;
    [[nodiscard]] qint64 playbackDurationMs() const;
    [[nodiscard]] QString playbackErrorMessage() const;
    [[nodiscard]] QString repeatMode() const;
    [[nodiscard]] bool shuffleEnabled() const;
    [[nodiscard]] bool onlineEnabled() const;
    [[nodiscard]] QString onlineSourceStatus() const;
    [[nodiscard]] QStringList onlineSourceCapabilities() const;

    Q_INVOKABLE void setThemeSetting(const QString& value);
    Q_INVOKABLE void setOnlineEnabled(bool enabled);
    Q_INVOKABLE void importLocalFolder(const QUrl& folderUrl);
    Q_INVOKABLE void searchOnline(const QString& query);
    Q_INVOKABLE void suggestOnline(const QString& query);
    Q_INVOKABLE void acceptSearchSuggestion(const QString& suggestion);
    Q_INVOKABLE void addSearchResultToQueue(const QString& resultId);
    Q_INVOKABLE void playSearchResult(const QString& resultId);
    Q_INVOKABLE void favoriteSearchResult(const QString& resultId);
    Q_INVOKABLE void favoriteTrack(const QString& trackId);
    Q_INVOKABLE void unfavoriteTrack(const QString& trackId);
    Q_INVOKABLE void clearListeningHistory();
    Q_INVOKABLE void clearSearchHistory();
    Q_INVOKABLE void downloadSearchResult(const QString& resultId);
    Q_INVOKABLE void addTrackToQueue(const QString& trackId);
    Q_INVOKABLE void downloadTrack(const QString& trackId);
    Q_INVOKABLE void removeDownload(const QString& downloadId);
    Q_INVOKABLE void setDownloadDirectory(const QString& path);
    Q_INVOKABLE void removeQueueItem(const QString& queueItemId);
    Q_INVOKABLE void moveQueueItem(const QString& queueItemId, int toIndex);
    Q_INVOKABLE void clearQueue();
    Q_INVOKABLE void playQueueItem(const QString& queueItemId);
    Q_INVOKABLE void playFirstQueuedTrack();
    Q_INVOKABLE void playNextQueuedTrack();
    Q_INVOKABLE void playPreviousQueuedTrack();
    Q_INVOKABLE void pausePlayback();
    Q_INVOKABLE void resumePlayback();
    Q_INVOKABLE void stopPlayback();
    Q_INVOKABLE void seekPlayback(qint64 positionMs);
    Q_INVOKABLE void toggleRepeatMode();
    Q_INVOKABLE void toggleShuffle();
    Q_INVOKABLE void refreshState();

signals:
    void metadataChanged();
    void coreStatusChanged();
    void themeSettingChanged();
    void importStatusChanged();
    void searchStateChanged();
    void downloadStateChanged();
    void downloadDirectoryChanged();
    void playbackStateChanged();
    void playbackOptionsChanged();
    void onlineSourceChanged();

private:
    struct CommandResult {
        bool ok = false;
        QJsonObject data;
        QString error;
    };
    struct StreamCacheEntry {
        OnlineStreamResult stream;
        qint64 validUntilMs = 0;
    };
    struct PlaybackTiming {
        QElapsedTimer timer;
        QString provider;
        QString providerTrackId;
        QString queueItemId;
        bool active = false;
    };

    [[nodiscard]] CommandResult invokeCommand(
        const QString& id,
        const QString& command,
        const QJsonObject& params = {}) const;
    void loadInitialState();
    bool refreshTracksFromCore();
    bool refreshQueueFromCore();
    bool refreshDownloadsFromCore();
    bool refreshRecentTracksFromCore();
    bool refreshFavoriteTracksFromCore();
    void refreshRecommendationsFromModels();
    bool refreshPlaybackFromCore();
    bool refreshPlaybackOptionsFromCore();
    void setCoreStatus(const QString& status);
    void setThemeSettingFromCore(const QString& value);
    void setImportResult(const QString& status, int importedTrackCount);
    void setDownloadStatus(const QString& status);
    void setDownloadDirectoryFromCore(const QString& path);
    void setOnlineEnabledFromCore(bool enabled);
    void syncOnlineSourceState();
    void configurePlaybackBackend();
    void configureOnlineProvider();
    void setSearchState(const QString& status, const QString& errorMessage);
    void applySearchResults(const QVector<OnlineTrackResult>& results);
    void applySearchSuggestions(const QVector<OnlineSuggestionResult>& suggestions);
    void applyDownloads(const QJsonArray& downloads);
    void recordSearchHistory(const QString& query);
    [[nodiscard]] std::optional<OnlineTrackResult> searchResultById(const QString& resultId) const;
    [[nodiscard]] std::optional<QString> upsertTrackForSearchResult(const OnlineTrackResult& result);
    [[nodiscard]] std::optional<QString> queueItemIdForProviderTrack(const QString& provider, const QString& providerTrackId) const;
    [[nodiscard]] QVariantMap trackById(const QString& trackId) const;
    [[nodiscard]] bool downloadsSupportedForProvider(const QString& provider) const;
    [[nodiscard]] QString defaultDownloadDirectory() const;
    [[nodiscard]] QString targetPathForDownload(const QString& title, const QString& providerTrackId) const;
    bool queueDownloadForTrack(
        const QString& trackId,
        const QString& provider,
        const QString& providerTrackId,
        const QString& title);
    void maybeStartNextDownload();
    void startDownloadWorker(const QVariantMap& download);
    void applyDownloadWorkerUpdate(const QString& downloadId, const QVariantMap& fields);
    void finishActiveDownload(const QString& downloadId, const QString& status);
    void clearActiveDownloadWorker();
    void cacheArtworkForTrack(const QString& trackId, const QString& sourceUrl);
    void upsertArtworkCacheRecord(const QString& trackId, const QString& sourceUrl, const QString& cachePath);
    bool applyPlaybackObject(const QJsonObject& playback);
    bool applyPlaybackOptionsObject(const QJsonObject& options);
    void updatePlaybackFromBackend(const QString& playbackState, std::optional<qint64> positionMs, std::optional<qint64> durationMs, const QString& errorMessage = {});
    void recordRecentIfNeeded();
    [[nodiscard]] int queueIndexForItem(const QString& queueItemId) const;
    [[nodiscard]] QString queueItemIdAt(int row) const;
    void applyQueueItems(const QJsonArray& items);
    void stopActivePlaybackBeforeLoad(bool shouldStop);
    [[nodiscard]] bool isPendingStreamResolve(const QString& provider, const QString& providerTrackId) const;
    void clearPendingStreamResolve();
    [[nodiscard]] QString streamCacheKey(const QString& provider, const QString& providerTrackId) const;
    [[nodiscard]] std::optional<OnlineStreamResult> cachedStreamFor(const QString& provider, const QString& providerTrackId);
    void storeStreamInCache(const OnlineStreamResult& stream);
    void requestStreamForPlayback(const QString& queueItemId, const QString& provider, const QString& providerTrackId);
    void playResolvedStream(const OnlineStreamResult& stream);
    void cancelSearchPrewarm();
    void scheduleSearchPrewarm(const QVector<OnlineTrackResult>& results);
    void startNextSearchPrewarm();
    void finishActiveSearchPrewarm(const QString& provider, const QString& providerTrackId);
    [[nodiscard]] bool isActiveSearchPrewarm(const QString& provider, const QString& providerTrackId) const;
    void beginSearchPlaybackTiming(const OnlineTrackResult& result);
    void logPlaybackTiming(const QString& stage);
    void finishPlaybackTimingIfPlaying();

    std::optional<auqw::CoreBridge> core_;
    std::unique_ptr<PlaybackBackend> playbackBackend_;
    std::unique_ptr<OnlineProvider> onlineProvider_;
    QNetworkAccessManager artworkNetwork_;
    DownloadWorker* activeDownloadWorker_ = nullptr;
    QString activeDownloadId_;
    std::unique_ptr<JsonListModel> tracksModel_;
    std::unique_ptr<JsonListModel> playlistsModel_;
    std::unique_ptr<JsonListModel> queueModel_;
    std::unique_ptr<JsonListModel> downloadsModel_;
    std::unique_ptr<JsonListModel> searchResultsModel_;
    std::unique_ptr<JsonListModel> searchSuggestionsModel_;
    std::unique_ptr<JsonListModel> recentTracksModel_;
    std::unique_ptr<JsonListModel> favoriteTracksModel_;
    std::unique_ptr<JsonListModel> recommendationsModel_;
    QVector<OnlineTrackResult> searchResults_;
    QVector<OnlineSuggestionResult> searchSuggestions_;
    QString helloText_;
    QString appName_;
    QString appId_;
    QString databasePath_;
    int schemaVersion_ = 0;
    QString coreStatus_;
    QString themeSetting_;
    QString importStatus_;
    int importedTrackCount_ = 0;
    QString searchStatus_ = QStringLiteral("Idle");
    QString searchErrorMessage_;
    QString downloadStatus_ = QStringLiteral("Idle");
    QString downloadDirectory_;
    QString activeSearchQuery_;
    QString activeSuggestionQuery_;
    bool onlineEnabled_ = true;
    QString onlineSourceStatus_ = QStringLiteral("Ready");
    QStringList onlineSourceCapabilities_;
    QString playbackState_ = QStringLiteral("stopped");
    QString playbackQueueItemId_;
    QString playbackTrackId_;
    QString playbackTitle_;
    QString playbackArtist_;
    QString playbackAlbum_;
    QString playbackArtworkUrl_;
    QString playbackLocalPath_;
    qint64 playbackPositionMs_ = 0;
    qint64 playbackDurationMs_ = 0;
    QString playbackErrorMessage_;
    QString recentRecordedQueueItemId_;
    QString pendingStreamQueueItemId_;
    QString pendingStreamProvider_;
    QString pendingStreamProviderTrackId_;
    QHash<QString, StreamCacheEntry> streamCache_;
    QVector<OnlineTrackResult> pendingPrewarmResults_;
    QString activePrewarmProvider_;
    QString activePrewarmProviderTrackId_;
    int prewarmGeneration_ = 0;
    PlaybackTiming playbackTiming_;
    QString repeatMode_ = QStringLiteral("off");
    bool shuffleEnabled_ = false;
    bool stopRequested_ = false;
    bool sabrPlaybackActive_ = false;
};
