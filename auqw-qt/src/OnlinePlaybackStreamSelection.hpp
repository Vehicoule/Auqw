#pragma once

#include "OnlineProvider.hpp"

#include <optional>

[[nodiscard]] bool isUsableSabrPlaybackStream(const OnlineStreamResult& stream);
[[nodiscard]] OnlineStreamResult selectPreferredOnlinePlaybackStream(
    const OnlineStreamResult& directStream,
    const std::optional<OnlineStreamResult>& fallbackStream,
    bool preferSabr);
[[nodiscard]] bool preferSabrPlaybackOnCurrentPlatform();
