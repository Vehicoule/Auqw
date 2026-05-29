#pragma once

#include <auqw/CoreBridge.hpp>

#include <QAbstractItemModel>
#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QUrl>

#include <memory>
#include <optional>

class JsonListModel;
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
    Q_PROPERTY(QString themeSetting READ themeSetting NOTIFY themeSettingChanged)
    Q_PROPERTY(QString importStatus READ importStatus NOTIFY importStatusChanged)
    Q_PROPERTY(int importedTrackCount READ importedTrackCount NOTIFY importStatusChanged)
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

public:
    explicit CoreController(QObject* parent = nullptr);
    explicit CoreController(std::unique_ptr<PlaybackBackend> playbackBackend, QObject* parent = nullptr);
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
    [[nodiscard]] QString themeSetting() const;
    [[nodiscard]] QString importStatus() const;
    [[nodiscard]] int importedTrackCount() const;
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

    Q_INVOKABLE void setThemeSetting(const QString& value);
    Q_INVOKABLE void importLocalFolder(const QUrl& folderUrl);
    Q_INVOKABLE void addTrackToQueue(const QString& trackId);
    Q_INVOKABLE void removeQueueItem(const QString& queueItemId);
    Q_INVOKABLE void clearQueue();
    Q_INVOKABLE void playQueueItem(const QString& queueItemId);
    Q_INVOKABLE void playFirstQueuedTrack();
    Q_INVOKABLE void pausePlayback();
    Q_INVOKABLE void resumePlayback();
    Q_INVOKABLE void stopPlayback();
    Q_INVOKABLE void seekPlayback(qint64 positionMs);
    Q_INVOKABLE void refreshState();

signals:
    void metadataChanged();
    void coreStatusChanged();
    void themeSettingChanged();
    void importStatusChanged();
    void playbackStateChanged();

private:
    struct CommandResult;

    [[nodiscard]] CommandResult invokeCommand(
        const QString& id,
        const QString& command,
        const QJsonObject& params = {}) const;
    void loadInitialState();
    bool refreshQueueFromCore();
    bool refreshPlaybackFromCore();
    void setCoreStatus(const QString& status);
    void setThemeSettingFromCore(const QString& value);
    void setImportResult(const QString& status, int importedTrackCount);
    void configurePlaybackBackend();
    bool applyPlaybackObject(const QJsonObject& playback);
    void updatePlaybackFromBackend(const QString& playbackState, std::optional<qint64> positionMs, std::optional<qint64> durationMs, const QString& errorMessage = {});
    void recordRecentIfNeeded();

    std::optional<auqw::CoreBridge> core_;
    std::unique_ptr<PlaybackBackend> playbackBackend_;
    std::unique_ptr<JsonListModel> tracksModel_;
    std::unique_ptr<JsonListModel> playlistsModel_;
    std::unique_ptr<JsonListModel> queueModel_;
    QString helloText_;
    QString appName_;
    QString appId_;
    QString databasePath_;
    int schemaVersion_ = 0;
    QString coreStatus_;
    QString themeSetting_;
    QString importStatus_;
    int importedTrackCount_ = 0;
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
};
