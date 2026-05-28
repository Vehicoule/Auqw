if(NOT AUQW_CORE_LIB)
    if(WIN32)
        set(AUQW_CORE_LIB "${CMAKE_SOURCE_DIR}/auqw-core/zig-out/lib/auqw_core.lib")
    else()
        set(AUQW_CORE_LIB "${CMAKE_SOURCE_DIR}/auqw-core/zig-out/lib/libauqw_core.a")
    endif()
endif()

if(NOT EXISTS "${AUQW_CORE_LIB}")
    message(FATAL_ERROR "Auqw core library not found at ${AUQW_CORE_LIB}. Run `zig build` in auqw-core first, or pass -DAUQW_CORE_LIB=/path/to/libauqw_core.")
endif()

add_library(auqw_core STATIC IMPORTED GLOBAL)
set_target_properties(auqw_core PROPERTIES
    IMPORTED_LOCATION "${AUQW_CORE_LIB}"
)

add_library(auqw_bridge STATIC
    src/CoreBridge.cpp
)
target_include_directories(auqw_bridge
    PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(auqw_bridge
    PUBLIC
        auqw_core
)

add_executable(auqw_bridge_smoke
    tests/core_bridge_smoke.cpp
)
target_link_libraries(auqw_bridge_smoke
    PRIVATE
        auqw_bridge
)

if(BUILD_TESTING)
    add_test(NAME auqw_bridge_smoke COMMAND auqw_bridge_smoke)
endif()
