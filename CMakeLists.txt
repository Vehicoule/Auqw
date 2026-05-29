cmake_minimum_required(VERSION 3.27)

project(Auqw VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

option(AUQW_BUILD_QT "Build the Qt/QML shell" ON)
set(AUQW_CORE_LIB "" CACHE FILEPATH "Path to the Zig-built Auqw core static library")

add_subdirectory(auqw-bridge)

if(AUQW_BUILD_QT)
    find_package(Qt6 6.5 REQUIRED COMPONENTS Core Qml Quick QuickControls2 QuickDialogs2 QuickLayouts)
    find_package(Qt6 6.5 QUIET COMPONENTS Multimedia)
    if(BUILD_TESTING AND NOT ANDROID)
        find_package(Qt6 6.5 REQUIRED COMPONENTS Test)
    endif()
    add_subdirectory(auqw-qt)
endif()
