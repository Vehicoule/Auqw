qt_standard_project_setup(REQUIRES 6.4)
if(QT_KNOWN_POLICY_QTP0004)
    qt_policy(SET QTP0004 NEW)
endif()
include(GNUInstallDirs)

set(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND OFF)
if(Qt6Multimedia_FOUND)
    set(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND ON)
endif()

set(AUQW_ENABLE_DESKTOP_PLATFORM OFF)
if(Qt6Widgets_FOUND AND NOT ANDROID)
    set(AUQW_ENABLE_DESKTOP_PLATFORM ON)
endif()

set(AUQW_ENABLE_ANDROID_PLATFORM OFF)
if(ANDROID)
    set(AUQW_ENABLE_ANDROID_PLATFORM ON)
endif()

set(AUQW_ENABLE_IOS_PLATFORM OFF)
if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    set(AUQW_ENABLE_IOS_PLATFORM ON)
    enable_language(OBJCXX)
endif()

qt_add_library(auqw_qt_runtime STATIC
    src/CoreController.cpp
    src/CoreController.hpp
    src/CoreControllerDownloads.cpp
    src/CoreControllerLibrary.cpp
    src/CoreControllerPlayback.cpp
    src/CoreControllerSearch.cpp
    src/DownloadWorker.cpp
    src/DownloadWorker.hpp
    src/InnertubeProvider.cpp
    src/InnertubeProvider.hpp
    src/InnertubeProviderParsing.cpp
    src/JsonListModel.cpp
    src/JsonListModel.hpp
    src/OnlineProvider.cpp
    src/OnlineProvider.hpp
    src/PlaybackBackend.cpp
    src/PlaybackBackend.hpp
    src/YoutubeHttpAudioDevice.cpp
    src/YoutubeHttpAudioDevice.hpp
    src/YoutubePlaybackResolver.cpp
    src/YoutubePlaybackResolver.hpp
    src/YoutubePlaybackResolverParsing.cpp
    src/YoutubeSabrAudioDevice.cpp
    src/YoutubeSabrAudioDevice.hpp
    src/YoutubeSabrSession.cpp
    src/YoutubeSabrSession.hpp
    src/YoutubeSabrTypes.hpp
    src/YoutubeUmpParser.cpp
    src/YoutubeUmpParser.hpp
)

target_link_libraries(auqw_qt_runtime
    PUBLIC
        Qt6::Core
        Qt6::Network
        auqw_bridge
)

target_compile_definitions(auqw_qt_runtime
    PUBLIC
        AUQW_HAS_QT_MULTIMEDIA=$<BOOL:${AUQW_ENABLE_QT_MULTIMEDIA_BACKEND}>
        AUQW_ENABLE_DESKTOP_PLATFORM=$<BOOL:${AUQW_ENABLE_DESKTOP_PLATFORM}>
        AUQW_ENABLE_ANDROID_PLATFORM=$<BOOL:${AUQW_ENABLE_ANDROID_PLATFORM}>
        AUQW_ENABLE_IOS_PLATFORM=$<BOOL:${AUQW_ENABLE_IOS_PLATFORM}>
        AUQW_APP_ID="com.Vehicoule.auqw"
        AUQW_APP_NAME="Auqw"
)

if(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND)
    target_link_libraries(auqw_qt_runtime PUBLIC Qt6::Multimedia)
endif()

if(AUQW_ENABLE_ANDROID_PLATFORM)
    target_sources(auqw_qt_runtime
        PRIVATE
            src/AndroidNativePlaybackBackend.cpp
    )
endif()

if(AUQW_ENABLE_QT_PCH)
    target_precompile_headers(auqw_qt_runtime
        PRIVATE
            <QObject>
            <QString>
            <QVector>
            <QJsonObject>
            <QNetworkAccessManager>
            <memory>
            <optional>
    )
endif()

if(AUQW_ENABLE_DESKTOP_PLATFORM)
    qt_add_library(auqw_qt_desktop_platform STATIC
        src/DesktopPlatformController.cpp
        src/DesktopPlatformController.hpp
    )

    target_link_libraries(auqw_qt_desktop_platform
        PUBLIC
            Qt6::Core
            Qt6::Widgets
            auqw_qt_runtime
    )
endif()

qt_add_executable(Auqw
    src/main.cpp
)

if(ANDROID)
    include(FetchContent)
    FetchContent_Declare(
        android_openssl
        GIT_REPOSITORY https://github.com/KDAB/android_openssl.git
        GIT_TAG b71f1470962019bd89534a2919f5925f93bc5779
    )
    FetchContent_MakeAvailable(android_openssl)
    include("${android_openssl_SOURCE_DIR}/android_openssl.cmake")
    add_android_openssl_libraries(Auqw)
