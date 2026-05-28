#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct auqw_core auqw_core_t;

typedef struct auqw_init_options {
    const char* app_id;
    const char* app_name;
    const char* data_dir;
    const char* cache_dir;
} auqw_init_options_t;

enum {
    AUQW_OK = 0,
    AUQW_ERROR_INVALID_ARGUMENT = 1,
    AUQW_ERROR_ALLOCATION_FAILED = 2,
    AUQW_ERROR_DATABASE = 3,
    AUQW_ERROR_INVALID_JSON = 4,
    AUQW_ERROR_UNKNOWN_COMMAND = 5,
    AUQW_ERROR_INTERNAL = 6,
};

int auqw_core_create(const auqw_init_options_t* options, auqw_core_t** out_core);
void auqw_core_destroy(auqw_core_t* core);

const char* auqw_core_hello(auqw_core_t* core);
int auqw_core_invoke_json(auqw_core_t* core, const char* request_json, char** out_response_json);
void auqw_free(void* ptr);

#ifdef __cplusplus
}
#endif
