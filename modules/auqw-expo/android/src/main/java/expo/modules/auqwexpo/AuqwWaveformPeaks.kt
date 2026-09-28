package expo.modules.auqwexpo

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaDataSource
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.coroutineContext
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import uniffi.auqw_mobile_bindings.PluginHost
import uniffi.auqw_mobile_bindings.StreamException

private const val TAG = "AuqwWaveformPeaks"
private const val READ_CHUNK = 1024 * 1024
/** Decoration, not analysis — the same encoded pull cap as the desktop port. */
private const val MAX_PEAK_BYTES = 24 * 1024 * 1024
/** Post-decode belt — matches the desktop port's PCM ceiling. */
private const val MAX_PCM_BYTES = 256 * 1024 * 1024
/** Cold-start patience while position 0 stays uncommitted — the player's
 * own head fill takes a while too; peaks may wait for the same warm-up. */
private const val FIRST_READ_TIMEOUT_MS = 15_000L
/** Patience for each later position: a hole still unfetched past this
 * sits ahead of committed bytes — a demanding read there would queue
 * fetch-through demand that outranks the player's own (demand serves
 * min position first), stalling playback for a decoration. Abort
 * instead; the seeded pattern stays. */
private const val PARK_TIMEOUT_MS = 400L
/** Poll gap between peeks on an unfetched hole — a peek queues no
 * demand, so the poll is a store-level probe, not a retry. */
private const val PEEK_POLL_MS = 50L
/** Whole-decode deadline — a wedged codec never owns the sweep. */
private const val DECODE_DEADLINE_MS = 60_000L
private const val DEQUEUE_US = 10_000L

private val DEAD_HANDLE_KINDS = setOf(
  "released", "evicted", "expired", "superseded", "not-found"
)

/** A provider:'local' backing for an lf-* handle — the file or content
 *  URI, the Context the extractor needs to open it, and the resolved
 *  encoded length (-1 when the resolver can't size it — the decode
 *  loop then enforces the cap by counting consumed bytes). */
internal class LocalSource(
  val uri: Uri,
  val context: Context,
  val bytes: Long,
)

/** The decoded PCM's negotiated shape; the samples themselves live in
 *  the caller's spill file, never on the heap. */
private class DecodedPcm(
  val bytes: Long,
  val channels: Int,
  val floatPcm: Boolean,
)

/**
 * Waveform-peak extraction for the Stage seek — the dumb decode+bucket
 * half of the shared contract. `packages/ui-shared/src/peaks.ts` owns
 * the display normalization (`PeakWindow` → 5th–95th percentile →
 * γ1.2) on the JS side for both platforms, so this class only ever
 * returns raw per-window RMS magnitudes as flat `[up, down]` pairs.
 *
 * The pull borrows the playing stream's own positional `streamPeek` —
 * never `streamOpen`/`streamClose`, which would re-anchor the pump's
 * speculative fill or detach the session under the player — so
 * extraction costs no new wire surface and never sees a signed URL.
 * A peek serves only already-committed bytes: it queues no
 * fetch-through demand and never parks, so a timed-out or cancelled
 * sweep leaves nothing competing with the player's reads (decisions.md
 * row on `stream:read` cancellation — the per-read cancel is a peek
 * instead). `provider:'local'` (lf-*) handles never reach the seam —
 * they resolve to their file/content URI and decode straight off disk.
 */
