#include "../src/OnlineProvider.hpp"
#include "../src/YoutubeHttpAudioDevice.hpp"
#include "../src/YoutubeSabrAudioDevice.hpp"

#include <QCoreApplication>
#include <QIODevice>
#include <QTimer>
#include <QTextStream>

#if AUQW_HAS_QT_MULTIMEDIA
#include <QAudioOutput>
#include <QMediaPlayer>
#endif

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    QTextStream out(stdout);
    QTextStream err(stderr);

    const QString query = app.arguments().size() > 1 ? app.arguments().at(1) : QStringLiteral("rolling in the");
    const bool playbackSmoke = qEnvironmentVariableIntValue("AUQW_SABR_SMOKE_PLAYBACK") > 0;
    out << "query=" << query << '\n';
    out.flush();

    auto provider = createDefaultOnlineProvider();
    std::unique_ptr<QIODevice> device;
    int exitCode = 1;

#if AUQW_HAS_QT_MULTIMEDIA
    QAudioOutput audioOutput;
    QMediaPlayer player;
    QTimer playbackTimer;
    qint64 lastPlaybackPosition = 0;
    bool playbackAttached = false;

    audioOutput.setVolume(0.1);
    player.setAudioOutput(&audioOutput);
    playbackTimer.setSingleShot(true);
    playbackTimer.setInterval(5000);

    QObject::connect(&player, &QMediaPlayer::positionChanged, &app, [&](qint64 position) {
        lastPlaybackPosition = position;
    });
    QObject::connect(&player, &QMediaPlayer::errorOccurred, &app, [&](QMediaPlayer::Error error, const QString& message) {
        if (error == QMediaPlayer::NoError) {
            return;
        }
        err << "status=playback_error\n";
        err << "message=" << message << '\n';
        err.flush();
        exitCode = 8;
        app.quit();
    });
    QObject::connect(&playbackTimer, &QTimer::timeout, &app, [&] {
        if (lastPlaybackPosition >= 1000) {
            out << "status=playback_progress\n";
            out << "position_ms=" << lastPlaybackPosition << '\n';
            out.flush();
            exitCode = 0;
        } else {
            err << "status=playback_stalled\n";
            err << "position_ms=" << lastPlaybackPosition << '\n';
            err.flush();
            exitCode = 9;
        }
        app.quit();
    });

    auto attachPlaybackDevice = [&](QIODevice* streamDevice) {
        if (!playbackSmoke || playbackAttached || streamDevice == nullptr) {
            return;
        }
        playbackAttached = true;
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
    timeout.setInterval(qEnvironmentVariableIntValue("AUQW_SABR_SMOKE_TIMEOUT_MS") > 0
                            ? qEnvironmentVariableIntValue("AUQW_SABR_SMOKE_TIMEOUT_MS")
                            : 45000);

    QObject::connect(&timeout, &QTimer::timeout, &app, [&] {
        err << "status=timeout\n";
        err.flush();
        exitCode = 2;
        app.quit();
    });

    QObject::connect(provider.get(), &OnlineProvider::searchSucceeded, &app, [&](const QString&, const QVector<OnlineTrackResult>& results) {
        if (results.isEmpty()) {
            err << "status=no_results\n";
            err.flush();
            exitCode = 3;
            app.quit();
            return;
        }

        const OnlineTrackResult track = results.first();
        out << "first_result_title=" << track.title << '\n';
        out << "first_result_provider=" << track.provider << '\n';
        out << "first_result_id=" << track.providerTrackId << '\n';
        out.flush();
        provider->resolveStream(track.provider, track.providerTrackId);
    });

    QObject::connect(provider.get(), &OnlineProvider::searchFailed, &app, [&](const QString&, const QString& message) {
        err << "status=search_failed\n";
        err << "message=" << message << '\n';
        err.flush();
        exitCode = 4;
        app.quit();
    });

    QObject::connect(provider.get(), &OnlineProvider::streamResolveFailed, &app, [&](const QString&, const QString&, const QString& message) {
        err << "status=resolve_failed\n";
        err << "message=" << message << '\n';
        err.flush();
        exitCode = 5;
        app.quit();
    });

    QObject::connect(provider.get(), &OnlineProvider::streamResolved, &app, [&](const QString&, const QString&, const OnlineStreamResult& stream) {
        if (stream.streamKind == OnlineStreamKind::HeaderedDirectUrl) {
            out << "stream=headered_direct_url\n";
            out << "client=" << stream.clientName << '\n';
            out << "itag=" << stream.itag << '\n';
            out << "mime_type=" << stream.mimeType << '\n';
            out.flush();

            auto httpDevice = std::make_unique<YoutubeHttpAudioDevice>(stream.streamUrl, stream.requestHeaders);
            QObject::connect(httpDevice.get(), &YoutubeHttpAudioDevice::firstAudioBytes, &app, [&](qint64 bytes) {
                out << "status=first_audio_bytes\n";
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
                err << "status=direct_stream_error\n";
                err << "message=" << message << '\n';
                err.flush();
                exitCode = 6;
                app.quit();
            });
            device = std::move(httpDevice);
            if (!device->open(QIODevice::ReadOnly)) {
                err << "status=device_open_failed\n";
                err.flush();
                exitCode = 7;
                app.quit();
            }
            return;
        }

        if (stream.streamKind == OnlineStreamKind::DirectUrl || !stream.isSabr) {
            out << "stream=direct_url\n";
            out << "client=" << stream.clientName << '\n';
            out << "itag=" << stream.itag << '\n';
            out << "mime_type=" << stream.mimeType << '\n';
            out << "url=" << stream.streamUrl.toString() << '\n';
            out.flush();
            exitCode = 0;
            app.quit();
            return;
        }

        out << "stream=sabr\n";
        out << "audio_formats=" << stream.sabr.audioFormats.size() << '\n';
        out << "mime_type=" << stream.mimeType << '\n';
        out.flush();

        auto sabrDevice = std::make_unique<YoutubeSabrAudioDevice>(stream.sabr);
        QObject::connect(sabrDevice.get(), &YoutubeSabrAudioDevice::firstAudioBytes, &app, [&](qint64 bytes) {
            out << "status=first_audio_bytes\n";
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
            err << "status=sabr_error\n";
            err << "message=" << message << '\n';
            err.flush();
            exitCode = 6;
            app.quit();
        });

        device = std::move(sabrDevice);
        if (!device->open(QIODevice::ReadOnly)) {
            err << "status=device_open_failed\n";
            err.flush();
            exitCode = 7;
            app.quit();
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
