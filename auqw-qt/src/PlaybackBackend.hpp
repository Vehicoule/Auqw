#pragma once

#include <QIODevice>
#include <QString>
#include <QUrl>

#include <functional>
#include <memory>
#include <optional>

struct PlaybackBackendState {
    QString state;
    std::optional<qint64> positionMs;
    std::optional<qint64> durationMs;
};

class PlaybackBackend {
public:
    using StateChangedCallback = std::function<void(const PlaybackBackendState&)>;
    using ErrorCallback = std::function<void(const QString&)>;

    virtual ~PlaybackBackend() = default;

    virtual void playLocalFile(const QString& path) = 0;
    virtual void playRemoteUrl(const QUrl& url) = 0;
    virtual void playStreamDevice(std::unique_ptr<QIODevice> device, const QString& mimeType) = 0;
    virtual void pause() = 0;
    virtual void resume() = 0;
    virtual void stop() = 0;
    virtual void seek(qint64 positionMs) = 0;
    virtual void setStateChangedCallback(StateChangedCallback callback) = 0;
    virtual void setErrorCallback(ErrorCallback callback) = 0;
};

std::unique_ptr<PlaybackBackend> createDefaultPlaybackBackend();