internal class AuqwWaveformPeaks(
  private val registry: AuqwStreamRegistry,
  private val localFor: (String) -> LocalSource?,
  private val cacheDirFor: () -> File,
) {
  private val jobs = ConcurrentHashMap<String, Job>()
  /** Request ids cancelled before their coroutine registered — the
   *  tombstone makes an early cancel sticky so the late-starting
   *  extract dies at entry instead of decoding on. */
  private val cancels = ConcurrentHashMap.newKeySet<String>()

  fun cancel(requestId: String) {
    cancels.add(requestId)
    jobs.remove(requestId)?.cancel()
  }

  fun cancelAll() {
    for ((_, job) in jobs) {
      job.cancel()
    }
    jobs.clear()
    cancels.clear()
  }

  /**
   * Pull → decode → bucket. Returns `count` flat `[up, down]` pairs of
   * raw RMS magnitudes. Every failure is a typed [CodedException] whose
   * code is the application kind (`unavailable` for not-yet-buffered
   * bytes or an unsupported PCM encoding, `released` for a dead
   * handle, `budget-exceeded` over caps, `not-applicable` for the
   * provisional unknown-duration cap, `invalid-response` for
   * undecodable bytes, `cancelled` on cancel).
   */
  suspend fun extract(
    requestId: String,
    handle: String,
    count: Int,
    maxBytes: Long,
    provisionalCap: Boolean,
  ): List<Double> {
    val job = coroutineContext[Job]
    val cap = minOf(maxBytes, MAX_PEAK_BYTES.toLong())
    // PCM spills to a cache file, not the heap: bucketing memory-maps
    // it, so peak allocation stays ~bounded regardless of track size
    // alongside the player.
    val pcmFile = File(
      cacheDirFor(),
      "auqw-peaks-" + requestId.replace(Regex("[^A-Za-z0-9._-]"), "_") + ".pcm"
    )
    try {
      if (job !== null) {
        jobs[requestId] = job
      }
      // A cancel that beat coroutine start lands on the tombstone —
      // consume it and die rather than decode a track the caller
      // already walked away from.
      if (cancels.remove(requestId)) {
        throw CancellationException("cancelled before extraction started")
      }
      val local = localFor(handle)
      val decoded = if (local !== null) {
        if (local.bytes > cap) {
          throw CodedException(
            if (provisionalCap) "not-applicable" else "budget-exceeded",
            "audio too large for peak extraction",
            null
          )
        }
        decodePcm(
          { extractor ->
            extractor.setDataSource(local.context, local.uri, null)
          },
          cap,
          provisionalCap,
          pcmFile,
        )
      } else {
        val host = registry.hostFor(handle)
          ?: throw CodedException("released", "unknown stream handle", null)
        val encoded = pullBytes(host, handle, cap, provisionalCap)
        decodePcm(
          { extractor ->
            extractor.setDataSource(ByteArrayMediaDataSource(encoded))
          },
          cap,
          provisionalCap,
          pcmFile,
        )
      }
      return bucket(
        pcmFile, decoded.bytes, decoded.channels, decoded.floatPcm, count
      )
    } catch (_: CancellationException) {
      throw CodedException("cancelled", "peak extraction cancelled", null)
    } finally {
      pcmFile.delete()
      // Only the registering job may drop its slot — a stale
      // extraction finishing late must not evict the replacement
      // that started under the same request id.
      if (job !== null) {
        jobs.remove(requestId, job)
      }
      cancels.remove(requestId)
    }
  }

  /** Sequential non-demanding positional reads to EOF or the cap —
   *  the same pull discipline as the desktop port, but on
   *  `streamPeek`: a hole returns `null` at once (nothing queued,
   *  nothing to retract) and the poll re-probes within the
   *  position's patience window — cold-start head fill for the
   *  first bytes, the short hole window after the flow starts. */
  private suspend fun pullBytes(
    host: PluginHost,
    handle: String,
    cap: Long,
    provisionalCap: Boolean,
  ): ByteArray {
    val out = ByteArrayOutputStream()
    var position = 0L
    var ended = false
    var deadline = SystemClock.uptimeMillis() + FIRST_READ_TIMEOUT_MS
    // `<=` so an exactly-`cap` stream still reaches its EOF read.
    while (out.size() <= cap) {
      coroutineContext.ensureActive()
      val readPos = position
      val chunk = try {
        withContext(Dispatchers.IO) {
          host.streamPeek(handle, readPos.toULong(), READ_CHUNK.toULong())
        }
      } catch (e: StreamException) {
        throw seamError(e)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        throw CodedException("transient", e.message ?: "stream read failed", e)
      }
      when {
        chunk === null -> {
          // An unfetched hole, not a failure worth caching hard —
          // and unlike a parked streamRead, nothing stays behind
          // competing with playback when the window lapses.
          if (SystemClock.uptimeMillis() >= deadline) {
            throw CodedException(
              "unavailable", "stream bytes not yet buffered", null
            )
          }
          delay(PEEK_POLL_MS)
        }
        chunk.isEmpty() -> {
          ended = true
          break
        }
        else -> {
          out.write(chunk, 0, chunk.size)
          position += chunk.size
          deadline = SystemClock.uptimeMillis() + PARK_TIMEOUT_MS
        }
      }
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

  /** MediaExtractor + MediaCodec over `setSource` → PCM spilled to
   *  `pcmFile` (never the heap — a long stereo track is ~92 MiB of
   *  PCM alongside the player), plus the negotiated shape the
   *  bucketer needs. The source is either the pulled stream bytes
   *  or a local file/content URI — decode is identical from there,
   *  and `encodedCap` bounds consumed compressed bytes for sources
   *  whose size was unknown (local paths that couldn't be stat'ed).
   */
  private suspend fun decodePcm(
    setSource: (MediaExtractor) -> Unit,
    encodedCap: Long,
    provisionalCap: Boolean,
    pcmFile: File,
  ): DecodedPcm = withContext(Dispatchers.IO) {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    var pcmOut: FileChannel? = null
    try {
      try {
        setSource(extractor)
      } catch (e: Exception) {
        throw CodedException(
          "unavailable", e.message ?: "audio source unavailable", e
        )
      }
      pcmOut = FileOutputStream(pcmFile).channel
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
      // Missing KEY_PCM_ENCODING means 16-bit — the documented default.
      var pcmEncoding = AudioFormat.ENCODING_PCM_16BIT
      var pcmBytes = 0L
      var consumedBytes = 0L
      val info = MediaCodec.BufferInfo()
      var inputEOS = false
      var outputEOS = false
      val deadline = SystemClock.uptimeMillis() + DECODE_DEADLINE_MS
      while (!outputEOS) {
        coroutineContext.ensureActive()
        if (SystemClock.uptimeMillis() > deadline) {
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
              consumedBytes += n
              if (consumedBytes > encodedCap) {
                throw CodedException(
                  if (provisionalCap) "not-applicable" else "budget-exceeded",
                  "audio too large for peak extraction",
                  null
                )
              }
              decoder.queueInputBuffer(inIdx, 0, n, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        val outIdx = decoder.dequeueOutputBuffer(info, DEQUEUE_US)
        when {
          outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val outFormat = decoder.outputFormat
            channels = formatInt(outFormat, MediaFormat.KEY_CHANNEL_COUNT)
              ?: channels
            pcmEncoding = formatInt(outFormat, MediaFormat.KEY_PCM_ENCODING)
              ?: AudioFormat.ENCODING_PCM_16BIT
            if (pcmEncoding != AudioFormat.ENCODING_PCM_16BIT &&
              pcmEncoding != AudioFormat.ENCODING_PCM_FLOAT
            ) {
              throw CodedException(
                "unavailable", "unsupported PCM encoding $pcmEncoding", null
              )
            }
          }
          outIdx >= 0 -> {
            if (info.size > 0) {
              if (pcmBytes + info.size > MAX_PCM_BYTES) {
                throw CodedException(
                  "budget-exceeded",
                  "decoded audio too large for peaks",
                  null
                )
              }
              val buf = decoder.getOutputBuffer(outIdx)
              if (buf !== null) {
                buf.position(info.offset)
                buf.limit(info.offset + info.size)
                pcmOut?.write(buf)
                pcmBytes += info.size
              }
            }
            decoder.releaseOutputBuffer(outIdx, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
              outputEOS = true
            }
          }
        }
      }
      DecodedPcm(
        pcmBytes,
        channels,
        pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT,
      )
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
      try {
        pcmOut?.close()
      } catch (e: Exception) {
        Log.i(TAG, "pcm spill close: ${e.message}")
      }
    }
  }

  /** Spilled PCM file → `count` raw `[up, down]` RMS windows — the
   *  same split `peakWindowsFromChannels` applies in ui-shared:
   *  stereo+ feeds even channels to `up` and odd to `down`; mono
   *  splits by sign, positive samples up and negative down. The file
   *  is read through a memory map — page cache, not heap — and
   *  samples follow the negotiated encoding: little-endian 16-bit
   *  divided by full-scale, or float PCM used directly. */
  private fun bucket(
    pcmFile: File,
    pcmBytes: Long,
    channels: Int,
    floatPcm: Boolean,
    count: Int,
  ): List<Double> {
    val out = ArrayList<Double>(count * 2)
    if (count <= 0 || channels <= 0 || pcmBytes <= 0) {
      return out
    }
    FileInputStream(pcmFile).channel.use { ch ->
      val buf = ch.map(FileChannel.MapMode.READ_ONLY, 0, pcmBytes)
        .order(ByteOrder.LITTLE_ENDIAN)
      val sampleCount: Int
      val sample: (Int) -> Double
      if (floatPcm) {
        val floats = buf.asFloatBuffer()
        sampleCount = floats.remaining()
        sample = { i -> floats.get(i).toDouble() }
      } else {
        val shorts = buf.asShortBuffer()
        sampleCount = shorts.remaining()
        sample = { i -> shorts.get(i).toDouble() / 32768.0 }
      }
      val frames = sampleCount / channels
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
            for (c in 0 until channels) {
              val v = sample(base + c)
              if (c % 2 == 0) {
                upSq += v * v
                upN += 1
              } else {
                downSq += v * v
                downN += 1
              }
            }
          } else {
            val v = sample(base)
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
