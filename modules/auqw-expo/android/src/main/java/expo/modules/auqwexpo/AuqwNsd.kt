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
  // Bump per browse run — NSD resolve callbacks can land after a stop,
  // and a stale 'found' must not populate a later session's list.
  private var browseGeneration = 0

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
      Log.w(TAG, "syncAdvertise failed", e)
      throw CodedException("unavailable", "syncAdvertise failed", e)
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
    val gen = ++browseGeneration
    val listener =
      object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}

        override fun onServiceFound(info: NsdServiceInfo) {
          executor.execute { resolve(info, gen) }
        }

        override fun onServiceLost(info: NsdServiceInfo) {
          if (gen == browseGeneration) {
            emitDiscovery(mapOf("type" to "lost", "name" to info.serviceName))
          }
        }

        override fun onDiscoveryStopped(serviceType: String) {}

        override fun onStartDiscoveryFailed(serviceType: String, code: Int) {
          // A stale listener's failure must not tear down the current
          // browse — only act when this listener still owns the
          // generation.
          if (gen != browseGeneration || discovery !== this) {
            return
          }
          Log.w(TAG, "nsd discovery failed: $code")
          // NSD reports async — 'discoverServices' already returned, so
          // the JS browse() resolved 'ok'. Tear down lock + executor
          // ourselves and tell JS the session is dead ('stopped' clears
          // the nearby list) instead of holding multicast until the
          // user leaves the screen.
          stopBrowse()
          emitDiscovery(mapOf("type" to "stopped"))
        }

        override fun onStopDiscoveryFailed(serviceType: String, code: Int) {}
      }
    discovery = listener
    try {
      manager.discoverServices("_auqw._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (e: Exception) {
      discovery = null
      releaseLock(executor)
      // Raw native messages can carry device/network details — the
      // cause stays in logcat, the JS-facing message stays generic.
      Log.w(TAG, "syncBrowse failed", e)
      throw CodedException("unavailable", "syncBrowse failed", e)
    }
  }

  fun stopBrowse() {
    browseGeneration += 1
    synchronized(resolveLock) {
      resolveQueue.clear()
      resolveInFlight = false
    }
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

  // Some Android builds reject a second resolveService while one is
  // outstanding — serialize them through a queue instead of trusting
  // the executor's submission order. Transient failures get one retry
  // while their browse generation is still live. Resolve callbacks
  // fire on NSD's binder thread while enqueue happens on the
  // executor — the queue is guarded by `resolveLock`.
  private val resolveQueue = ArrayDeque<Pair<NsdServiceInfo, Int>>()
  private var resolveInFlight = false
  private val resolveLock = Any()

  private fun resolve(info: NsdServiceInfo, gen: Int) {
    if (gen != browseGeneration) return
    synchronized(resolveLock) {
      resolveQueue.addLast(info to 0)
    }
    drainResolves(gen)
  }

  private fun drainResolves(gen: Int) {
    val next =
      synchronized(resolveLock) {
        if (resolveInFlight) {
          return
        }
        val dequeued = resolveQueue.removeFirstOrNull() ?: return
        resolveInFlight = true
        dequeued
      }
    if (resolveInFlight) return
    val next = resolveQueue.removeFirstOrNull() ?: return
    resolveInFlight = true
    val (info, attempts) = next
    val resolveListener =
      object : NsdManager.ResolveListener {
        override fun onResolveFailed(failed: NsdServiceInfo, code: Int) {
          Log.w(TAG, "nsd resolve failed for ${failed.serviceName}: $code")
          synchronized(resolveLock) {
            resolveInFlight = false
            // One retry for transient failures — then the service is
            // simply absent until its next advert cycle.
            if (attempts < 1 && gen == browseGeneration) {
              resolveQueue.addLast(failed to attempts + 1)
            }
          }
          drainResolves(gen)
        }

        override fun onServiceResolved(resolved: NsdServiceInfo) {
          synchronized(resolveLock) {
            resolveInFlight = false
          }
          if (gen == browseGeneration) {
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
          drainResolves(gen)
        }
      }
    runCatching { manager.resolveService(info, resolveListener) }
      .onFailure {
        // A synchronous reject (service already stopping) still frees
        // the queue slot.
        synchronized(resolveLock) {
          resolveInFlight = false
        }
        drainResolves(gen)
      }
  }

  fun shutdown() {
    unadvertise()
    stopBrowse()
  }

  private companion object {
    const val TAG = "AuqwNsd"
  }
}