endif()

if(AUQW_ENABLE_ANDROID_PLATFORM)
    target_sources(Auqw
        PRIVATE
            src/AndroidPlaybackController.cpp
            src/AndroidPlaybackController.hpp
    )
endif()

if(AUQW_ENABLE_IOS_PLATFORM)
    target_sources(Auqw
        PRIVATE
            src/ApplePlaybackBackend.mm
            src/IosPlaybackController.hpp
            src/IosPlaybackController.mm
    )
endif()

set_source_files_properties(qml/Main.qml
    PROPERTIES
        QT_RESOURCE_ALIAS Main.qml
)

set_source_files_properties(qml/components/AppTheme.qml
    PROPERTIES
        QT_RESOURCE_ALIAS components/AppTheme.qml
)

set_source_files_properties(qml/components/ArtworkTile.qml
    PROPERTIES
        QT_RESOURCE_ALIAS components/ArtworkTile.qml
)

set_source_files_properties(qml/components/AlbumBackdrop.qml
    PROPERTIES
        QT_RESOURCE_ALIAS components/AlbumBackdrop.qml
)

set_source_files_properties(qml/components/GlassSurface.qml
    PROPERTIES
        QT_RESOURCE_ALIAS components/GlassSurface.qml
)

set_source_files_properties(qml/components/PlayerControls.qml
    PROPERTIES
        QT_RESOURCE_ALIAS components/PlayerControls.qml
)

set_source_files_properties(qml/components/qmldir
    PROPERTIES
        QT_RESOURCE_ALIAS components/qmldir
)

qt_add_qml_module(Auqw
    URI Auqw
    VERSION 1.0
    RESOURCE_PREFIX /qt/qml
    QML_FILES
        qml/Main.qml
        qml/components/AppTheme.qml
        qml/components/AlbumBackdrop.qml
        qml/components/ArtworkTile.qml
        qml/components/GlassSurface.qml
        qml/components/PlayerControls.qml
    RESOURCES
        qml/components/qmldir
)

target_link_libraries(Auqw
    PRIVATE
        Qt6::Qml
        Qt6::Quick
        Qt6::QuickControls2
        Qt6::QuickDialogs2
        Qt6::QuickLayouts
        auqw_qt_runtime
)

if(AUQW_ENABLE_DESKTOP_PLATFORM)
    target_link_libraries(Auqw PRIVATE auqw_qt_desktop_platform)
endif()

if(AUQW_ENABLE_IOS_PLATFORM)
    target_link_libraries(Auqw PRIVATE "-framework AVFoundation" "-framework MediaPlayer")
    target_compile_options(Auqw PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
endif()

set_target_properties(Auqw PROPERTIES
    OUTPUT_NAME auqw
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    WIN32_EXECUTABLE TRUE
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_GUI_IDENTIFIER com.Vehicoule.auqw
    MACOSX_BUNDLE_BUNDLE_NAME Auqw
)

if(UNIX AND NOT APPLE AND NOT ANDROID)
    set_property(TARGET Auqw APPEND PROPERTY BUILD_RPATH "$ORIGIN/../lib")
    set_property(TARGET Auqw APPEND PROPERTY INSTALL_RPATH "$ORIGIN/../lib")
endif()

if(ANDROID)
    set_target_properties(Auqw PROPERTIES
        QT_ANDROID_ABIS arm64-v8a
        QT_ANDROID_PACKAGE_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/android"
        QT_ANDROID_SDK_BUILD_TOOLS_REVISION 35.0.0
        QT_ANDROID_MIN_SDK_VERSION 23
        QT_ANDROID_TARGET_SDK_VERSION 35
        QT_ANDROID_VERSION_CODE 1
        QT_ANDROID_VERSION_NAME ${PROJECT_VERSION}
    )
endif()

if(UNIX AND NOT APPLE AND NOT ANDROID)
    install(TARGETS Auqw
        RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}"
        BUNDLE DESTINATION "."
    )

    install(FILES "${PROJECT_SOURCE_DIR}/packaging/linux/com.vehicoule.auqw.desktop"
        DESTINATION "${CMAKE_INSTALL_DATADIR}/applications"
    )

    install(FILES "${PROJECT_SOURCE_DIR}/packaging/linux/com.vehicoule.auqw.metainfo.xml"
        DESTINATION "${CMAKE_INSTALL_DATADIR}/metainfo"
    )

    install(FILES "${PROJECT_SOURCE_DIR}/packaging/linux/com.vehicoule.auqw.png"
        DESTINATION "${CMAKE_INSTALL_DATADIR}/icons/hicolor/128x128/apps"
    )
