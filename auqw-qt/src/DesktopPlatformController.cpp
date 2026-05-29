#include "DesktopPlatformController.hpp"

#include "CoreController.hpp"

#include <QAction>
#include <QApplication>
#include <QColor>
#include <QCoreApplication>
#include <QEvent>
#include <QIcon>
#include <QKeyEvent>
#include <QMenu>
#include <QPainter>
#include <QPixmap>
#include <QSettings>
#include <QSystemTrayIcon>
#include <QWindow>

namespace {

constexpr auto settingsGroup = "desktop/window";

QIcon fallbackTrayIcon() {
    QPixmap pixmap(32, 32);
    pixmap.fill(Qt::transparent);

    QPainter painter(&pixmap);
    painter.setRenderHint(QPainter::Antialiasing);
    painter.setBrush(QColor(38, 96, 164));
    painter.setPen(Qt::NoPen);
    painter.drawEllipse(2, 2, 28, 28);
    painter.setBrush(Qt::white);
    painter.drawEllipse(12, 8, 6, 6);
    painter.drawRect(16, 11, 4, 13);
    painter.drawEllipse(7, 20, 10, 7);
    return QIcon(pixmap);
}

QString playbackState(const CoreController& controller) {
    return controller.property("playbackState").toString();
}

QString playbackTitle(const CoreController& controller) {
    const QString title = controller.property("playbackTitle").toString();
    return title.isEmpty() ? QStringLiteral("Auqw") : title;
}

} // namespace

DesktopPlatformController::DesktopPlatformController(CoreController& coreController, QObject* parent)
    : QObject(parent),
      coreController_(coreController) {
    createActions();
    createTray();
    syncPlaybackActions();

    connect(&coreController_, &CoreController::playbackStateChanged, this, [this] {
        syncPlaybackActions();
        maybeNotifyTrackChange();
    });
    if (QCoreApplication* app = QCoreApplication::instance()) {
        app->installEventFilter(this);
    }
}

DesktopPlatformController::~DesktopPlatformController() {
    if (QCoreApplication* app = QCoreApplication::instance()) {
        app->removeEventFilter(this);
    }
    if (window_) {
        window_->removeEventFilter(this);
    }
}

QAction* DesktopPlatformController::playPauseAction() const {
    return playPauseAction_;
}

QAction* DesktopPlatformController::previousAction() const {
    return previousAction_;
}

QAction* DesktopPlatformController::nextAction() const {
    return nextAction_;
}

QAction* DesktopPlatformController::stopAction() const {
    return stopAction_;
}

QString DesktopPlatformController::lastNotificationTitle() const {
    return lastNotificationTitle_;
}

QString DesktopPlatformController::lastNotificationMessage() const {
    return lastNotificationMessage_;
}

bool DesktopPlatformController::trayVisible() const {
    return trayIcon_ != nullptr && trayIcon_->isVisible();
}

void DesktopPlatformController::bindWindow(QWindow* window) {
    if (window_ == window) {
        return;
    }
    if (window_) {
        window_->removeEventFilter(this);
        disconnect(window_, nullptr, this, nullptr);
    }

    window_ = window;
    if (!window_) {
        return;
    }

    restoreWindowState(*window_);
    window_->installEventFilter(this);
    connect(window_, &QWindow::xChanged, this, [this] { saveWindowState(); });
    connect(window_, &QWindow::yChanged, this, [this] { saveWindowState(); });
    connect(window_, &QWindow::widthChanged, this, [this] { saveWindowState(); });
    connect(window_, &QWindow::heightChanged, this, [this] { saveWindowState(); });
    connect(window_, &QWindow::visibilityChanged, this, [this] { saveWindowState(); });
    connect(window_, &QObject::destroyed, this, [this] { window_ = nullptr; });
}

void DesktopPlatformController::saveWindowState() const {
    if (!window_) {
        return;
    }

    const QRect geometry = window_->geometry();
    if (geometry.width() <= 0 || geometry.height() <= 0) {
        return;
    }

    QSettings settings;
    settings.beginGroup(QString::fromLatin1(settingsGroup));
    settings.setValue(QStringLiteral("x"), geometry.x());
    settings.setValue(QStringLiteral("y"), geometry.y());
    settings.setValue(QStringLiteral("width"), geometry.width());
    settings.setValue(QStringLiteral("height"), geometry.height());
    settings.setValue(QStringLiteral("visibility"), static_cast<int>(window_->visibility()));
    settings.endGroup();
}

bool DesktopPlatformController::eventFilter(QObject* watched, QEvent* event) {
    if (event->type() != QEvent::KeyPress) {
        return QObject::eventFilter(watched, event);
    }

    auto* keyEvent = static_cast<QKeyEvent*>(event);
    if (handleMediaKey(keyEvent->key())) {
        event->accept();
        return true;
    }

    return QObject::eventFilter(watched, event);
}

