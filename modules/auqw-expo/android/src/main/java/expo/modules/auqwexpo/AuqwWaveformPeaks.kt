package expo.modules.auqwexpo

import android.media.MediaCodec
import android.media.MediaDataSource
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.coroutineContext
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.auqw_mobile_bindings.PluginHost
import uniffi.auqw_mobile_bindings.StreamException

private const val TAG = "AuqwWaveformPeaks"
private const val READ_CHUNK = 1024 * 1024
/** Decoration, not analysis — the same encoded pull cap as the desktop port. */
private const val MAX_PEAK_BYTES = 24 * 1024 * 1024
/** Post-decode belt — matches the desktop port's PCM ceiling. */
private const val MAX_PCM_BYTES = 256 * 1024 * 1024
/** Cold-start patience for the first read — the player's own head fill
 * takes a while too; peaks may wait for the same warm-up. */
private const val FIRST_READ_TIMEOUT_MS = 15_000L
/** Park threshold for subsequent reads: a read parked past this sits on
 * an unfetched hole — chasing it would queue demand that outranks the
 * player's own (demand serves min position first), stalling playback
 * for a decoration. Abort instead; the seeded pattern stays. */
private const val PARK_TIMEOUT_MS = 400L
/** Whole-decode deadline — a wedged codec never owns the sweep. */
private const val DECODE_DEADLINE_MS = 60_000L
private const val DEQUEUE_US = 10_000L

private val DEAD_HANDLE_KINDS = setOf(
  "released", "evicted", "expired", "superseded", "not-found"
)

/**
 * Waveform-peak extraction for the Stage seek — the dumb decode+bucket
 * half of the shared contract. `packages/ui-shared/src/peaks.ts` owns
 * the display normalization (`PeakWindow` → 5th–95th percentile →
 * γ1.2) on the JS side for both platforms, so this class only ever
 * returns raw per-window RMS magnitudes as flat `[up, down]` pairs.
 *
 * The pull borrows the playing stream's own positional `streamRead` —
 * never `streamOpen`/`streamClose`, which would re-anchor the pump's
 * speculative fill or detach the session under the player — so
 * extraction costs no new wire surface and never sees a signed URL.
 * Reads beyond the first must hit bytes already committed: a read
 * parked on a hole abandons like the desktop port (the Rust-side
 * demand it queued releases when the first commit covering it lands
 * or the read's own deadline lapses).
 */
