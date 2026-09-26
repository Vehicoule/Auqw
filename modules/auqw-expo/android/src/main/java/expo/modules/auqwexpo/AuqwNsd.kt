package expo.modules.auqwexpo

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * LAN discovery for symmetric pairing (docs/specs/sync.md): advertise
 * this device's pairing listener as `_auqw._tcp` and browse for peers
 * doing the same, so "accept" is tap-the-nearby-device instead of a
 * typed host:port.
 *
 * TXT `dev` carries the device identity fp so the browse list can show
 * (and pin) the same key the handshake later proves; `name` is the
 * human label. Discovery is best-effort by design — pairing never
 * depends on it (the QR/code path carries the endpoint), so failures
 * surface to JS as typed errors, never as fake entries.
 *
 * The MulticastLock is held only while a browse runs — the OS drops
 * multicast packets to unregistered apps on many devices.
 */
class AuqwNsd(
  private val context: Context,
  private val emitDiscovery: (event: Map<String, Any?>) -> Unit,
) {
  private val manager: NsdManager
    get() =
      context.getSystemService(Context.NSD_SERVICE) as NsdManager

  private var registration: NsdManager.RegistrationListener? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var resolveExecutor: ExecutorService? = null

  /** Advertise `_auqw._tcp` on the listener's bound port. Re-advertise
   * replaces the previous registration silently. */
  fun advertise(name: String, port: Int, fp: String) {
    unadvertise()
    val info =
      NsdServiceInfo().apply {
        serviceName = name
        serviceType = "_auqw._tcp."
        this.port = port
        setAttribute("dev", fp)
      }
    val listener =
      object : NsdManager.RegistrationListener {
        override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) {
          Log.w(TAG, "nsd registration failed: $code")
        }

        override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) {}

        override fun onServiceRegistered(info: NsdServiceInfo) {}

        override fun onServiceUnregistered(info: NsdServiceInfo) {}
      }
    registration = listener
    try {
      manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (e: Exception) {
      registration = null
      throw CodedException("unavailable", "syncAdvertise failed: ${e.message}", e)
    }
  }

  fun unadvertise() {
    val listener = registration ?: return
    registration = null
    runCatching { manager.unregisterService(listener) }
  }

  /**
   * Browse `_auqw._tcp` — each resolved service emits
   * `{type:'found', name, host, port, fp}`; teardown emits
   * `{type:'lost', name}`. Resolutions run on a single executor so a
   * slow lookup can't wedge the NsdManager callback thread.
   */
  fun browse() {
    stopBrowse()
    val wifi =
      context.applicationContext.getSystemService(Context.WIFI_SERVICE)
        as? WifiManager
    multicastLock =
      wifi?.createMulticastLock("auqw-sync")?.apply {
        setReferenceCounted(true)
        acquire()
      }
    val executor = Executors.newSingleThreadExecutor()
    resolveExecutor = executor
    val listener =
      object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}

        override fun onServiceFound(info: NsdServiceInfo) {
          executor.execute { resolve(info) }
        }

        override fun onServiceLost(info: NsdServiceInfo) {
          emitDiscovery(mapOf("type" to "lost", "name" to info.serviceName))
        }

        override fun onDiscoveryStopped(serviceType: String) {}

        override fun onStartDiscoveryFailed(serviceType: String, code: Int) {
          Log.w(TAG, "nsd discovery failed: $code")
        }

        override fun onStopDiscoveryFailed(serviceType: String, code: Int) {}
      }
    discovery = listener
    try {
      manager.discoverServices("_auqw._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (e: Exception) {
      discovery = null
      releaseLock(executor)
      throw CodedException("unavailable", "syncBrowse failed: ${e.message}", e)
    }
  }

  fun stopBrowse() {
    val listener = discovery ?: return
    discovery = null
    runCatching { manager.stopServiceDiscovery(listener) }
    resolveExecutor?.shutdown()
    resolveExecutor = null
    multicastLock?.let { lock ->
      runCatching { lock.release() }
    }
    multicastLock = null
  }

  private fun releaseLock(executor: ExecutorService) {
    executor.shutdown()
    multicastLock?.let { runCatching { it.release() } }
    multicastLock = null
  }

  private fun resolve(info: NsdServiceInfo) {
    val resolveListener =
      object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, code: Int) {
          Log.w(TAG, "nsd resolve failed for ${info.serviceName}: $code")
        }

        override fun onServiceResolved(resolved: NsdServiceInfo) {
          val host =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
              resolved.hostAddresses.firstOrNull()?.hostAddress
            } else {
              @Suppress("DEPRECATION")
              resolved.host?.hostAddress
            }
          val fp = resolved.attributes["dev"]?.let { String(it) }
          if (host != null) {
            emitDiscovery(
              mapOf(
                "type" to "found",
                "name" to resolved.serviceName,
                "host" to host,
                "port" to resolved.port,
                "fp" to fp,
              ),
            )
          }
        }
      }
    runCatching { manager.resolveService(info, resolveListener) }
  }

  fun shutdown() {
    unadvertise()
    stopBrowse()
  }

  private companion object {
    const val TAG = "AuqwNsd"
  }
}