endif()

if(BUILD_TESTING AND NOT ANDROID)
    qt_add_executable(auqw_qt_core_controller_test
        tests/core_controller_test.cpp
    )

    target_link_libraries(auqw_qt_core_controller_test
        PRIVATE
            Qt6::Test
            auqw_qt_runtime
    )

    add_test(NAME auqw_qt_core_controller_test COMMAND auqw_qt_core_controller_test)

    qt_add_executable(auqw_qt_qml_shell_smoke_test
        tests/qml_shell_smoke_test.cpp
    )

    target_link_libraries(auqw_qt_qml_shell_smoke_test
        PRIVATE
            Qt6::Qml
            Qt6::Quick
            Qt6::QuickControls2
            Qt6::QuickDialogs2
            Qt6::QuickLayouts
            Qt6::Test
            auqw_qt_runtime
    )

    target_compile_definitions(auqw_qt_qml_shell_smoke_test
        PRIVATE
            AUQW_QML_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml"
    )

    add_test(NAME auqw_qt_qml_shell_smoke_test COMMAND auqw_qt_qml_shell_smoke_test)
    set_tests_properties(auqw_qt_qml_shell_smoke_test PROPERTIES
        ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
    )

    qt_add_executable(auqw_qt_online_provider_test
        tests/online_provider_test.cpp
    )

    target_link_libraries(auqw_qt_online_provider_test
        PRIVATE
            Qt6::Test
            auqw_qt_runtime
    )

    target_compile_definitions(auqw_qt_online_provider_test
        PRIVATE
            AUQW_PROJECT_SOURCE_DIR="${PROJECT_SOURCE_DIR}"
    )

    add_test(NAME auqw_qt_online_provider_test COMMAND auqw_qt_online_provider_test)
    set_tests_properties(auqw_qt_online_provider_test PROPERTIES
        ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
    )

    qt_add_executable(auqw_qt_youtube_sabr_live_smoke
        tests/youtube_sabr_live_smoke.cpp
    )

    target_link_libraries(auqw_qt_youtube_sabr_live_smoke
        PRIVATE
            auqw_qt_runtime
    )

    qt_add_executable(auqw_qt_android_platform_package_test
        tests/android_platform_package_test.cpp
    )

    target_link_libraries(auqw_qt_android_platform_package_test
        PRIVATE
            Qt6::Core
            Qt6::Test
    )

    target_compile_definitions(auqw_qt_android_platform_package_test
        PRIVATE
            AUQW_ANDROID_PACKAGE_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/android"
    )

    add_test(NAME auqw_qt_android_platform_package_test COMMAND auqw_qt_android_platform_package_test)

    qt_add_executable(auqw_qt_ios_platform_wiring_test
        tests/ios_platform_wiring_test.cpp
    )

    target_link_libraries(auqw_qt_ios_platform_wiring_test
        PRIVATE
            Qt6::Core
            Qt6::Test
    )

    target_compile_definitions(auqw_qt_ios_platform_wiring_test
        PRIVATE
            AUQW_QT_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}"
    )

    add_test(NAME auqw_qt_ios_platform_wiring_test COMMAND auqw_qt_ios_platform_wiring_test)

    qt_add_executable(auqw_qt_platform_package_test
        tests/platform_package_test.cpp
    )

    target_link_libraries(auqw_qt_platform_package_test
        PRIVATE
            Qt6::Core
            Qt6::Test
    )

    target_compile_definitions(auqw_qt_platform_package_test
        PRIVATE
            AUQW_PROJECT_SOURCE_DIR="${PROJECT_SOURCE_DIR}"
    )

    add_test(NAME auqw_qt_platform_package_test COMMAND auqw_qt_platform_package_test)

    if(AUQW_ENABLE_DESKTOP_PLATFORM)
        qt_add_executable(auqw_qt_desktop_platform_controller_test
            tests/desktop_platform_controller_test.cpp
        )

        target_link_libraries(auqw_qt_desktop_platform_controller_test
            PRIVATE
                Qt6::Test
                auqw_qt_desktop_platform
        )

        add_test(NAME auqw_qt_desktop_platform_controller_test COMMAND auqw_qt_desktop_platform_controller_test)
        set_tests_properties(auqw_qt_desktop_platform_controller_test PROPERTIES
            ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
        )
    endif()
endif()
