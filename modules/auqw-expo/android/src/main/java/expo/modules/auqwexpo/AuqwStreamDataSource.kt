package expo.modules.auqwexpo

import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.IOException
import uniffi.auqw_mobile_bindings.PluginHost
import uniffi.auqw_mobile_bindings.StreamException

private const val TAG = "AuqwStreamDataSource"
private const val STREAM_SCHEME = "auqw-stream"

/**
 * IOException carrying the seam's typed kind so ExoPlayer's error path
 * (PlaybackException cause chain) preserves it — the module maps it
 * back into the ABI taxonomy for onPlaybackStatus.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AuqwStreamException(
  val kind: String,
  detail: String?,
  cause: Throwable? = null,
) : IOException(detail ?: kind, cause)

/**
 * Maps a UniFFI [StreamException] to its ABI kind string — the
 * generated error is a sealed class: `Failed` carries the seam's kind
 * verbatim; `Unavailable` is the seam-not-configured path.
 */
internal fun streamKind(e: StreamException): String = when (e) {
  is StreamException.Failed -> e.kind
  is StreamException.Unavailable -> "unavailable"
}

/**
 * Media3 [DataSource] bridging the UniFFI stream seam:
 *
 * - `open(spec)` → `stream_open(handle, spec.position)` — returns the
 *   remaining length, or [C.LENGTH_UNSET] when the seam doesn't know it.
 * - `read(buf,off,len)` → `stream_read(handle, position, len)` — a
 *   blocking foreign-thread read (that IS the contract: the player's
 *   own loader thread parks on the seam's condvar until bytes, EOF as
 *   an empty array, or a terminal transition as [StreamException]).
 * - `close()` → `stream_close(handle)`; a released/cancelled stream
 *   failing close is expected teardown noise, logged not thrown.
 *
 * URIs are `auqw-stream://<handle>`; the registry resolves the handle
 * to its host. The signed URL never crosses this class — it never
 * sees one.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AuqwStreamDataSource(
  private val registry: AuqwStreamRegistry,
) : BaseDataSource(/* isNetwork= */ false) {

  class Factory(
    private val registry: AuqwStreamRegistry,
  ) : DataSource.Factory {
    override fun createDataSource(): DataSource = AuqwStreamDataSource(registry)
  }

  private var opened = false
  private var uri: Uri? = null
  private var host: PluginHost? = null
  private var handle: String? = null
  private var position: Long = 0
  private var bytesRemaining: Long = C.LENGTH_UNSET.toLong()

  override fun open(dataSpec: DataSpec): Long {
    if (opened) {
      throw AuqwStreamException("internal", "data source already open", null)
    }
    // authority, not host: Uri.getHost() lowercases and stream handles
    // are case-sensitive.
    val streamHandle = dataSpec.uri.takeIf { it.scheme == STREAM_SCHEME }?.authority
      ?.takeUnless { it.isBlank() }
      ?: throw AuqwStreamException("internal", "stream uri missing handle", null)
    if (dataSpec.position < 0) {
      throw AuqwStreamException("internal", "negative position ${dataSpec.position}", null)
    }
    if (dataSpec.length < C.LENGTH_UNSET.toLong()) {
      throw AuqwStreamException("internal", "invalid length ${dataSpec.length}", null)
    }
    val streamHost = registry.hostFor(streamHandle)
      ?: throw AuqwStreamException("internal", "unknown stream handle", null)

    transferInitializing(dataSpec)
    host = streamHost
    handle = streamHandle
    uri = dataSpec.uri
    position = dataSpec.position

    val remaining = try {
      streamHost.streamOpen(streamHandle, dataSpec.position.toULong())
    } catch (e: Exception) {
      // The transferInitializing above always wants its transferEnded
      // — close() skips it here because `opened` was never set.
      transferEnded()
      if (e is StreamException) {
        // `not-found` means the session is gone from the Rust map —
        // the routing entry is dead weight; drop it so the registry
        // only ever names live-or-terminal handles. Terminal kinds
        // keep their entry: a re-open must still raise the typed error.
        if (streamKind(e) == "not-found") {
          registry.unregister(streamHandle)
        }
        throw AuqwStreamException(streamKind(e), e.message, e)
      }
      throw e
    }
    opened = true
    transferStarted(dataSpec)

    // Contract: a bounded request echoes its length; an unbounded one
    // resolves to remaining length or stays LENGTH_UNSET.
    bytesRemaining = when {
      dataSpec.length != C.LENGTH_UNSET.toLong() -> dataSpec.length
      remaining != null -> remaining.toLong()
      else -> C.LENGTH_UNSET.toLong()
    }
    return bytesRemaining
  }

  override fun read(buffer: ByteArray, offset: Int, readLength: Int): Int {
    if (readLength == 0) {
      return 0
    }
    if (bytesRemaining == 0L) {
      return C.RESULT_END_OF_INPUT
    }
    val currentHost = host
    val currentHandle = handle
    if (!opened || currentHost == null || currentHandle == null) {
      throw AuqwStreamException("internal", "read on a closed stream", null)
    }
    if (offset < 0 || offset + readLength > buffer.size) {
      throw AuqwStreamException(
        "internal",
        "read bounds off=$offset len=$readLength buf=${buffer.size}",
        null
      )
    }
    val wanted = if (bytesRemaining == C.LENGTH_UNSET.toLong()) {
      readLength.toLong()
    } else {
      minOf(readLength.toLong(), bytesRemaining)
    }
    val bytes = try {
      currentHost.streamRead(currentHandle, position.toULong(), wanted.toULong())
    } catch (e: StreamException) {
      throw AuqwStreamException(streamKind(e), e.message, e)
    }
    if (bytes.isEmpty()) {
      bytesRemaining = 0
      return C.RESULT_END_OF_INPUT
    }
    if (bytes.size.toLong() > wanted || bytes.size > buffer.size - offset) {
      throw AuqwStreamException(
        "invalid-response",
        "seam over-served ${bytes.size} bytes at $position",
        null
      )
    }
    System.arraycopy(bytes, 0, buffer, offset, bytes.size)
    position += bytes.size
    if (bytesRemaining != C.LENGTH_UNSET.toLong()) {
      bytesRemaining -= bytes.size
    }
    bytesTransferred(bytes.size)
    return bytes.size
  }

  override fun getUri(): Uri? = uri

  override fun close() {
    val currentHost = host
    val currentHandle = handle
    host = null
    handle = null
    uri = null
    position = 0
    bytesRemaining = C.LENGTH_UNSET.toLong()
    if (opened && currentHost != null && currentHandle != null) {
      try {
        currentHost.streamClose(currentHandle)
      } catch (e: Exception) {
        val kind = if (e is StreamException) streamKind(e) else "internal"
        Log.i(TAG, "streamClose: $kind (already terminal)")
      }
      transferEnded()
    }
    opened = false
  }
}
