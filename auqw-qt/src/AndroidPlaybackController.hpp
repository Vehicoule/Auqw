#pragma once

#include <QObject>

class CoreController;

class AndroidPlaybackController final : public QObject {
    Q_OBJECT

public:
    explicit AndroidPlaybackController(CoreController& coreController, QObject* parent = nullptr);
    ~AndroidPlaybackController() override;

private:
    void syncPlaybackState() const;

    CoreController& coreController_;
};
