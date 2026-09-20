package expo.modules.auqwexpo

import java.util.concurrent.ConcurrentHashMap
import uniffi.auqw_mobile_bindings.PluginHost

/**
 * Maps a stream handle to the [PluginHost] that minted it. The Media3
 * DataSource is created by ExoPlayer's loader thread with only the
 * `auqw-stream://<handle>` URI in hand, so the owning host is resolved
 * here rather than captured at attach time.
 *
 * Entries live from the `prepared` outcome until `streamRelease`: a
 * DataSource `close()` only ends one open, never the handle itself.
 */
class AuqwStreamRegistry {
  private val hosts = ConcurrentHashMap<String, PluginHost>()

  fun register(handle: String, host: PluginHost) {
    hosts[handle] = host
  }

  fun unregister(handle: String) {
    hosts.remove(handle)
  }

  fun hostFor(handle: String): PluginHost? = hosts[handle]

  /** Drop every routing entry — a replaced host can never serve them. */
  fun clear() {
    hosts.clear()
  }
}
