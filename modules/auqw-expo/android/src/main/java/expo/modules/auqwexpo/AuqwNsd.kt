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
    get() = context.getSystemService(Context.NSD_SERVICE) as NsdManager

  // Read on NSD's binder thread, written by JS callers — @Volatile so
  // a stale listener's failure check sees the current owner.
  @Volatile
  private var registration: NsdManager.RegistrationListener? = null
  @Volatile
  private var discovery: NsdManager.DiscoveryListener? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var resolveExecutor: ExecutorService? = null

  // Bump per browse run — NSD resolve callbacks can land after a stop,
  // and a stale 'found' must not populate a later session's list.
  @Volatile
  private var browseGeneration = 0

  /** Advertise `_auqw._tcp` on the listener's bound port. Re-advertise
   * replaces the previous registration silently. */
  fun advertise(name: String, port: Int, fp: String) {
    unadvertise()
    val info = NsdServiceInfo().apply {
      serviceName = name
      serviceType = "_auqw._tcp."
      this.port = port
      setAttribute("dev", fp)
    }
    val listener =
      object : NsdManager.RegistrationListener {
        override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) {
          Log.w(TAG, "nsd registration failed: $code")
          // Async failure after registerService already returned 'ok' —
          // the advert never went live, so surface it as an event
          // (the JS advertise seam forwards it to onError). A stale
          // listener's failure must not clear a newer registration.
          if (registration !== this) return
          registration = null
          emitDiscovery(
            mapOf("type" to "advertise-failed", "name" to info.serviceName),
          )
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
   * `{type:'found', name, host, hosts, port, fp}`; teardown emits
   * `{type:'lost', name, port, fp}` where port/fp come from the lost
   * record's last-resolved generation when known. Resolutions run on
   * a single executor so a slow lookup can't wedge the NsdManager
   * callback thread.
   */
  fun browse() {
    stopBrowse()
    multicastLock =
      (context.applicationContext.getSystemService(Context.WIFI_SERVICE)
        as? WifiManager)
        ?.createMulticastLock("auqw-sync")
        ?.apply { setReferenceCounted(true) }
    try {
      multicastLock?.acquire()
    } catch (e: Exception) {
      // A lock we couldn't take is a browse that would see nothing —
      // fail typed instead of leaking a held lock field.
      multicastLock = null
      Log.w(TAG, "syncBrowse multicast acquire failed", e)
      throw CodedException("unavailable", "syncBrowse failed", e)
    }
    val executor = Executors.newSingleThreadExecutor()
    resolveExecutor = executor
    val gen = ++browseGeneration
    val listener =
      object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}

        override fun onServiceFound(info: NsdServiceInfo) {
          // NSD callbacks run serialized on this binder thread —
          // marking + queueing must happen HERE, not inside a deferred
          // executor task, or a same-name onServiceLost could land
          // first and have its mark cleared by this stale 'found',
          // resurrecting a dead service.
          if (gen != browseGeneration) return
          synchronized(resolveLock) {
            // A re-advertise clears the lost mark before queueing.
            lostNames.remove(info.serviceName)
            resolveQueue.addLast(info to 0)
          }
          // ...then drain on the executor — never submit resolveService
          // itself to a shut-down executor (its rejection would crash
          // this callback thread).
          runCatching { executor.execute { drainResolves(gen) } }
        }

        override fun onServiceLost(info: NsdServiceInfo) {
          if (gen != browseGeneration) return
          // Attach the lost record's last-resolved generation — the
          // JS adapter retracts just that generation instead of
          // wiping every row sharing the (non-unique) service name.
          val last = synchronized(resolveLock) {
            lostNames.add(info.serviceName)
            resolveQueue.removeAll { it.first.serviceName == info.serviceName }
            lastResolved.remove(info.serviceName)
          }
          emitDiscovery(
            mapOf(
              "type" to "lost",
              "name" to info.serviceName,
              "port" to last?.first,
              "fp" to last?.second,
            ),
          )
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
      // discovery=null first so stopBrowse skips the never-registered
      // listener — the rest of its teardown covers lock + executor.
      discovery = null
      stopBrowse()
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
      lostNames.clear()
      lastResolved.clear()
    }
    // No early return: a start that failed after taking the lock but
    // before registering `discovery` still owes the release.
    val listener = discovery
    discovery = null
    listener?.let { runCatching { manager.stopServiceDiscovery(it) } }
    resolveExecutor?.shutdown()
    resolveExecutor = null
    multicastLock?.let { runCatching { it.release() } }
    multicastLock = null
  }

  // Some Android builds reject a second resolveService while one is
  // outstanding — serialize them through a queue instead of trusting
  // the executor's submission order. Transient failures get one retry
  // while their browse generation is still live. Enqueue happens on
  // the NSD callback thread (so lost-mark ordering follows callback
  // order) while resolve/drain run on the executor — the queue is
  // guarded by `resolveLock`.
  private val resolveQueue = ArrayDeque<Pair<NsdServiceInfo, Int>>()
  private var resolveInFlight = false
  private val resolveLock = Any()
  // Services that went down while resolution was pending — a queued or
  // in-flight resolve must not emit a zombie 'found' afterwards. A
  // fresh onServiceFound for the name clears the mark.
  private val lostNames = mutableSetOf<String>()
  // Last-resolved (port, fp) per service name — populated on each
  // emitted 'found', consumed by onServiceLost. Guarded by
  // `resolveLock` like the queue/lost marks above.
  private val lastResolved = mutableMapOf<String, Pair<Int, String?>>()

  private fun drainResolves(gen: Int) {
    val next =
      synchronized(resolveLock) {
        if (resolveInFlight) {
          return
        }
        var dequeued = resolveQueue.removeFirstOrNull()
        while (dequeued != null && lostNames.contains(dequeued.first.serviceName)) {
          dequeued = resolveQueue.removeFirstOrNull()
        }
        dequeued ?: return
        resolveInFlight = true
        dequeued
      }
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
          val lost =
            synchronized(resolveLock) {
              resolveInFlight = false
              // Lost after the resolve was issued — the 'lost' event
              // already went out; a 'found' now would resurrect it.
              lostNames.contains(resolved.serviceName)
            }
          if (gen == browseGeneration && !lost) {
            // Emit every resolved address — the JS discovery adapter
            // owns LAN-policy filtering and dialability ranking (a
            // public v4 or a bare fe80:: literal must not shadow a
            // pairable address behind it).
            val addresses =
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                resolved.hostAddresses
              } else {
                @Suppress("DEPRECATION")
                listOfNotNull(resolved.host)
              }
            val hosts = addresses.mapNotNull { it.hostAddress }
            val host = hosts.firstOrNull()
            val fp = resolved.attributes["dev"]?.let { String(it) }
            if (hosts.isNotEmpty()) {
              synchronized(resolveLock) {
                lastResolved[resolved.serviceName] = resolved.port to fp
              }
              emitDiscovery(
                mapOf(
                  "type" to "found",
                  "name" to resolved.serviceName,
                  "host" to host,
                  "hosts" to hosts,
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
