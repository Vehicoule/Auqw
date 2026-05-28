#include <auqw/CoreBridge.hpp>

#include <iostream>
#include <string>

int main() {
    auto core = auqw::CoreBridge::createDefault();
    const std::string hello = core.helloText();

    if (hello != "Hello from Auqw Core") {
        std::cerr << "unexpected hello text: " << hello << '\n';
        return 1;
    }

    const std::string metadata =
        core.invokeJson(R"({"id":"smoke","command":"core.get_metadata","params":{}})");
    if (metadata.find(R"("ok":true)") == std::string::npos ||
        metadata.find(R"("app_id":"com.Vehicoule.auqw")") == std::string::npos) {
        std::cerr << "unexpected metadata response: " << metadata << '\n';
        return 1;
    }

    return 0;
}
