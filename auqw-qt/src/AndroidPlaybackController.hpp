#pragma once

#include <QObject>
#include <QString>

class CoreController;

class AndroidPlaybackController final : public QObject {
    Q_OBJECT

public:
    explicit AndroidPlaybackController(CoreController& coreController, QObject* parent = nullptr);
    ~AndroidPlaybackController() override;

    void handlePlaybackCommand(const QString& command, qint64 positionMs);

private:
    void syncPlaybackState() const;

    CoreController& coreController_;
};