internal class AuqwWaveformPeaks(
  private val registry: AuqwStreamRegistry,
) {
  private val jobs = ConcurrentHashMap<String, Job>()

  fun cancel(requestId: String) {
    jobs.remove(requestId)?.cancel()
  }

  fun cancelAll() {
    for ((_, job) in jobs) {
      job.cancel()
    }
    jobs.clear()
  }

  /**
   * Pull → decode → bucket. Returns `count` flat `[up, down]` pairs of
   * raw RMS magnitudes. Every failure is a typed [CodedException] whose
   * code is the application kind (`unavailable` for not-yet-buffered
   * bytes, `released` for a dead handle, `budget-exceeded` over caps,
   * `not-applicable` for the provisional unknown-duration cap,
   * `invalid-response` for undecodable bytes, `cancelled` on cancel).
   */
  suspend fun extract(
    requestId: String,
    handle: String,
    count: Int,
    maxBytes: Long,
    provisionalCap: Boolean,
  ): List<Double> {
    val job = coroutineContext[Job]
    if (job !== null) {
      jobs[requestId] = job
    }
    try {
      val host = registry.hostFor(handle)
        ?: throw CodedException("released", "unknown stream handle", null)
      val cap = minOf(maxBytes, MAX_PEAK_BYTES.toLong())
      val encoded = pullBytes(host, handle, cap, provisionalCap)
      val (pcm, channels) = decodePcm(encoded)
      return bucket(pcm, channels, count)
    } catch (_: CancellationException) {
      throw CodedException("cancelled", "peak extraction cancelled", null)
    } finally {
      jobs.remove(requestId)
    }
  }

  /** Sequential positional reads to EOF or the cap — the desktop
   *  port's pull loop verbatim: first read waits out the head fill,
   *  every read after must hit already-committed bytes. */
  private suspend fun pullBytes(
    host: PluginHost,
    handle: String,
    cap: Long,
    provisionalCap: Boolean,
  ): ByteArray {
    val out = ByteArrayOutputStream()
    var position = 0L
    var ended = false
    var timeoutMs = FIRST_READ_TIMEOUT_MS
    // `<=` so an exactly-`cap` stream still reaches its EOF read.
    while (out.size() <= cap) {
      coroutineContext.ensureActive()
      val readPos = position
      val chunk = try {
        withTimeoutOrNull(timeoutMs) {
          withContext(Dispatchers.IO) {
            host.streamRead(handle, readPos.toULong(), READ_CHUNK.toULong())
          }
        }
      } catch (e: StreamException) {
        throw seamError(e)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        throw CodedException("transient", e.message ?: "stream read failed", e)
      }
      timeoutMs = PARK_TIMEOUT_MS
      if (chunk === null) {
        // The read parked past its threshold — an unfetched hole, not
        // a failure worth caching hard.
        throw CodedException("unavailable", "stream bytes not yet buffered", null)
      }
      if (chunk.isEmpty()) {
        ended = true
        break
      }
      out.write(chunk, 0, chunk.size)
      position += chunk.size
    }
    if (!ended) {
      throw CodedException(
        if (provisionalCap) "not-applicable" else "budget-exceeded",
        "stream too large for peak extraction",
        null
      )
    }
    return out.toByteArray()
  }

  /** MediaExtractor + MediaCodec over the collected bytes → raw PCM16
   *  and the output channel count. */
  private suspend fun decodePcm(encoded: ByteArray): Pair<ByteArray, Int> =
    withContext(Dispatchers.IO) {
      val extractor = MediaExtractor()
      var codec: MediaCodec? = null
      try {
        extractor.setDataSource(ByteArrayMediaDataSource(encoded))
        var track = -1
        var format: MediaFormat? = null
        for (i in 0 until extractor.trackCount) {
          val f = extractor.getTrackFormat(i)
          val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
          if (mime.startsWith("audio/")) {
            track = i
            format = f
            break
          }
        }
        if (track < 0 || format === null) {
          throw CodedException("invalid-response", "no audio track", null)
        }
        extractor.selectTrack(track)
        val mime = format.getString(MediaFormat.KEY_MIME)
          ?: throw CodedException("invalid-response", "audio track has no mime", null)
        val decoder = try {
          MediaCodec.createDecoderByType(mime)
        } catch (e: Exception) {
          throw CodedException("invalid-response", "no decoder for $mime", e)
        }
        codec = decoder
        decoder.configure(format, null, null, 0)
        decoder.start()
        var channels = formatInt(format, MediaFormat.KEY_CHANNEL_COUNT) ?: 0
        val pcm = ByteArrayOutputStream()
        val info = MediaCodec.BufferInfo()
        var inputEOS = false
        var outputEOS = false
        val deadline = android.os.SystemClock.uptimeMillis() + DECODE_DEADLINE_MS
        while (!outputEOS) {
          coroutineContext.ensureActive()
          if (android.os.SystemClock.uptimeMillis() > deadline) {
            throw CodedException("unavailable", "audio decode timed out", null)
          }
          if (!inputEOS) {
            val inIdx = decoder.dequeueInputBuffer(DEQUEUE_US)
            if (inIdx >= 0) {
              val buf = decoder.getInputBuffer(inIdx)
              val n = buf?.let { extractor.readSampleData(it, 0) } ?: -1
              if (n < 0) {
                decoder.queueInputBuffer(
                  inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM
                )
                inputEOS = true
              } else {
                decoder.queueInputBuffer(inIdx, 0, n, extractor.sampleTime, 0)
                extractor.advance()
              }
            }
          }
          val outIdx = decoder.dequeueOutputBuffer(info, DEQUEUE_US)
          when {
            outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              channels = formatInt(
                decoder.outputFormat, MediaFormat.KEY_CHANNEL_COUNT
              ) ?: channels
            }
            outIdx >= 0 -> {
              if (info.size > 0) {
                if (pcm.size() + info.size > MAX_PCM_BYTES) {
                  throw CodedException(
                    "budget-exceeded",
                    "decoded audio too large for peaks",
                    null
                  )
                }
                val buf = decoder.getOutputBuffer(outIdx)
                if (buf !== null) {
                  val data = ByteArray(info.size)
                  buf.get(data)
                  pcm.write(data, 0, data.size)
                }
              }
              decoder.releaseOutputBuffer(outIdx, false)
              if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                outputEOS = true
              }
            }
          }
        }
        Pair(pcm.toByteArray(), channels)
      } catch (e: CodedException) {
        throw e
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        throw CodedException(
          "invalid-response", e.message ?: "audio decode failed", e
        )
      } finally {
        try {
          codec?.stop()
        } catch (e: Exception) {
          Log.i(TAG, "codec stop: ${e.message}")
        }
        try {
          codec?.release()
        } catch (e: Exception) {
          Log.i(TAG, "codec release: ${e.message}")
        }
        extractor.release()
      }
    }

  /** PCM16LE frames → `count` raw `[up, down]` RMS windows — the same
   *  split `peakWindowsFromChannels` applies in ui-shared: stereo+
   *  feeds even channels to `up` and odd to `down`; mono splits by
   *  sign, positive samples up and negative down. */
  private fun bucket(pcm: ByteArray, channels: Int, count: Int): List<Double> {
    val out = ArrayList<Double>(count * 2)
    if (count <= 0 || channels <= 0) {
      return out
    }
    val shorts = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    val frames = shorts.remaining() / channels
    if (frames <= 0) {
      return out
    }
    val stereo = channels >= 2
    for (w in 0 until count) {
      val from = (w.toLong() * frames / count).toInt()
      val to = minOf(
        frames,
        maxOf(((w + 1).toLong() * frames / count).toInt(), from + 1)
      )
      var upSq = 0.0
      var downSq = 0.0
      var upN = 0
      var downN = 0
      for (f in from until to) {
        val base = f * channels
        if (stereo) {
          for (ch in 0 until channels) {
            val v = shorts.get(base + ch).toDouble() / 32768.0
            if (ch % 2 == 0) {
              upSq += v * v
              upN += 1
            } else {
              downSq += v * v
              downN += 1
            }
          }
        } else {
          val v = shorts.get(base).toDouble() / 32768.0
          if (v >= 0) {
            upSq += v * v
            upN += 1
          } else {
            downSq += v * v
            downN += 1
          }
        }
      }
      out.add(if (upN > 0) sqrt(upSq / upN) else 0.0)
      out.add(if (downN > 0) sqrt(downSq / downN) else 0.0)
    }
    return out
  }

  private fun formatInt(format: MediaFormat, key: String): Int? =
    if (format.containsKey(key)) {
      try {
        format.getInteger(key)
      } catch (_: Exception) {
        null
      }
    } else {
      null
    }

  /** Seam failures → the ABI kind the JS adapter maps — the same table
   *  the desktop port's `toError` applies. */
  private fun seamError(e: StreamException): CodedException {
    val kind = when {
      e is StreamException.Failed && DEAD_HANDLE_KINDS.contains(e.kind) -> "released"
      e is StreamException.Failed &&
        (e.kind == "invalid-request" ||
          e.kind == "invalid-response" ||
          e.kind == "invalid-message") -> "invalid-response"
      e is StreamException.Failed -> "transient"
      else -> "unavailable"
    }
    return CodedException(kind, e.message, e)
  }
}

/** In-memory positional source for `MediaExtractor` over the pulled
 *  encoded bytes — the stream seam's own contract shape. */
private class ByteArrayMediaDataSource(
  private val bytes: ByteArray,
) : MediaDataSource() {
  override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
    if (position < 0 || position >= bytes.size.toLong()) {
      return -1
    }
    val n = minOf(size.toLong(), bytes.size.toLong() - position).toInt()
    if (n <= 0) {
      return -1
    }
    System.arraycopy(bytes, position.toInt(), buffer, offset, n)
    return n
  }

  override fun getSize(): Long = bytes.size.toLong()

  override fun close() {}
}
