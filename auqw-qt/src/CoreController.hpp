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

public:
    explicit CoreController(QObject* parent = nullptr);
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

    Q_INVOKABLE void setThemeSetting(const QString& value);
    Q_INVOKABLE void importLocalFolder(const QUrl& folderUrl);
    Q_INVOKABLE void addTrackToQueue(const QString& trackId);
    Q_INVOKABLE void removeQueueItem(const QString& queueItemId);
    Q_INVOKABLE void clearQueue();
    Q_INVOKABLE void refreshState();

signals:
    void metadataChanged();
    void coreStatusChanged();
    void themeSettingChanged();
    void importStatusChanged();

private:
    struct CommandResult;

    [[nodiscard]] CommandResult invokeCommand(
        const QString& id,
        const QString& command,
        const QJsonObject& params = {}) const;
    void loadInitialState();
    bool refreshQueueFromCore();
    void setCoreStatus(const QString& status);
    void setThemeSettingFromCore(const QString& value);
    void setImportResult(const QString& status, int importedTrackCount);

    std::optional<auqw::CoreBridge> core_;
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
};
