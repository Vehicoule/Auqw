#include "IosPlaybackController.hpp"

#if AUQW_ENABLE_IOS_PLATFORM

#include "CoreController.hpp"

#include <QByteArray>
#include <QDebug>
#include <QMetaObject>

#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>

#include <algorithm>

namespace {

NSString* nsStringFromQString(const QString& text) {
    const QByteArray bytes = text.toUtf8();
    return [NSString stringWithUTF8String:bytes.constData()];
}

double secondsFromMilliseconds(qint64 value) {
    return static_cast<double>(std::max<qint64>(0, value)) / 1000.0;
}

qint64 millisecondsFromSeconds(NSTimeInterval value) {
    return static_cast<qint64>(std::max<NSTimeInterval>(0, value) * 1000.0);
}

} // namespace

class IosPlaybackControllerPrivate {
public:
    id playTarget = nil;
    id pauseTarget = nil;
    id stopTarget = nil;
    id nextTarget = nil;
    id previousTarget = nil;
    id seekTarget = nil;
    id interruptionObserver = nil;
};

IosPlaybackController::IosPlaybackController(CoreController& coreController, QObject* parent)
    : QObject(parent),
      coreController_(coreController),
      d_(std::make_unique<IosPlaybackControllerPrivate>()) {
    configureAudioSession();
    registerRemoteCommands();
    connect(&coreController_, &CoreController::playbackStateChanged, this, &IosPlaybackController::syncNowPlayingInfo);
    syncNowPlayingInfo();

    d_->interruptionObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:AVAudioSessionInterruptionNotification
                    object:[AVAudioSession sharedInstance]
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification* notification) {
                    NSNumber* type = notification.userInfo[AVAudioSessionInterruptionTypeKey];
                    if (type != nil && type.unsignedIntegerValue == AVAudioSessionInterruptionTypeBegan) {
                        QMetaObject::invokeMethod(&coreController_, &CoreController::pausePlayback, Qt::QueuedConnection);
                    }
                }];
}

IosPlaybackController::~IosPlaybackController() {
    unregisterRemoteCommands();
    if (d_->interruptionObserver != nil) {
        [[NSNotificationCenter defaultCenter] removeObserver:d_->interruptionObserver];
        d_->interruptionObserver = nil;
    }
    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = @{};
}

void IosPlaybackController::configureAudioSession() {
    AVAudioSession* session = [AVAudioSession sharedInstance];
    NSError* error = nil;
    if (![session setCategory:AVAudioSessionCategoryPlayback error:&error]) {
        qWarning() << "Failed to set iOS audio session category:" << QString::fromUtf8(error.localizedDescription.UTF8String);
        return;
    }

    error = nil;
    if (![session setActive:YES error:&error]) {
        qWarning() << "Failed to activate iOS audio session:" << QString::fromUtf8(error.localizedDescription.UTF8String);
    }
}

void IosPlaybackController::registerRemoteCommands() {
    MPRemoteCommandCenter* commandCenter = [MPRemoteCommandCenter sharedCommandCenter];
    commandCenter.playCommand.enabled = YES;
    commandCenter.pauseCommand.enabled = YES;
    commandCenter.stopCommand.enabled = YES;
    commandCenter.nextTrackCommand.enabled = YES;
    commandCenter.previousTrackCommand.enabled = YES;
    commandCenter.changePlaybackPositionCommand.enabled = YES;

    d_->playTarget = [commandCenter.playCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
        QMetaObject::invokeMethod(this, [this] { handlePlayCommand(); }, Qt::QueuedConnection);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
    d_->pauseTarget = [commandCenter.pauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
        QMetaObject::invokeMethod(&coreController_, &CoreController::pausePlayback, Qt::QueuedConnection);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
    d_->stopTarget = [commandCenter.stopCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
        QMetaObject::invokeMethod(&coreController_, &CoreController::stopPlayback, Qt::QueuedConnection);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
    d_->nextTarget = [commandCenter.nextTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
        QMetaObject::invokeMethod(&coreController_, &CoreController::playNextQueuedTrack, Qt::QueuedConnection);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
    d_->previousTarget = [commandCenter.previousTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent*) {
        QMetaObject::invokeMethod(&coreController_, &CoreController::playPreviousQueuedTrack, Qt::QueuedConnection);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
    d_->seekTarget = [commandCenter.changePlaybackPositionCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent* event) {
        auto* positionEvent = (MPChangePlaybackPositionCommandEvent*)event;
        const qint64 positionMs = millisecondsFromSeconds(positionEvent.positionTime);
        QMetaObject::invokeMethod(&coreController_, [this, positionMs] {
            coreController_.seekPlayback(positionMs);
        }, Qt::QueuedConnection);
        return MPRemoteCommandHandlerStatusSuccess;
    }];
}

void IosPlaybackController::unregisterRemoteCommands() {
    MPRemoteCommandCenter* commandCenter = [MPRemoteCommandCenter sharedCommandCenter];
    if (d_->playTarget != nil) {
        [commandCenter.playCommand removeTarget:d_->playTarget];
        d_->playTarget = nil;
    }
    if (d_->pauseTarget != nil) {
        [commandCenter.pauseCommand removeTarget:d_->pauseTarget];
        d_->pauseTarget = nil;
    }
    if (d_->stopTarget != nil) {
        [commandCenter.stopCommand removeTarget:d_->stopTarget];
        d_->stopTarget = nil;
    }
    if (d_->nextTarget != nil) {
        [commandCenter.nextTrackCommand removeTarget:d_->nextTarget];
        d_->nextTarget = nil;
    }
    if (d_->previousTarget != nil) {
        [commandCenter.previousTrackCommand removeTarget:d_->previousTarget];
        d_->previousTarget = nil;
    }
    if (d_->seekTarget != nil) {
        [commandCenter.changePlaybackPositionCommand removeTarget:d_->seekTarget];
        d_->seekTarget = nil;
    }
}

void IosPlaybackController::handlePlayCommand() {
    const QString state = coreController_.playbackState();
    if (state == QStringLiteral("paused")) {
        coreController_.resumePlayback();
    } else if (state != QStringLiteral("playing") && state != QStringLiteral("loading")) {
        coreController_.playFirstQueuedTrack();
    }
}

void IosPlaybackController::syncNowPlayingInfo() const {
    NSMutableDictionary* info = [NSMutableDictionary dictionary];

    const QString title = coreController_.playbackTitle().isEmpty()
        ? QStringLiteral("Auqw")
        : coreController_.playbackTitle();
    info[MPMediaItemPropertyTitle] = nsStringFromQString(title);

    const QString artist = coreController_.playbackArtist();
    if (!artist.isEmpty()) {
        info[MPMediaItemPropertyArtist] = nsStringFromQString(artist);
    }

    const QString album = coreController_.playbackAlbum();
    if (!album.isEmpty()) {
        info[MPMediaItemPropertyAlbumTitle] = nsStringFromQString(album);
    }

    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(secondsFromMilliseconds(coreController_.playbackPositionMs()));
    info[MPMediaItemPropertyPlaybackDuration] = @(secondsFromMilliseconds(coreController_.playbackDurationMs()));
    info[MPNowPlayingInfoPropertyPlaybackRate] = coreController_.playbackState() == QStringLiteral("playing") ? @1.0 : @0.0;

    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = info;
}

#endif
