#include "../src/OnlineProvider.hpp"
#include "../src/YoutubeHttpAudioDevice.hpp"
#include "../src/YoutubeSabrAudioDevice.hpp"

#include <QCoreApplication>
#include <QIODevice>
#include <QTimer>
#include <QTextStream>

#include <algorithm>
#include <functional>

#if AUQW_HAS_QT_MULTIMEDIA
#include <QAudioOutput>
#include <QMediaPlayer>
#endif

namespace {

int positiveEnvInt(const char* name, int fallback) {
    bool ok = false;
    const int value = qEnvironmentVariableIntValue(name, &ok);
    return ok && value > 0 ? value : fallback;
}

#if AUQW_HAS_QT_MULTIMEDIA
QString playbackStateName(QMediaPlayer::PlaybackState state) {
    switch (state) {
    case QMediaPlayer::StoppedState:
        return QStringLiteral("stopped");
    case QMediaPlayer::PlayingState:
        return QStringLiteral("playing");
    case QMediaPlayer::PausedState:
        return QStringLiteral("paused");
    }
    return QStringLiteral("unknown");
}

QString mediaStatusName(QMediaPlayer::MediaStatus status) {
    switch (status) {
    case QMediaPlayer::NoMedia:
        return QStringLiteral("no_media");
    case QMediaPlayer::LoadingMedia:
        return QStringLiteral("loading");
    case QMediaPlayer::LoadedMedia:
        return QStringLiteral("loaded");
    case QMediaPlayer::StalledMedia:
        return QStringLiteral("stalled");
    case QMediaPlayer::BufferingMedia:
        return QStringLiteral("buffering");
    case QMediaPlayer::BufferedMedia:
        return QStringLiteral("buffered");
    case QMediaPlayer::EndOfMedia:
        return QStringLiteral("end_of_media");
    case QMediaPlayer::InvalidMedia:
        return QStringLiteral("invalid");
    }
    return QStringLiteral("unknown");
}
#endif

} // namespace

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    QTextStream out(stdout);
    QTextStream err(stderr);

    const QString query = app.arguments().size() > 1 ? app.arguments().at(1) : QStringLiteral("rolling in the");
    const bool playbackSmoke = qEnvironmentVariableIntValue("AUQW_SABR_SMOKE_PLAYBACK") > 0;
    const qsizetype maxResults = std::max<qsizetype>(
        1,
        positiveEnvInt("AUQW_SABR_SMOKE_MAX_RESULTS", 1));
    const int minPlaybackPositionMs = positiveEnvInt("AUQW_SABR_SMOKE_MIN_POSITION_MS", 1000);
    const int playbackWindowMs = positiveEnvInt("AUQW_SABR_SMOKE_PLAYBACK_WINDOW_MS", 5000);
    out << "query=" << query << '\n';
    out << "max_results=" << maxResults << '\n';
    out.flush();

    auto provider = createDefaultOnlineProvider();
    std::unique_ptr<QIODevice> device;
    QVector<OnlineTrackResult> searchResults;
    qsizetype attemptIndex = 0;
    qsizetype activeAttempt = 0;
    QString lastFailureStatus;
    QString lastFailureMessage;
    int lastFailureExitCode = 5;
    int exitCode = 1;

    std::function<void()> attemptNextResult;
    std::function<void(const QString&, const QString&, int)> failAttempt;

