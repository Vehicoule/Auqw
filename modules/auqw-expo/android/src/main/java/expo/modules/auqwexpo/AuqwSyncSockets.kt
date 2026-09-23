package expo.modules.auqwexpo

import android.util.Base64
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The phone side of the LAN-sync transport (docs/specs/sync.md): a
 * registry of plain TCP sockets keyed by a JS-minted socketId. Each
 * connected socket owns a reader thread that pushes received frames
 * upstream as base64 `onSyncSocketData` events and reports teardown
 * once via `onSyncSocketClosed` — reason 'peer' (remote EOF),
 * 'error' (socket fault), or 'local' (destroyed from JS).
 *
 * The bridge is JSON, so frames cross as base64; the JS pump
 * (packages/application sync-wire) owns the u32le length-prefix
 * framing — this layer moves opaque bytes only. `syncRandomBytes`
 * backs the JS crypto suite's CSPRNG with SecureRandom (RN has no
 * crypto.getRandomValues).
 */
class AuqwSyncSockets(
  private val emitData: (socketId: String, dataB64: String) -> Unit,
  private val emitClosed: (socketId: String, reason: String) -> Unit,
) {
  private class Entry(
    val socket: Socket,
    @Volatile var reader: Thread? = null,
    /** Once-per-socket terminal event guard. */
    val closedEmitted: AtomicBoolean = AtomicBoolean(false),
  )

  private val entries = ConcurrentHashMap<String, Entry>()
  private val secureRandom = SecureRandom()

  /**
   * Blocking connect on the caller's coroutine — Expo AsyncFunction
   * dispatches off the JS thread. Returns the peer's address string.
   */
  fun connect(socketId: String, host: String, port: Int, timeoutMs: Int): String? {
    val socket = Socket()
    val entry = Entry(socket)
    entries[socketId] = entry
    try {
      socket.connect(InetSocketAddress(host, port), timeoutMs)
      socket.tcpNoDelay = true
      socket.keepAlive = true
    } catch (e: Exception) {
      entries.remove(socketId)
      runCatching { socket.close() }
      throw CodedException("unavailable", "syncConnect failed: ${e.message}", e)
    }
    val reader =
      Thread({ readLoop(socketId, entry) }, "auqw-sync-$socketId").apply {
        isDaemon = true
        start()
      }
    entry.reader = reader
    return socket.inetAddress?.hostAddress
  }

  /** One write — serialized per socket, so frames never interleave. */
  fun send(socketId: String, dataB64: String) {
    val entry = entries[socketId]
      ?: throw CodedException("unavailable", "syncSend: no socket $socketId", null)
    val bytes =
      try {
        Base64.decode(dataB64, Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        throw CodedException("invalid-message", "syncSend: bad base64", e)
      }
    synchronized(entry.socket) {
      try {
        entry.socket.getOutputStream().write(bytes)
        entry.socket.getOutputStream().flush()
      } catch (e: Exception) {
        reportClosed(socketId, entry, "error")
        throw CodedException("unavailable", "syncSend failed: ${e.message}", e)
      }
    }
  }

  /** Graceful half-close: queued writes flush, then FIN — the peer
   * sees EOF; our reader keeps running until the peer answers. */
  fun close(socketId: String) {
    val entry = entries[socketId] ?: return
    synchronized(entry.socket) {
      runCatching { entry.socket.shutdownOutput() }
    }
  }

  /** Immediate teardown — pending writes may drop. */
  fun destroy(socketId: String) {
    val entry = entries.remove(socketId) ?: return
    runCatching { entry.socket.close() }
    // If the reader already wedged, close() unblocks it; the terminal
    // event still emits exactly once.
    reportClosed(socketId, entry, "local")
  }

  fun randomBytes(length: Int): String {
    if (length <= 0 || length > 1 shl 20) {
      throw CodedException("invalid-message", "syncRandomBytes: bad length", null)
    }
    val bytes = ByteArray(length)
    secureRandom.nextBytes(bytes)
    return Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  fun destroyAll() {
    for (id in entries.keys.toList()) {
      destroy(id)
    }
  }

  private fun readLoop(socketId: String, entry: Entry) {
    val buffer = ByteArray(64 * 1024)
    try {
      val input = entry.socket.getInputStream()
      while (true) {
        val n = input.read(buffer)
        if (n < 0) {
          reportClosed(socketId, entry, "peer")
          return
        }
        if (n > 0) {
          emitData(socketId, Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP))
        }
      }
    } catch (e: Exception) {
      // A local destroy surfaces the pending read as a SocketException
      // — the socket being gone from the registry is the signal.
      val reason = if (entries.containsKey(socketId)) "error" else "local"
      if (reason == "error") {
        Log.w(TAG, "sync socket $socketId read failed: ${e.message}")
      }
      reportClosed(socketId, entry, reason)
    }
  }

  private fun reportClosed(socketId: String, entry: Entry, reason: String) {
    if (entry.closedEmitted.compareAndSet(false, true)) {
      entries.remove(socketId)
      runCatching { entry.socket.close() }
      emitClosed(socketId, reason)
    }
  }

  private companion object {
    const val TAG = "AuqwSyncSockets"
  }
}
