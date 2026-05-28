#include <auqw/CoreBridge.hpp>

#include <stdexcept>
#include <utility>

namespace auqw {
namespace {

const char* nullableCString(const std::string& value) noexcept {
    return value.empty() ? nullptr : value.c_str();
}

auqw_init_options_t toCOptions(const InitOptions& options) noexcept {
    return auqw_init_options_t{
        .app_id = nullableCString(options.appId),
        .app_name = nullableCString(options.appName),
        .data_dir = nullableCString(options.dataDir),
        .cache_dir = nullableCString(options.cacheDir),
    };
}

} // namespace

CoreBridge CoreBridge::createDefault() {
    return CoreBridge(InitOptions{});
}

CoreBridge::CoreBridge(const InitOptions& options) {
    auqw_core_t* core = nullptr;
    const auqw_init_options_t c_options = toCOptions(options);
    const int result = auqw_core_create(&c_options, &core);

    if (result != AUQW_OK || core == nullptr) {
        throw std::runtime_error("failed to create Auqw core");
    }

    core_ = core;
}

CoreBridge::CoreBridge(auqw_core_t* core) noexcept
    : core_(core) {}

CoreBridge::~CoreBridge() {
    auqw_core_destroy(core_);
}

CoreBridge::CoreBridge(CoreBridge&& other) noexcept
    : core_(std::exchange(other.core_, nullptr)) {}

CoreBridge& CoreBridge::operator=(CoreBridge&& other) noexcept {
    if (this != &other) {
        auqw_core_destroy(core_);
        core_ = std::exchange(other.core_, nullptr);
    }

    return *this;
}

std::string CoreBridge::helloText() const {
    const char* text = auqw_core_hello(core_);
    return text == nullptr ? std::string{} : std::string{text};
}

std::string CoreBridge::invokeJson(const std::string& request) const {
    char* response = nullptr;
    const int result = auqw_core_invoke_json(core_, request.c_str(), &response);

    std::string body;
    if (response != nullptr) {
        body = response;
        auqw_free(response);
    }

    if (result != AUQW_OK && body.empty()) {
        throw std::runtime_error("failed to invoke Auqw core command");
    }

    return body;
}

bool CoreBridge::isValid() const noexcept {
    return core_ != nullptr;
}

} // namespace auqw
