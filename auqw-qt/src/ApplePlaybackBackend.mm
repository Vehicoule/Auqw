#include "PlaybackBackend.hpp"

#if AUQW_ENABLE_IOS_PLATFORM

#import <AVFoundation/AVFoundation.h>

#include <QByteArray>
#include <QString>
#include <QUrl>

#include <algorithm>
#include <cmath>
#include <memory>
#include <optional>
#include <utility>

namespace {

NSString* nsStringFromQString(const QString& text) {
    const QByteArray bytes = text.toUtf8();
    return [NSString stringWithUTF8String:bytes.constData()];
}

qint64 millisecondsFromTime(CMTime time) {
    if (!CMTIME_IS_NUMERIC(time)) {
        return 0;
    }
    const Float64 seconds = CMTimeGetSeconds(time);
    if (!std::isfinite(seconds) || seconds < 0) {
        return 0;
    }
    return static_cast<qint64>(seconds * 1000.0);
}

class ApplePlaybackBackend final : public PlaybackBackend {
public:
    ApplePlaybackBackend() = default;

    ~ApplePlaybackBackend() override {
        clearObservers();
        [player_ pause];
    }

    void playLocalFile(const QString& path) override {
        if (path.isEmpty()) {
            emitError(QStringLiteral("Playback path is empty"));
            return;
        }

        clearObservers();
        NSURL* url = [NSURL fileURLWithPath:nsStringFromQString(path)];
        player_ = [AVPlayer playerWithURL:url];
        installObservers();

        emitState(QStringLiteral("loading"), 0, std::nullopt);
        [player_ play];
        emitState(QStringLiteral("playing"), positionMs(), durationMs());
    }

    void playRemoteUrl(const QUrl& url) override {
        if (!url.isValid() || url.isEmpty()) {
            emitError(QStringLiteral("Playback URL is empty"));
            return;
        }

        clearObservers();
        NSURL* nsUrl = [NSURL URLWithString:nsStringFromQString(url.toString())];
        if (nsUrl == nil) {
            emitError(QStringLiteral("Playback URL is empty"));
            return;
        }
        player_ = [AVPlayer playerWithURL:nsUrl];
        installObservers();

        emitState(QStringLiteral("loading"), 0, std::nullopt);
        [player_ play];
        emitState(QStringLiteral("playing"), positionMs(), durationMs());
    }

    void playStreamDevice(std::unique_ptr<QIODevice> device, const QString& mimeType) override {
        Q_UNUSED(device);
        Q_UNUSED(mimeType);
        emitError(QStringLiteral("Online stream playback unsupported on this platform."));
    }

    void pause() override {
        if (player_ == nil) {
            return;
        }
        [player_ pause];
        emitState(QStringLiteral("paused"), positionMs(), durationMs());
    }

    void resume() override {
        if (player_ == nil) {
            emitError(QStringLiteral("Playback player unavailable"));
            return;
        }
        [player_ play];
        emitState(QStringLiteral("playing"), positionMs(), durationMs());
    }

    void stop() override {
        if (player_ == nil) {
            emitState(QStringLiteral("stopped"), 0, std::nullopt);
            return;
        }
        [player_ pause];
        [player_ seekToTime:kCMTimeZero];
        emitState(QStringLiteral("stopped"), 0, durationMs());
    }

    void seek(qint64 positionMs) override {
        if (player_ == nil) {
            return;
        }
        const CMTime time = CMTimeMakeWithSeconds(static_cast<Float64>(std::max<qint64>(0, positionMs)) / 1000.0, NSEC_PER_SEC);
        [player_ seekToTime:time];
        emitState(QStringLiteral("playing"), positionMs, durationMs());
    }

    void setStateChangedCallback(StateChangedCallback callback) override {
        stateChangedCallback_ = std::move(callback);
    }

    void setErrorCallback(ErrorCallback callback) override {
        errorCallback_ = std::move(callback);
    }

private:
    void installObservers() {
        if (player_ == nil) {
            return;
        }

        timeObserver_ = [player_ addPeriodicTimeObserverForInterval:CMTimeMakeWithSeconds(1.0, NSEC_PER_SEC)
                                                              queue:dispatch_get_main_queue()
                                                         usingBlock:^(CMTime) {
                                                             emitState(QStringLiteral("playing"), positionMs(), durationMs());
                                                         }];

        AVPlayerItem* item = player_.currentItem;
        endObserver_ = [[NSNotificationCenter defaultCenter]
            addObserverForName:AVPlayerItemDidPlayToEndTimeNotification
                        object:item
                         queue:[NSOperationQueue mainQueue]
                    usingBlock:^(NSNotification*) {
                        emitState(QStringLiteral("stopped"), durationMs(), durationMs());
                    }];
    }

    void clearObservers() {
        if (timeObserver_ != nil && player_ != nil) {
            [player_ removeTimeObserver:timeObserver_];
            timeObserver_ = nil;
        }
        if (endObserver_ != nil) {
            [[NSNotificationCenter defaultCenter] removeObserver:endObserver_];
            endObserver_ = nil;
        }
    }

    qint64 positionMs() const {
        if (player_ == nil) {
            return 0;
        }
        return millisecondsFromTime(player_.currentTime);
    }

    qint64 durationMs() const {
        if (player_ == nil || player_.currentItem == nil) {
            return 0;
        }
        return millisecondsFromTime(player_.currentItem.duration);
    }

    void emitState(QString state, std::optional<qint64> positionMs = std::nullopt, std::optional<qint64> durationMs = std::nullopt) {
        if (stateChangedCallback_) {
            stateChangedCallback_(PlaybackBackendState{
                .state = std::move(state),
                .positionMs = positionMs,
                .durationMs = durationMs,
            });
        }
    }

    void emitError(const QString& message) {
        if (errorCallback_) {
            errorCallback_(message);
        }
    }

    AVPlayer* player_ = nil;
    id timeObserver_ = nil;
    id endObserver_ = nil;
    StateChangedCallback stateChangedCallback_;
    ErrorCallback errorCallback_;
};

} // namespace

std::unique_ptr<PlaybackBackend> createApplePlaybackBackend() {
    return std::make_unique<ApplePlaybackBackend>();
}

#endif
