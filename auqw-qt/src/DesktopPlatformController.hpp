#pragma once

#include <QObject>
#include <QPointer>
#include <QString>

#include <memory>

class QAction;
class CoreController;
class QEvent;
class QMenu;
class QSystemTrayIcon;
class QWindow;

class DesktopPlatformController final : public QObject {
public:
    explicit DesktopPlatformController(CoreController& coreController, QObject* parent = nullptr);
    ~DesktopPlatformController() override;

    [[nodiscard]] QAction* playPauseAction() const;
    [[nodiscard]] QAction* previousAction() const;
    [[nodiscard]] QAction* nextAction() const;
    [[nodiscard]] QAction* stopAction() const;
    [[nodiscard]] QString lastNotificationTitle() const;
    [[nodiscard]] QString lastNotificationMessage() const;
    [[nodiscard]] bool trayVisible() const;

    void bindWindow(QWindow* window);
    void saveWindowState() const;
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    void createActions();
    void createTray();
    void restoreWindowState(QWindow& window) const;
    void syncPlaybackActions();
    void maybeNotifyTrackChange();
    void handlePlayPause();
    [[nodiscard]] bool handleMediaKey(int key);

    CoreController& coreController_;
    QPointer<QWindow> window_;
    QAction* playPauseAction_ = nullptr;
    QAction* previousAction_ = nullptr;
    QAction* nextAction_ = nullptr;
    QAction* stopAction_ = nullptr;
    QAction* quitAction_ = nullptr;
    std::unique_ptr<QMenu> trayMenu_;
    QSystemTrayIcon* trayIcon_ = nullptr;
    QString lastNotificationQueueItemId_;
    QString lastNotificationTitle_;
    QString lastNotificationMessage_;
};
