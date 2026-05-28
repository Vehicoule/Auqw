#pragma once

#include <auqw/auqw_core.h>

#include <string>

namespace auqw {

struct InitOptions {
    std::string appId = "com.Vehicoule.auqw";
    std::string appName = "Auqw";
    std::string dataDir;
    std::string cacheDir;
};

class CoreBridge final {
public:
    static CoreBridge createDefault();

    explicit CoreBridge(const InitOptions& options);
    ~CoreBridge();

    CoreBridge(CoreBridge&& other) noexcept;
    CoreBridge& operator=(CoreBridge&& other) noexcept;

    CoreBridge(const CoreBridge&) = delete;
    CoreBridge& operator=(const CoreBridge&) = delete;

    [[nodiscard]] std::string helloText() const;
    [[nodiscard]] std::string invokeJson(const std::string& request) const;
    [[nodiscard]] bool isValid() const noexcept;

private:
    explicit CoreBridge(auqw_core_t* core) noexcept;

    auqw_core_t* core_ = nullptr;
};

} // namespace auqw
