#include "PlaybackBackend.hpp"
#include "YoutubeHttpAudioDevice.hpp"
#include "YoutubeSabrAudioDevice.hpp"

#include <QUrl>

#ifndef QT_NO_DEBUG
#include <QDebug>
#endif

#include <utility>

#if AUQW_HAS_QT_MULTIMEDIA
#include <QAudioOutput>
#include <QMediaPlayer>
#include <QTimer>
#endif

#if AUQW_ENABLE_IOS_PLATFORM
std::unique_ptr<PlaybackBackend> createApplePlaybackBackend();
#endif

namespace {

void logDebugMessage(const char* message) {
#ifndef QT_NO_DEBUG
    qDebug().noquote() << message;
#else
    Q_UNUSED(message);
#endif
}

void logStreamDeviceDiagnostics(QIODevice* device, const QString& mimeType) {
#ifndef QT_NO_DEBUG
    qDebug().noquote()
        << "Auqw playStreamDevice"
        << "mimeType=" << (mimeType.isEmpty() ? QStringLiteral("<empty>") : mimeType)
        << "deviceType=" << (device == nullptr ? QStringLiteral("<null>") : QString::fromLatin1(device->metaObject()->className()));
#else
    Q_UNUSED(device);
    Q_UNUSED(mimeType);
#endif
}

class CallbackPlaybackBackend : public PlaybackBackend {
public:
    void setStateChangedCallback(StateChangedCallback callback) override {
        stateChangedCallback_ = std::move(callback);
    }

    void setErrorCallback(ErrorCallback callback) override {
        errorCallback_ = std::move(callback);
    }

protected:
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

private:
    StateChangedCallback stateChangedCallback_;
    ErrorCallback errorCallback_;
};

#if AUQW_HAS_QT_MULTIMEDIA
void logMediaPlayerErrorDiagnostics(const QMediaPlayer& player, QMediaPlayer::Error error, const QString& errorString) {
#ifndef QT_NO_DEBUG
    qDebug().noquote()
        << "Auqw QMediaPlayer error"
        << "error=" << static_cast<int>(error)
        << "mediaStatus=" << static_cast<int>(player.mediaStatus())
        << "errorString=" << errorString;
#else
    Q_UNUSED(player);
    Q_UNUSED(error);
    Q_UNUSED(errorString);
#endif
}

class QtMultimediaPlaybackBackend final : public CallbackPlaybackBackend {
public:
    QtMultimediaPlaybackBackend() {
        player_.setAudioOutput(&audioOutput_);

        QObject::connect(&player_, &QMediaPlayer::playbackStateChanged, &player_, [this](QMediaPlayer::PlaybackState state) {
            switch (state) {
            case QMediaPlayer::StoppedState:
                emitState(QStringLiteral("stopped"), player_.position(), player_.duration());
                break;
            case QMediaPlayer::PlayingState:
                emitState(QStringLiteral("playing"), player_.position(), player_.duration());
                break;
            case QMediaPlayer::PausedState:
                emitState(QStringLiteral("paused"), player_.position(), player_.duration());
                break;
            }
        });

        QObject::connect(&player_, &QMediaPlayer::positionChanged, &player_, [this](qint64 position) {
            emitState(stateName(player_.playbackState()), position, player_.duration());
        });

        QObject::connect(&player_, &QMediaPlayer::durationChanged, &player_, [this](qint64 duration) {
            emitState(stateName(player_.playbackState()), player_.position(), duration);
        });

        QObject::connect(&player_, &QMediaPlayer::errorOccurred, &player_, [this](QMediaPlayer::Error error, const QString& errorString) {
            if (error == QMediaPlayer::NoError) {
                return;
            }
            logMediaPlayerErrorDiagnostics(player_, error, errorString);
            emitError(errorString.isEmpty() ? QStringLiteral("Playback failed") : errorString);
        });
    }

    void playLocalFile(const QString& path) override {
        if (path.isEmpty()) {
            emitError(QStringLiteral("Playback path is empty"));
            return;
        }

        sourceDevice_.reset();
        sourceDeviceAttached_ = false;
        emitState(QStringLiteral("loading"), 0, std::nullopt);
        player_.setSource(QUrl::fromLocalFile(path));
        player_.play();
    }

    void playRemoteUrl(const QUrl& url) override {
        if (!url.isValid() || url.isEmpty()) {
            emitError(QStringLiteral("Playback URL is empty"));
            return;
        }

        sourceDevice_.reset();
        sourceDeviceAttached_ = false;
        emitState(QStringLiteral("loading"), 0, std::nullopt);
        player_.setSource(url);
        player_.play();
    }

