package expo.modules.auqwexpo

import java.util.concurrent.ConcurrentHashMap
import uniffi.auqw_mobile_bindings.PluginHost
import uniffi.auqw_mobile_bindings.StreamException

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
    // Sessions ended without a supersede signal — TTL eviction, expiry —
    // leave their routing entry behind forever. Sweep entries for
    // handles the owning host no longer knows so the map only ever
    // names a session the seam could still serve.
    hosts.entries.removeIf { (h, owner) -> h != handle && !owner.knowsStream(h) }
  }

  fun unregister(handle: String) {
    hosts.remove(handle)
  }

  fun hostFor(handle: String): PluginHost? = hosts[handle]

  /** Drop every routing entry — a replaced host can never serve them. */
  fun clear() {
    hosts.clear()
  }

  /**
   * Whether `host` still has `handle` in its session map. `not-found`
   * is the seam reporting the session gone for good; any other failure
   * (or success, including terminal-but-known sessions a re-open must
   * still see its typed error for) keeps the entry.
   */
  private fun PluginHost.knowsStream(handle: String): Boolean =
    try {
      streamPhaseMarks(handle)
      true
    } catch (e: StreamException) {
      streamKind(e) != "not-found"
    } catch (_: Exception) {
      // Anything else is a transient host hiccup, not a dead handle —
      // keep the entry rather than orphan a live session's routing.
      true
    }
}