#if AUQW_HAS_QT_MULTIMEDIA
    QAudioOutput audioOutput;
    QMediaPlayer player;
    QTimer playbackTimer;
    qint64 lastPlaybackPosition = 0;
    qint64 playbackDuration = 0;
    bool playbackAttached = false;
    bool playbackStarted = false;

    audioOutput.setVolume(0.1);
    player.setAudioOutput(&audioOutput);
    playbackTimer.setSingleShot(true);
    playbackTimer.setInterval(playbackWindowMs);

    QObject::connect(&player, &QMediaPlayer::positionChanged, &app, [&](qint64 position) {
        lastPlaybackPosition = position;
    });
    QObject::connect(&player, &QMediaPlayer::durationChanged, &app, [&](qint64 duration) {
        playbackDuration = duration;
        out << "playback_duration_ms=" << duration << '\n';
        out.flush();
    });
    QObject::connect(&player, &QMediaPlayer::mediaStatusChanged, &app, [&](QMediaPlayer::MediaStatus status) {
        out << "media_status=" << mediaStatusName(status) << '\n';
        out.flush();
    });
    QObject::connect(&player, &QMediaPlayer::playbackStateChanged, &app, [&](QMediaPlayer::PlaybackState state) {
        out << "playback_state=" << playbackStateName(state) << '\n';
        out << "position_ms=" << lastPlaybackPosition << '\n';
        out.flush();
        if (state == QMediaPlayer::PlayingState) {
            playbackStarted = true;
            return;
        }
        if (state != QMediaPlayer::StoppedState || !playbackSmoke || !playbackAttached || !playbackStarted || !playbackTimer.isActive()) {
            return;
        }
        const bool nearEnd = playbackDuration > 0 && lastPlaybackPosition + 1500 >= playbackDuration;
        if (!nearEnd && lastPlaybackPosition < minPlaybackPositionMs && failAttempt) {
            failAttempt(
                QStringLiteral("playback_stopped_early"),
                QStringLiteral("position_ms=%1 duration_ms=%2").arg(lastPlaybackPosition).arg(playbackDuration),
                11);
        }
    });
    QObject::connect(&player, &QMediaPlayer::errorOccurred, &app, [&](QMediaPlayer::Error error, const QString& message) {
        if (error == QMediaPlayer::NoError) {
            return;
        }
        if (failAttempt) {
            failAttempt(QStringLiteral("playback_error"), message, 8);
        }
    });
    QObject::connect(&playbackTimer, &QTimer::timeout, &app, [&] {
        if (lastPlaybackPosition >= minPlaybackPositionMs) {
            out << "status=playback_progress\n";
            out << "attempt=" << activeAttempt << '\n';
            out << "position_ms=" << lastPlaybackPosition << '\n';
            out.flush();
            exitCode = 0;
            app.quit();
        } else if (failAttempt) {
            failAttempt(
                QStringLiteral("playback_stalled"),
                QStringLiteral("position_ms=%1").arg(lastPlaybackPosition),
                9);
        }
    });

    auto attachPlaybackDevice = [&](QIODevice* streamDevice) {
        if (!playbackSmoke || playbackAttached || streamDevice == nullptr) {
            return;
        }
        playbackAttached = true;
        playbackStarted = false;
        lastPlaybackPosition = 0;
        playbackDuration = 0;
        player.setSourceDevice(streamDevice);
        player.play();
        playbackTimer.start();
    };
#else
    if (playbackSmoke) {
        err << "status=playback_smoke_unsupported\n";
        err.flush();
        return 10;
    }
