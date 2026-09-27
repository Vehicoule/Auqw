// A separate Node-API addon can wrap any native pointer in a JS object.
// It must never be accepted as the receiver of PluginHost methods.
#include <stddef.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef struct napi_ref__ *napi_ref;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef void (*napi_finalize)(napi_env, void *, void *);

extern napi_status napi_create_object(napi_env, napi_value *);
extern napi_status napi_wrap(napi_env, napi_value, void *, napi_finalize, void *, napi_ref *);
extern napi_status napi_create_function(napi_env, const char *, size_t,
                                        napi_callback, void *, napi_value *);
extern napi_status napi_set_named_property(napi_env, napi_value, const char *, napi_value);

// Keep the pointer live and aligned: the test checks type validation, not a
// dangling allocation or a null check.
static union {
  long double align;
  unsigned char bytes[128];
} foreign_native;

static napi_value foreign_receiver(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value object;
  if (napi_create_object(env, &object) != 0 ||
      napi_wrap(env, object, &foreign_native, NULL, NULL, NULL) != 0) {
    return NULL;
  }
  return object;
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value factory;
  if (napi_create_function(env, "foreignReceiver", 15, foreign_receiver,
                           NULL, &factory) != 0 ||
      napi_set_named_property(env, exports, "foreignReceiver", factory) != 0) {
    return NULL;
  }
  return exports;
}
