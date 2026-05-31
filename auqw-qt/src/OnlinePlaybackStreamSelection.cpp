#include "OnlinePlaybackStreamSelection.hpp"

#ifndef AUQW_ENABLE_ANDROID_PLATFORM
#define AUQW_ENABLE_ANDROID_PLATFORM 0
#endif

bool isUsableSabrPlaybackStream(const OnlineStreamResult& stream) {
    return (stream.streamKind == OnlineStreamKind::Sabr || stream.isSabr)
        && stream.sabr.serverAbrStreamingUrl.isValid()
        && !stream.sabr.serverAbrStreamingUrl.isEmpty()
        && !stream.sabr.videoPlaybackUstreamerConfig.isEmpty()
        && !stream.sabr.audioFormats.isEmpty();
}

OnlineStreamResult selectPreferredOnlinePlaybackStream(
    const OnlineStreamResult& directStream,
    const std::optional<OnlineStreamResult>& fallbackStream,
    bool preferSabr) {
    if (preferSabr && fallbackStream.has_value() && isUsableSabrPlaybackStream(*fallbackStream)) {
        return *fallbackStream;
    }
    return directStream;
}

bool preferSabrPlaybackOnCurrentPlatform() {
    return AUQW_ENABLE_ANDROID_PLATFORM;
}
