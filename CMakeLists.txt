cmake_minimum_required(VERSION 3.27)

project(Auqw VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

option(AUQW_BUILD_QT "Build the Qt/QML shell" ON)
option(AUQW_REQUIRE_QT_MULTIMEDIA "Require Qt Multimedia when building the Qt/QML shell" OFF)
option(AUQW_ENABLE_CCACHE "Use ccache as the C++ compiler launcher when available" ON)
option(AUQW_ENABLE_QT_PCH "Use precompiled headers for shared Qt runtime sources" ON)
set(AUQW_CORE_LIB "" CACHE FILEPATH "Path to the Zig-built Auqw core static library")

if(AUQW_ENABLE_CCACHE AND NOT CMAKE_CXX_COMPILER_LAUNCHER)
    find_program(AUQW_CCACHE_PROGRAM ccache)
    if(AUQW_CCACHE_PROGRAM)
        set(CMAKE_CXX_COMPILER_LAUNCHER "${AUQW_CCACHE_PROGRAM}")
    endif()
endif()

add_subdirectory(auqw-bridge)

if(AUQW_BUILD_QT)
    find_package(Qt6 6.5 REQUIRED COMPONENTS Core Network Qml Quick QuickControls2 QuickDialogs2 QuickLayouts)
    if(ANDROID OR AUQW_REQUIRE_QT_MULTIMEDIA)
        find_package(Qt6 6.5 REQUIRED COMPONENTS Multimedia)
    else()
        find_package(Qt6 6.5 QUIET COMPONENTS Multimedia)
    endif()
    find_package(Qt6 6.5 QUIET COMPONENTS Widgets)
    if(BUILD_TESTING AND NOT ANDROID)
        find_package(Qt6 6.5 REQUIRED COMPONENTS Test)
    endif()
    add_subdirectory(auqw-qt)
endif()
