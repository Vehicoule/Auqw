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
 * Maps a UniFFI [StreamException] to its ABI kind string. The generated
 * error is a sealed class whose variant names are the taxonomy in
 * PascalCase (RateLimit → rate-limit); a flat generated error carrying
 * a `kind` accessor is honoured first so either codegen shape works.
 */
internal fun streamKind(e: StreamException): String {
  try {
    val accessor = e.javaClass.methods.firstOrNull {
      it.name == "getKind" && it.parameterCount == 0 && it.returnType == String::class.java
    }
    val viaAccessor = accessor?.invoke(e) as? String
    if (viaAccessor != null) {
      return viaAccessor
    }
  } catch (ignored: ReflectiveOperationException) {
    // Fall through to the variant-name mapping.
  }
  val name = e.javaClass.simpleName
  return if (name.isBlank() || name == "StreamException") {
    "internal"
  } else {
    name.replace(Regex("([a-z0-9])([A-Z])"), "$1-$2").lowercase()
  }
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
    // authority, not host: Uri.getHost() lowercases and stream handles
    // are case-sensitive.
    val streamHandle = dataSpec.uri.takeIf { it.scheme == STREAM_SCHEME }?.authority
      ?: throw AuqwStreamException("internal", "stream uri missing handle", null)
    val streamHost = registry.hostFor(streamHandle)
      ?: throw AuqwStreamException("internal", "unknown stream handle", null)

    transferInitializing(dataSpec)
    host = streamHost
    handle = streamHandle
    uri = dataSpec.uri
    position = dataSpec.position

    val remaining = try {
      streamHost.streamOpen(streamHandle, dataSpec.position.toULong())
    } catch (e: StreamException) {
      throw AuqwStreamException(streamKind(e), e.message, e)
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
    if (currentHost == null || currentHandle == null) {
      throw AuqwStreamException("internal", "read on a closed stream", null)
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
      } catch (e: StreamException) {
        Log.i(TAG, "streamClose: ${streamKind(e)} (already terminal)")
      }
      transferEnded()
    }
    opened = false
  }
}
