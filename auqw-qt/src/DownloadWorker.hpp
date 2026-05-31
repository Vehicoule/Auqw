#pragma once

#include "OnlineProvider.hpp"
#include "YoutubeSabrSession.hpp"

#include <QByteArray>
#include <QList>
#include <QNetworkAccessManager>
#include <QObject>
#include <QPointer>
#include <QString>
#include <QUrl>
#include <QVariantMap>

#include <memory>

class QNetworkReply;
class QSaveFile;

class DownloadWorker final : public QObject {
    Q_OBJECT

public:
    struct Job {
        QString downloadId;
        QString provider;
        QString providerTrackId;
        QString title;
        QString downloadDirectory;
    };

    DownloadWorker(Job job, OnlineProvider* provider, QObject* parent = nullptr);
    ~DownloadWorker() override;

    [[nodiscard]] QString downloadId() const;
    [[nodiscard]] QString targetPath() const;

    void start();
    void cancel();

signals:
    void updateRequested(const QString& downloadId, const QVariantMap& fields);
    void completed(const QString& downloadId, const QString& targetPath);
    void failed(const QString& downloadId, const QString& message, const QString& targetPath);
    void cancelled(const QString& downloadId, const QString& targetPath);

private:
    void handleStreamResolved(const QString& provider, const QString& providerTrackId, const OnlineStreamResult& stream);
    void handleStreamResolveFailed(const QString& provider, const QString& providerTrackId, const QString& message);
    void startDirect(const OnlineStreamResult& stream, const QString& streamKind);
    void startSabr(const OnlineStreamResult& stream);
    void appendDirectReplyBytes();
    void appendBytes(const QByteArray& bytes);
    void handleDirectFinished();
    void handleSabrEnded();
    void emitProgress(int progress);
    void complete();
    void fail(const QString& message);
    void cleanupOutput(bool removeTarget);
    [[nodiscard]] bool matches(const QString& provider, const QString& providerTrackId) const;
    [[nodiscard]] QString resolvedTargetPath(const OnlineStreamResult& stream, const QString& streamKind) const;

    Job job_;
    QPointer<OnlineProvider> provider_;
    QNetworkAccessManager network_;
    QPointer<QNetworkReply> reply_;
    std::unique_ptr<YoutubeSabrSession> sabrSession_;
    std::unique_ptr<QSaveFile> output_;
    QString targetPath_;
    QString mimeType_;
    QString streamKind_;
    qint64 bytesReceived_ = 0;
    qint64 bytesTotal_ = -1;
    bool started_ = false;
    bool cancelled_ = false;
    bool finished_ = false;
};