#endif

    QTimer timeout;
    timeout.setSingleShot(true);
    timeout.setInterval(positiveEnvInt("AUQW_SABR_SMOKE_TIMEOUT_MS", 45000));

    QObject::connect(&timeout, &QTimer::timeout, &app, [&] {
        err << "status=timeout\n";
        err.flush();
        exitCode = 2;
        app.quit();
    });

    failAttempt = [&](const QString& status, const QString& message, int code) {
        lastFailureStatus = status;
        lastFailureMessage = message;
        lastFailureExitCode = code;
        err << "status=" << status << '\n';
        err << "attempt=" << activeAttempt << '\n';
        if (!message.isEmpty()) {
            err << "message=" << message << '\n';
        }
        err.flush();
#if AUQW_HAS_QT_MULTIMEDIA
        playbackTimer.stop();
        playbackAttached = false;
        playbackStarted = false;
        player.stop();
        lastPlaybackPosition = 0;
        playbackDuration = 0;
#endif
        QTimer::singleShot(0, &app, [&] {
            attemptNextResult();
        });
    };

    attemptNextResult = [&] {
#if AUQW_HAS_QT_MULTIMEDIA
        playbackTimer.stop();
        playbackAttached = false;
        playbackStarted = false;
        player.stop();
        lastPlaybackPosition = 0;
        playbackDuration = 0;
#endif
        if (device) {
            device->close();
            device.reset();
        }

        const qsizetype attemptLimit = std::min<qsizetype>(maxResults, searchResults.size());
        if (attemptIndex >= attemptLimit) {
            err << "status=all_results_failed\n";
            if (!lastFailureStatus.isEmpty()) {
                err << "last_status=" << lastFailureStatus << '\n';
            }
            if (!lastFailureMessage.isEmpty()) {
                err << "message=" << lastFailureMessage << '\n';
            }
            err.flush();
            exitCode = lastFailureExitCode;
            app.quit();
            return;
        }

        const OnlineTrackResult track = searchResults.at(attemptIndex);
        activeAttempt = attemptIndex + 1;
        ++attemptIndex;
        out << "result_attempt=" << activeAttempt << '\n';
        out << "result_title=" << track.title << '\n';
        out << "result_provider=" << track.provider << '\n';
        out << "result_id=" << track.providerTrackId << '\n';
        out.flush();
        provider->resolveStream(track.provider, track.providerTrackId);
    };

    QObject::connect(provider.get(), &OnlineProvider::searchSucceeded, &app, [&](const QString&, const QVector<OnlineTrackResult>& results) {
        if (results.isEmpty()) {
            err << "status=no_results\n";
            err.flush();
            exitCode = 3;
            app.quit();
            return;
        }

        searchResults = results;
        attemptIndex = 0;
        attemptNextResult();
    });

    QObject::connect(provider.get(), &OnlineProvider::searchFailed, &app, [&](const QString&, const QString& message) {
        err << "status=search_failed\n";
        err << "message=" << message << '\n';
        err.flush();
        exitCode = 4;
        app.quit();
    });

    QObject::connect(provider.get(), &OnlineProvider::streamResolveFailed, &app, [&](const QString&, const QString&, const QString& message) {
        failAttempt(QStringLiteral("resolve_failed"), message, 5);
    });

    QObject::connect(provider.get(), &OnlineProvider::streamResolved, &app, [&](const QString&, const QString&, const OnlineStreamResult& stream) {
        if (stream.streamKind == OnlineStreamKind::HeaderedDirectUrl) {
            out << "stream=headered_direct_url\n";
            out << "attempt=" << activeAttempt << '\n';
            out << "client=" << stream.clientName << '\n';
            out << "itag=" << stream.itag << '\n';
            out << "mime_type=" << stream.mimeType << '\n';
            out.flush();

            auto httpDevice = std::make_unique<YoutubeHttpAudioDevice>(stream.streamUrl, stream.requestHeaders);
            QObject::connect(httpDevice.get(), &YoutubeHttpAudioDevice::firstAudioBytes, &app, [&](qint64 bytes) {
                out << "status=first_audio_bytes\n";
                out << "attempt=" << activeAttempt << '\n';
                out << "bytes=" << bytes << '\n';
                out.flush();
                if (playbackSmoke) {
#if AUQW_HAS_QT_MULTIMEDIA
                    QTimer::singleShot(1500, &app, [&] {
                        attachPlaybackDevice(device.get());
                    });
#endif
                    return;
                }
                exitCode = 0;
                app.quit();
            });
            QObject::connect(httpDevice.get(), &YoutubeHttpAudioDevice::prebufferReady, &app, [&] {
#if AUQW_HAS_QT_MULTIMEDIA
                attachPlaybackDevice(device.get());
#endif
            });
            QObject::connect(httpDevice.get(), &YoutubeHttpAudioDevice::streamError, &app, [&](const QString& message) {
                failAttempt(QStringLiteral("direct_stream_error"), message, 6);
            });
            device = std::move(httpDevice);
            if (!device->open(QIODevice::ReadOnly)) {
                failAttempt(QStringLiteral("device_open_failed"), device->errorString(), 7);
            }
            return;
        }

        if (stream.streamKind == OnlineStreamKind::DirectUrl || !stream.isSabr) {
            out << "stream=direct_url\n";
            out << "attempt=" << activeAttempt << '\n';
            out << "client=" << stream.clientName << '\n';
            out << "itag=" << stream.itag << '\n';
            out << "mime_type=" << stream.mimeType << '\n';
            out << "url=" << stream.streamUrl.toString() << '\n';
            out.flush();
            if (playbackSmoke) {
#if AUQW_HAS_QT_MULTIMEDIA
                playbackAttached = true;
                playbackStarted = false;
                lastPlaybackPosition = 0;
                playbackDuration = 0;
                player.setSource(stream.streamUrl);
                player.play();
                playbackTimer.start();
#endif
                return;
            }
            exitCode = 0;
            app.quit();
            return;
        }

        out << "stream=sabr\n";
        out << "attempt=" << activeAttempt << '\n';
        out << "audio_formats=" << stream.sabr.audioFormats.size() << '\n';
        out << "mime_type=" << stream.mimeType << '\n';
        out.flush();

        auto sabrDevice = std::make_unique<YoutubeSabrAudioDevice>(stream.sabr);
        QObject::connect(sabrDevice.get(), &YoutubeSabrAudioDevice::firstAudioBytes, &app, [&](qint64 bytes) {
            out << "status=first_audio_bytes\n";
            out << "attempt=" << activeAttempt << '\n';
            out << "bytes=" << bytes << '\n';
            out.flush();
            if (playbackSmoke) {
#if AUQW_HAS_QT_MULTIMEDIA
                QTimer::singleShot(1500, &app, [&] {
                    attachPlaybackDevice(device.get());
                });
#endif
                return;
            }
            exitCode = 0;
            app.quit();
        });
        QObject::connect(sabrDevice.get(), &YoutubeSabrAudioDevice::prebufferReady, &app, [&] {
#if AUQW_HAS_QT_MULTIMEDIA
            attachPlaybackDevice(device.get());
#endif
        });
        QObject::connect(sabrDevice.get(), &YoutubeSabrAudioDevice::streamError, &app, [&](const QString& message) {
            failAttempt(QStringLiteral("sabr_error"), message, 6);
        });

        device = std::move(sabrDevice);
        if (!device->open(QIODevice::ReadOnly)) {
            failAttempt(QStringLiteral("device_open_failed"), device->errorString(), 7);
        }
    });

    timeout.start();
    provider->searchTracks(query);
    app.exec();

    if (device) {
        device->close();
    }
    return exitCode;
}
