#include "PlaybackBackend.hpp"

#include <QUrl>

#include <utility>

#if AUQW_HAS_QT_MULTIMEDIA
#include <QAudioOutput>
#include <QMediaPlayer>
#endif

namespace {

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
            emitError(errorString.isEmpty() ? QStringLiteral("Playback failed") : errorString);
        });
    }

    void playLocalFile(const QString& path) override {
        if (path.isEmpty()) {
            emitError(QStringLiteral("Playback path is empty"));
            return;
        }

        emitState(QStringLiteral("loading"), 0, std::nullopt);
        player_.setSource(QUrl::fromLocalFile(path));
        player_.play();
    }

    void pause() override {
        player_.pause();
    }

    void resume() override {
        player_.play();
    }

    void stop() override {
        player_.stop();
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

    QAudioOutput audioOutput_;
    QMediaPlayer player_;
};
#else
class StubPlaybackBackend final : public CallbackPlaybackBackend {
public:
    void playLocalFile(const QString& path) override {
        Q_UNUSED(path);
        emitError(QStringLiteral("Qt Multimedia unavailable"));
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
#if AUQW_HAS_QT_MULTIMEDIA
    return std::make_unique<QtMultimediaPlaybackBackend>();
#else
    return std::make_unique<StubPlaybackBackend>();
#endif
}
