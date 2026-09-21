package expo.modules.auqwexpo

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * ConnectivityManager NetworkCallback → {online, metered} edges for
 * the download scheduler's ConnectivityPort.
 *
 * online: the active network declares INTERNET and VALIDATED — a
 * captive-portal or backend-down network reports offline honestly
 * instead of letting transfers churn at Layer 3. `validatedNetwork`
 * remembers a VALIDATED edge bound to its network handle so a switch
 * (wifi → cell) never inherits the old network's validation.
 *
 * metered: active network lacks NET_CAPABILITY_NOT_METERED (cellular,
 * data-saver). When offline, metered reports false — it is best-
 * effort and callers must not infer policy from it.
 *
 * Registered lazily on first JS observer; unregistered when the last
 * one leaves, so a cold app start pays no callback cost.
 */
class AuqwConnectivityMonitor(
  context: Context,
  private val emit: (online: Boolean, metered: Boolean) -> Unit,
) {
  private val cm =
    context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  /** The network that most recently reported VALIDATED, or null. */
  @Volatile
  private var validatedNetwork: Network? = null

  @Volatile
  private var registered = false

  @Volatile
  private var lastOnline = false

  @Volatile
  private var lastMetered = false

  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
      if (network == cm.activeNetwork) {
        validatedNetwork =
          if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
            network
          } else if (validatedNetwork == network) {
            null
          } else {
            validatedNetwork
          }
      }
      publish()
    }

    override fun onLost(network: Network) {
      if (validatedNetwork == network) {
        validatedNetwork = null
      }
      publish()
    }

    override fun onAvailable(network: Network) {
      publish()
    }

    override fun onUnavailable() {
      publish()
    }
  }

  /** The freshest known state — a local read, never a probe. */
  fun snapshot(): Pair<Boolean, Boolean> {
    val network = cm.activeNetwork ?: return Pair(false, false)
    val caps = cm.getNetworkCapabilities(network) ?: return Pair(false, false)
    if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
      return Pair(false, false)
    }
    val online =
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ||
        validatedNetwork == network
    val metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    return Pair(online, metered)
  }

  fun start() {
    if (registered) {
      return
    }
    registered = true
    // Emit the current edge immediately — first observers get a
    // baseline, not silence until the next network change.
    val (online, metered) = snapshot()
    lastOnline = online
    lastMetered = metered
    emit(online, metered)
    cm.registerNetworkCallback(
      NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .build(),
      callback,
    )
  }

  fun stop() {
    if (!registered) {
      return
    }
    registered = false
    try {
      cm.unregisterNetworkCallback(callback)
    } catch (_: IllegalArgumentException) {
      // Already unregistered — idempotent stop.
    }
  }

  private fun publish() {
    val (online, metered) = snapshot()
    if (online == lastOnline && metered == lastMetered) {
      return // change edges only — no per-network flapping
    }
    lastOnline = online
    lastMetered = metered
    emit(online, metered)
  }
}
