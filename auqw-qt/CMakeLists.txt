qt_standard_project_setup(REQUIRES 6.5)

set(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND OFF)
if(Qt6Multimedia_FOUND AND NOT ANDROID)
    set(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND ON)
endif()

set(AUQW_ENABLE_DESKTOP_PLATFORM OFF)
if(Qt6Widgets_FOUND AND NOT ANDROID)
    set(AUQW_ENABLE_DESKTOP_PLATFORM ON)
endif()

qt_add_executable(Auqw
    src/main.cpp
    src/CoreController.cpp
    src/CoreController.hpp
    src/PlaybackBackend.cpp
    src/PlaybackBackend.hpp
)

if(AUQW_ENABLE_DESKTOP_PLATFORM)
    target_sources(Auqw
        PRIVATE
            src/DesktopPlatformController.cpp
            src/DesktopPlatformController.hpp
    )
endif()

qt_add_qml_module(Auqw
    URI Auqw
    VERSION 1.0
    QML_FILES
        qml/Main.qml
)

target_link_libraries(Auqw
    PRIVATE
        Qt6::Core
        Qt6::Qml
        Qt6::Quick
        Qt6::QuickControls2
        Qt6::QuickDialogs2
        Qt6::QuickLayouts
        auqw_bridge
)

target_compile_definitions(Auqw
    PRIVATE
        AUQW_HAS_QT_MULTIMEDIA=$<BOOL:${AUQW_ENABLE_QT_MULTIMEDIA_BACKEND}>
        AUQW_ENABLE_DESKTOP_PLATFORM=$<BOOL:${AUQW_ENABLE_DESKTOP_PLATFORM}>
)

if(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND)
    target_link_libraries(Auqw PRIVATE Qt6::Multimedia)
endif()

if(AUQW_ENABLE_DESKTOP_PLATFORM)
    target_link_libraries(Auqw PRIVATE Qt6::Widgets)
endif()

target_compile_definitions(Auqw
    PRIVATE
        AUQW_APP_ID="com.Vehicoule.auqw"
        AUQW_APP_NAME="Auqw"
)

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
        QT_ANDROID_SDK_BUILD_TOOLS_REVISION 34.0.0
        QT_ANDROID_MIN_SDK_VERSION 23
        QT_ANDROID_TARGET_SDK_VERSION 33
        QT_ANDROID_VERSION_CODE 1
        QT_ANDROID_VERSION_NAME ${PROJECT_VERSION}
    )
endif()

if(BUILD_TESTING AND NOT ANDROID)
    qt_add_executable(auqw_qt_core_controller_test
        tests/core_controller_test.cpp
        src/CoreController.cpp
        src/CoreController.hpp
        src/PlaybackBackend.cpp
        src/PlaybackBackend.hpp
    )

    target_link_libraries(auqw_qt_core_controller_test
        PRIVATE
            Qt6::Core
            Qt6::Test
            auqw_bridge
    )

    target_compile_definitions(auqw_qt_core_controller_test
        PRIVATE
            AUQW_HAS_QT_MULTIMEDIA=$<BOOL:${AUQW_ENABLE_QT_MULTIMEDIA_BACKEND}>
    )

    if(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND)
        target_link_libraries(auqw_qt_core_controller_test PRIVATE Qt6::Multimedia)
    endif()

    target_compile_definitions(auqw_qt_core_controller_test
        PRIVATE
            AUQW_APP_ID="com.Vehicoule.auqw"
            AUQW_APP_NAME="Auqw"
    )

    add_test(NAME auqw_qt_core_controller_test COMMAND auqw_qt_core_controller_test)

    qt_add_executable(auqw_qt_qml_shell_smoke_test
        tests/qml_shell_smoke_test.cpp
        src/CoreController.cpp
        src/CoreController.hpp
        src/PlaybackBackend.cpp
        src/PlaybackBackend.hpp
    )

    target_link_libraries(auqw_qt_qml_shell_smoke_test
        PRIVATE
            Qt6::Core
            Qt6::Qml
            Qt6::Quick
            Qt6::QuickControls2
            Qt6::QuickDialogs2
            Qt6::QuickLayouts
            Qt6::Test
            auqw_bridge
    )

    target_compile_definitions(auqw_qt_qml_shell_smoke_test
        PRIVATE
            AUQW_HAS_QT_MULTIMEDIA=$<BOOL:${AUQW_ENABLE_QT_MULTIMEDIA_BACKEND}>
    )

    if(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND)
        target_link_libraries(auqw_qt_qml_shell_smoke_test PRIVATE Qt6::Multimedia)
    endif()

    target_compile_definitions(auqw_qt_qml_shell_smoke_test
        PRIVATE
            AUQW_APP_ID="com.Vehicoule.auqw"
            AUQW_APP_NAME="Auqw"
            AUQW_QML_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/qml"
    )

    add_test(NAME auqw_qt_qml_shell_smoke_test COMMAND auqw_qt_qml_shell_smoke_test)
    set_tests_properties(auqw_qt_qml_shell_smoke_test PROPERTIES
        ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
    )

    if(AUQW_ENABLE_DESKTOP_PLATFORM)
        qt_add_executable(auqw_qt_desktop_platform_controller_test
            tests/desktop_platform_controller_test.cpp
            src/CoreController.cpp
            src/CoreController.hpp
            src/DesktopPlatformController.cpp
            src/DesktopPlatformController.hpp
            src/PlaybackBackend.cpp
            src/PlaybackBackend.hpp
        )

        target_link_libraries(auqw_qt_desktop_platform_controller_test
            PRIVATE
                Qt6::Core
                Qt6::Test
                Qt6::Widgets
                auqw_bridge
        )

        target_compile_definitions(auqw_qt_desktop_platform_controller_test
            PRIVATE
                AUQW_HAS_QT_MULTIMEDIA=$<BOOL:${AUQW_ENABLE_QT_MULTIMEDIA_BACKEND}>
        )

        if(AUQW_ENABLE_QT_MULTIMEDIA_BACKEND)
            target_link_libraries(auqw_qt_desktop_platform_controller_test PRIVATE Qt6::Multimedia)
        endif()

        target_compile_definitions(auqw_qt_desktop_platform_controller_test
            PRIVATE
                AUQW_APP_ID="com.Vehicoule.auqw"
                AUQW_APP_NAME="Auqw"
        )

        add_test(NAME auqw_qt_desktop_platform_controller_test COMMAND auqw_qt_desktop_platform_controller_test)
        set_tests_properties(auqw_qt_desktop_platform_controller_test PROPERTIES
            ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
        )
    endif()
endif()