void DesktopPlatformController::createActions() {
    playPauseAction_ = new QAction(QStringLiteral("Play"), this);
    previousAction_ = new QAction(QStringLiteral("Previous"), this);
    nextAction_ = new QAction(QStringLiteral("Next"), this);
    stopAction_ = new QAction(QStringLiteral("Stop"), this);
    quitAction_ = new QAction(QStringLiteral("Quit"), this);

    connect(playPauseAction_, &QAction::triggered, this, [this] { handlePlayPause(); });
    connect(previousAction_, &QAction::triggered, &coreController_, &CoreController::playPreviousQueuedTrack);
    connect(nextAction_, &QAction::triggered, &coreController_, &CoreController::playNextQueuedTrack);
    connect(stopAction_, &QAction::triggered, &coreController_, &CoreController::stopPlayback);
    connect(quitAction_, &QAction::triggered, qApp, &QCoreApplication::quit);
}

void DesktopPlatformController::createTray() {
    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        return;
    }

    trayMenu_ = std::make_unique<QMenu>();
    trayMenu_->addAction(playPauseAction_);
    trayMenu_->addAction(previousAction_);
    trayMenu_->addAction(nextAction_);
    trayMenu_->addAction(stopAction_);
    trayMenu_->addSeparator();
    trayMenu_->addAction(quitAction_);

    trayIcon_ = new QSystemTrayIcon(this);
    const QIcon themedIcon = QIcon::fromTheme(QStringLiteral("multimedia-player"), fallbackTrayIcon());
    trayIcon_->setIcon(themedIcon);
    trayIcon_->setToolTip(QStringLiteral("Auqw"));
    trayIcon_->setContextMenu(trayMenu_.get());
    connect(trayIcon_, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason reason) {
        if (reason == QSystemTrayIcon::Trigger && window_) {
            window_->show();
            window_->raise();
            window_->requestActivate();
        }
    });
    trayIcon_->show();
}

void DesktopPlatformController::restoreWindowState(QWindow& window) const {
    QSettings settings;
    settings.beginGroup(QString::fromLatin1(settingsGroup));
    const bool hasSize = settings.contains(QStringLiteral("width")) && settings.contains(QStringLiteral("height"));
    if (!hasSize) {
        settings.endGroup();
        return;
    }

    const int width = settings.value(QStringLiteral("width"), window.width()).toInt();
    const int height = settings.value(QStringLiteral("height"), window.height()).toInt();
    const int x = settings.value(QStringLiteral("x"), window.x()).toInt();
    const int y = settings.value(QStringLiteral("y"), window.y()).toInt();
    const auto visibility = static_cast<QWindow::Visibility>(
        settings.value(QStringLiteral("visibility"), static_cast<int>(QWindow::Windowed)).toInt());
    settings.endGroup();

    if (width > 0 && height > 0) {
        window.setGeometry(x, y, width, height);
    }
    if (visibility == QWindow::Maximized || visibility == QWindow::FullScreen) {
        window.setVisibility(visibility);
    }
}

void DesktopPlatformController::syncPlaybackActions() {
    const QString state = playbackState(coreController_);
    const bool isLoading = state == QStringLiteral("loading");
    const bool isPlaying = state == QStringLiteral("playing");

    playPauseAction_->setText(isPlaying ? QStringLiteral("Pause") : QStringLiteral("Play"));
    playPauseAction_->setEnabled(!isLoading);
    previousAction_->setEnabled(!isLoading);
    nextAction_->setEnabled(!isLoading);
    stopAction_->setEnabled(state != QStringLiteral("stopped") && !isLoading);

    if (trayIcon_) {
        trayIcon_->setToolTip(playbackTitle(coreController_));
    }
}

void DesktopPlatformController::maybeNotifyTrackChange() {
    const QString queueItemId = coreController_.property("playbackQueueItemId").toString();
    const QString state = playbackState(coreController_);
    if (queueItemId.isEmpty() || state != QStringLiteral("playing") || queueItemId == lastNotificationQueueItemId_) {
        return;
    }

    lastNotificationQueueItemId_ = queueItemId;
    lastNotificationTitle_ = playbackTitle(coreController_);
    lastNotificationMessage_ = state;

    if (trayIcon_ && QSystemTrayIcon::supportsMessages()) {
        trayIcon_->showMessage(lastNotificationTitle_, lastNotificationMessage_, QSystemTrayIcon::Information, 3000);
    }
}

void DesktopPlatformController::handlePlayPause() {
    const QString state = playbackState(coreController_);
    if (state == QStringLiteral("playing")) {
        coreController_.pausePlayback();
    } else if (state == QStringLiteral("paused")) {
        coreController_.resumePlayback();
    } else {
        coreController_.playFirstQueuedTrack();
    }
}

bool DesktopPlatformController::handleMediaKey(int key) {
    switch (key) {
    case Qt::Key_MediaTogglePlayPause:
    case Qt::Key_MediaPlay:
    case Qt::Key_MediaPause:
        handlePlayPause();
        return true;
    case Qt::Key_MediaNext:
        coreController_.playNextQueuedTrack();
        return true;
    case Qt::Key_MediaPrevious:
        coreController_.playPreviousQueuedTrack();
        return true;
    case Qt::Key_MediaStop:
        coreController_.stopPlayback();
        return true;
    default:
        return false;
    }
}
