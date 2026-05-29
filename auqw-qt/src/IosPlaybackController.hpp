#pragma once

#include <QObject>

#include <memory>

class CoreController;
class IosPlaybackControllerPrivate;

class IosPlaybackController final : public QObject {
    Q_OBJECT

public:
    explicit IosPlaybackController(CoreController& coreController, QObject* parent = nullptr);
    ~IosPlaybackController() override;

private:
    void configureAudioSession();
    void registerRemoteCommands();
    void unregisterRemoteCommands();
    void handlePlayCommand();
    void syncNowPlayingInfo() const;

    CoreController& coreController_;
    std::unique_ptr<IosPlaybackControllerPrivate> d_;
};
