#pragma once

#include "YoutubeSabrSession.hpp"
#include "YoutubeStreamBuffer.hpp"
#include "YoutubeSabrTypes.hpp"

#include <QIODevice>

class YoutubeSabrAudioDevice final : public QIODevice {
    Q_OBJECT

public:
    explicit YoutubeSabrAudioDevice(YoutubeSabrStreamInfo streamInfo, QObject* parent = nullptr);
    ~YoutubeSabrAudioDevice() override;

    bool open(OpenMode mode) override;
    void close() override;
    [[nodiscard]] bool isSequential() const override;
    [[nodiscard]] qint64 bytesAvailable() const override;

signals:
    void streamError(const QString& message);
    void firstAudioBytes(qint64 bytes);
    void prebufferReady(qint64 bytes);

protected:
    qint64 readData(char* data, qint64 maxSize) override;
    qint64 writeData(const char* data, qint64 maxSize) override;

private:
    YoutubeSabrSession session_;
    YoutubeStreamBuffer buffer_;
    bool prebufferEmitted_ = false;
};