    void playStreamDevice(std::unique_ptr<QIODevice> device, const QString& mimeType) override {
        logStreamDeviceDiagnostics(device.get(), mimeType);
        if (!device) {
            emitError(QStringLiteral("Online stream playback unavailable."));
            return;
        }

        bool waitForFirstBytes = false;
        if (auto* sabrDevice = qobject_cast<YoutubeSabrAudioDevice*>(device.get())) {
            waitForFirstBytes = true;
            QObject::connect(sabrDevice, &YoutubeSabrAudioDevice::streamError, &player_, [this](const QString& message) {
                emitError(message);
            });
            QObject::connect(sabrDevice, &YoutubeSabrAudioDevice::firstAudioBytes, &player_, [this] {
                QTimer::singleShot(1500, &player_, [this] {
                    attachStreamDevice();
                });
            });
            QObject::connect(sabrDevice, &YoutubeSabrAudioDevice::prebufferReady, &player_, [this] {
                attachStreamDevice();
            });
        } else if (auto* httpDevice = qobject_cast<YoutubeHttpAudioDevice*>(device.get())) {
            waitForFirstBytes = true;
            QObject::connect(httpDevice, &YoutubeHttpAudioDevice::streamError, &player_, [this](const QString& message) {
                emitError(message);
            });
            QObject::connect(httpDevice, &YoutubeHttpAudioDevice::firstAudioBytes, &player_, [this] {
                QTimer::singleShot(1500, &player_, [this] {
                    attachStreamDevice();
                });
            });
            QObject::connect(httpDevice, &YoutubeHttpAudioDevice::prebufferReady, &player_, [this] {
                attachStreamDevice();
            });
        }

        sourceDevice_ = std::move(device);
        sourceDeviceAttached_ = false;
        if (!sourceDevice_->isOpen() && !sourceDevice_->open(QIODevice::ReadOnly)) {
            emitError(sourceDevice_->errorString().isEmpty()
                    ? QStringLiteral("Online stream playback unavailable.")
                    : sourceDevice_->errorString());
            sourceDevice_.reset();
            return;
        }

        emitState(QStringLiteral("loading"), 0, std::nullopt);
        if (!waitForFirstBytes) {
            attachStreamDevice();
        }
    }

    void pause() override {
        player_.pause();
    }

    void resume() override {
        player_.play();
    }

    void stop() override {
        player_.stop();
        sourceDevice_.reset();
        sourceDeviceAttached_ = false;
    }

    void seek(qint64 positionMs) override {
        player_.setPosition(positionMs);
    }

private:
    static QString stateName(QMediaPlayer::PlaybackState state) {
        switch (state) {
        case QMediaPlayer::StoppedState:
            return QStringLiteral("stopped");
        case QMediaPlayer::PlayingState:
            return QStringLiteral("playing");
        case QMediaPlayer::PausedState:
            return QStringLiteral("paused");
        }
        return QStringLiteral("stopped");
    }

    void attachStreamDevice() {
        if (!sourceDevice_ || sourceDeviceAttached_) {
            return;
        }
        sourceDeviceAttached_ = true;
        player_.setSourceDevice(sourceDevice_.get());
        player_.play();
    }

    QAudioOutput audioOutput_;
    QMediaPlayer player_;
    std::unique_ptr<QIODevice> sourceDevice_;
    bool sourceDeviceAttached_ = false;
};
#else
class StubPlaybackBackend final : public CallbackPlaybackBackend {
public:
    void playLocalFile(const QString& path) override {
        Q_UNUSED(path);
        emitError(QStringLiteral("Qt Multimedia unavailable"));
    }

    void playRemoteUrl(const QUrl& url) override {
        Q_UNUSED(url);
        emitError(QStringLiteral("Qt Multimedia unavailable"));
    }

    void playStreamDevice(std::unique_ptr<QIODevice> device, const QString& mimeType) override {
        logStreamDeviceDiagnostics(device.get(), mimeType);
        Q_UNUSED(device);
        Q_UNUSED(mimeType);
        emitError(QStringLiteral("Online stream playback unsupported on this platform."));
    }

    void pause() override {
        emitState(QStringLiteral("paused"));
    }

    void resume() override {
        emitError(QStringLiteral("Qt Multimedia unavailable"));
    }

    void stop() override {
        emitState(QStringLiteral("stopped"), 0, std::nullopt);
    }

    void seek(qint64 positionMs) override {
        emitState(QStringLiteral("playing"), positionMs, std::nullopt);
    }
};
#endif

} // namespace

std::unique_ptr<PlaybackBackend> createDefaultPlaybackBackend() {
#if AUQW_ENABLE_IOS_PLATFORM
#if AUQW_HAS_QT_MULTIMEDIA
    logDebugMessage("Auqw playback backend selected: Apple AUQW_HAS_QT_MULTIMEDIA=1");
#else
    logDebugMessage("Auqw playback backend selected: Apple AUQW_HAS_QT_MULTIMEDIA=0");
#endif
    return createApplePlaybackBackend();
#elif AUQW_HAS_QT_MULTIMEDIA
    logDebugMessage("Auqw playback backend selected: QtMultimedia AUQW_HAS_QT_MULTIMEDIA=1");
    return std::make_unique<QtMultimediaPlaybackBackend>();
#else
    logDebugMessage("Auqw playback backend selected: Stub AUQW_HAS_QT_MULTIMEDIA=0");
    return std::make_unique<StubPlaybackBackend>();
#endif
}
