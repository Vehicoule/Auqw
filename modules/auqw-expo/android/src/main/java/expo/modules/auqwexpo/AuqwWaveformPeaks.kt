@file:OptIn(UnstableApi::class)

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
import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.source.BundledExtractorsAdapter
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.DiscardingTrackOutput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.coroutineContext
import kotlin.math.ceil
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
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
/** First-hole patience after a probe met a session refusal — the fill
 * that would commit the hole rides the same refused session, so the
 * pull still serves whatever is already committed but gives up fast
 * instead of parking through the provider's cooldown. */
private const val REFUSED_PULL_PATIENCE_MS = 1_000L
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
/** Bound on pending cancel tombstones — see `cancels`. */
private const val MAX_TOMBSTONES = 64
private const val DEQUEUE_US = 10_000L

/* ---- sampled extraction bounds ------------------------------------------
 * `streamProbe` reads are bounded ranged fetches that commit into the
 * session's sparse store — every fetched byte is real media data the
 * player could later serve, never a discarded duplicate. The caps keep
 * a decoration's total spend under ~8 MiB (the desktop port's ~4 MiB
 * plus one head/seed read per lane of seek-index traffic).
 */
/** Head probe: learns the stream total and warms the container head —
 * the extractor's own setDataSource reads then serve as hits. */
private const val HEAD_PROBE_BYTES = 256 * 1024
/** Per-call read bound inside a probe-backed data source — one readAt
 * is at most one ranged GET (the seam itself clamps at chunk_bytes). */
private const val PROBE_READ_MAX = 256 * 1024
/** Probe-window floor — under it the demuxer's own read pattern
 * re-probes inside a single sample window. */
private const val PROBE_WINDOW_MIN = 48 * 1024
/** Container slack over a sample's encoded span — cues and cluster
 * headers sit between the seek point and the audio blocks. */
private const val PROBE_WINDOW_SLACK = 32 * 1024
/** Consecutive refused probes before a lane's reader gives up — one
 * stalled or rate-limited response must not kill the lane outright. */
private const val PROBE_MAX_STRIKES = 3
/** Whole-sweep probe spend across all lanes: a runaway extractor scan
 * fails closed at this — reads past it report EOF so the sampled path
 * gives up instead of pulling the whole file for a decoration. */
private const val PROBE_BUDGET_BYTES = 8L * 1024 * 1024
/** Small streams sit inside the pump's speculative head fill — the
 * legacy pull serves them off committed bytes without spending probe
 * requests, so sampling only pays off past this total. */
private const val SAMPLED_MIN_TOTAL_BYTES = 4L * 1024 * 1024
/** Seek points per sweep — the desktop port's coarse+refine count. */
private const val SAMPLED_POINTS = 24
/** Parallel extractor+codec lanes; probe fetches are the latency, so
 * flights overlap — committed hits serve instantly on any lane. */
private const val SAMPLE_LANES = 4
/** A coarse profile may render once this many samples have MEASURED
 * bars — a failed decode never counts (zeros are not bars). */
private const val COARSE_MIN_SAMPLES = 5
/** Decoded PCM to collect per seek point — enough coverage that the
 * nearest-measured fill reads as the real shape, bounded so the whole
 * sweep decodes a fraction of the track instead of all of it. */
private const val SAMPLE_PCM_MS = 2_000L
/** Packet-feed bound past the seek point — the decode loop stops
 * reading samples once the extractor's own clock passes it, so a
 * dense-bytes/slow-clock source can't over-deliver PCM. */
private const val SAMPLE_FEED_US = 6_000_000L
/** Per-sample PCM spill bound — a window's decoded audio lives on the
 * heap only until its windows are computed. ~3.9 s of stereo 16-bit
 * 48 kHz; float/PCM paths count bytes the same way. */
private const val SAMPLE_PCM_CAP_BYTES = 1536 * 1024
/** Dequeue iterations before one sample gives up — a wedged lane
 * abandons its point, never the sweep. */
private const val SAMPLE_MAX_LOOPS = 600

/** Absolute input bound per window — a frozen `sampleTime` can
 * never trip the `SAMPLE_FEED_US` guard, so packets are counted too.
 * Opus ~20ms frames make 2k packets ≈ 40s of media: far past the
 * window, still far under a whole-file drain. */
private const val SAMPLE_MAX_PACKETS = 2_000

/** Parser pulls to yield one queued sample before the window calls
 *  its feed done — a wedged demuxer dies here instead of looping. */
private const val SAMPLE_PARSE_PULLS = 200

/** Parser pulls allowed for the seed/await phase to land the track
 *  format + SeekMap — container headers plus sniff retries. */
private const val SEED_PARSE_PULLS = 400

/** Decorative decode bound — the JS port's `PEAKS_MAX_DECODE_MS`:
 *  tracks longer than this refuse extraction. The caller gates
 *  known durations; the sampled path re-gates on the PARSED
 *  duration so an unknown-duration stream can't produce a profile
 *  the legacy pull would have refused. */
private const val PEAKS_MAX_DECODE_MS = 8L * 60 * 1000

/** Minimum decoded points for a profile to count as finished —
 *  half the sweep. A run where most seeks failed stays provisional:
 *  it falls to the whole-file fallback rather than persisting a
 *  profile whose bars are mostly nearest-measured fill. */
private const val SAMPLED_MIN_COVERAGE = SAMPLED_POINTS / 2

private val DEAD_HANDLE_KINDS = setOf(
  "released", "evicted", "expired", "superseded", "not-found"
)
private val INVALID_RESPONSE_KINDS = setOf(
  "invalid-request", "invalid-response", "invalid-message"
)
/** Sampled-path failures that must surface, not fall back: a dead
 * handle would just die again on the legacy pull, and a refusal
 * (`budget-exceeded`/`not-applicable`) IS the honest answer — the
 * whole-file pull would only rediscover it. Everything else (parse,
 * codec, budget, cooldown) still earns the honest whole-file attempt
 * — the pull rides already-committed bytes regardless. */
private val PROPAGATE_KINDS =
  DEAD_HANDLE_KINDS + setOf("cancelled", "budget-exceeded", "not-applicable")

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
  /** Request ids with an extraction in flight — JS mints one id per
   *  request, and a duplicate that sneaks through (e.g. a replayed
   *  dev-client call) is refused at registration rather than letting
   *  a second job's cleanup delete the first job's spill file or
   *  steal its cancel tombstone. */
  private val jobs = ConcurrentHashMap<String, Job>()
  /** Job-local serial that names each extraction's spill file.
   *  Request ids identify the caller, not the run — a retried or
   *  replayed id must never point at another job's decoded PCM, so
   *  the filename carries this counter next to the id. */
  private val jobSeq = AtomicLong(0L)
  /** Request ids cancelled before their coroutine registered — the
   *  tombstone makes an early cancel sticky so the late-starting
   *  extract dies at entry instead of decoding on. Access-ordered
   *  and capped: a cancel that lands after its job already finished
   *  leaves a marker no registration will ever consume, so the
   *  oldest tombstones fall away rather than growing without bound;
   *  an extract that still exists waits far fewer than this many
   *  cancels behind its registration. */
  private val cancels = Collections.synchronizedSet(
    Collections.newSetFromMap(
      object : LinkedHashMap<String, Boolean>(64, 0.75f, true) {
        override fun removeEldestEntry(
          eldest: MutableMap.MutableEntry<String, Boolean>,
        ): Boolean = size > MAX_TOMBSTONES
      }
    )
  )

  fun cancel(requestId: String) {
    cancels.add(requestId)
    jobs.remove(requestId)?.cancel()
  }

  fun cancelAll() {
    jobs.values.forEach { it.cancel() }
    jobs.clear()
    cancels.clear()
  }

  /**
   * Sample → decode → bucket. Returns `count` flat `[up, down]` pairs of
   * raw RMS magnitudes. Every failure is a typed [CodedException] whose
   * code is the application kind (`unavailable` for not-yet-buffered
   * bytes or an unsupported PCM encoding, `released` for a dead
   * handle, `budget-exceeded` over caps, `not-applicable` for the
   * provisional unknown-duration cap, `invalid-response` for
   * undecodable bytes, `cancelled` on cancel).
   *
   * `onCoarse` fires at most once with the coarse-but-measured profile
   * (the shared progressive contract — real bars land while the
   * refinement round still runs). Never called with fabricated data.
   */
  suspend fun extract(
    requestId: String,
    handle: String,
    count: Int,
    maxBytes: Long,
    provisionalCap: Boolean,
    onCoarse: ((List<Double>) -> Unit)?,
  ): List<Double> {
    val job = coroutineContext[Job]
    val cap = minOf(maxBytes, MAX_PEAK_BYTES.toLong())
    // PCM spills to a cache file, not the heap: bucketing memory-maps
    // it, so peak allocation stays ~bounded regardless of track size
    // alongside the player.
    val pcmFile = File(
      cacheDirFor(),
      "auqw-peaks-" +
        requestId.replace(Regex("[^A-Za-z0-9._-]"), "_") +
        "-" + jobSeq.incrementAndGet() + ".pcm"
    )
    // Reject before `try`: a refused job owns nothing, so no cleanup
    // may run on its behalf — its `finally` would otherwise consume
    // the live job's cancel tombstone or delete its decoded PCM
    // mid-read.
    if (job !== null && jobs.putIfAbsent(requestId, job) !== null) {
      throw CodedException(
        "invalid-request",
        "peak extraction already in flight for request id",
        null
      )
    }
    try {
      // A cancel that beat coroutine start lands on the tombstone —
      // consume it and die rather than decode a track the caller
      // already walked away from. Registration happened above, so a
      // cancel can't be lost between the two reads.
      if (cancels.remove(requestId)) {
        throw CancellationException("cancelled before extraction started")
      }
      val local = localFor(handle)
      val setSource: (MediaExtractor) -> Unit
      if (local !== null) {
        if (local.bytes > cap) {
          throw CodedException(
            if (provisionalCap) "not-applicable" else "budget-exceeded",
            "audio too large for peak extraction",
            null
          )
        }
        setSource = { it.setDataSource(local.context, local.uri, null) }
      } else {
        val host = registry.hostFor(handle)
          ?: throw CodedException("released", "unknown stream handle", null)
        // Sampled ranged extraction first — scattered probe fetches
        // plus per-window decode land real bars in probe-RTT time
        // instead of trailing a whole-file pull. Structural misses
        // (unknown total, small file, unseekable container, no
        // decodable sample) fall through to the whole-file sweep.
        // null = no probe refused yet; non-null = the FIRST refusal's
        // seam kind — a terminal kind (dead handle, invalid-response)
        // must stay terminal through the pull, not decay to transient.
        val probeRefused = AtomicReference<String?>(null)
        val sampled = try {
          sampledStream(
            requestId, host, handle, count, cap, provisionalCap, job,
            onCoarse, probeRefused
          )
        } catch (e: CancellationException) {
          throw e
        } catch (e: CodedException) {
          // A refusal met before anything committed (the head probe's
          // own failure leaves position 0 a hole) can't be beaten by
          // the whole-file pull — propagate the transient so the
          // tracker retries once the session's cooldown lapses.
          if (e.code in PROPAGATE_KINDS ||
            (e.code == "transient" && probeRefused.get() != null)
          ) {
            throw e
          }
          Log.w(TAG, "peaks[$requestId] sampled bailed: ${e.code}")
          null
        }
        if (sampled !== null) {
          return sampled
        }
        // The pull only ever serves committed bytes — a refused
        // session won't fill the holes, so its first-hole patience
        // shortens to a beat: committed audio still drains, a cold
        // refusal fails typed instead of parking through the cooldown.
        val pullStart = SystemClock.uptimeMillis()
        val encoded = pullBytes(
          host, handle, cap, provisionalCap, probeRefused.get()
        )
        Log.i(
          TAG,
          "peaks[$requestId] legacy pull +${SystemClock.uptimeMillis() - pullStart}ms bytes=${encoded.size}"
        )
        setSource = { it.setDataSource(ByteArrayMediaDataSource(encoded)) }
      }
      val decodeStart = SystemClock.uptimeMillis()
      val decoded = decodePcm(setSource, cap, provisionalCap, pcmFile)
      Log.i(
        TAG,
        "peaks[$requestId] decode +${SystemClock.uptimeMillis() - decodeStart}ms pcm=${decoded.bytes}"
      )
      return try {
        val bucketStart = SystemClock.uptimeMillis()
        val windows = bucket(
          pcmFile, decoded.bytes, decoded.channels, decoded.floatPcm, count, job
        )
        Log.i(
          TAG,
          "peaks[$requestId] bucket +${SystemClock.uptimeMillis() - bucketStart}ms"
        )
        windows
      } catch (e: CodedException) {
        throw e
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        // Nothing untyped crosses the Expo boundary — the same catch
        // order decodePcm applies below.
        throw CodedException(
          "invalid-response", e.message ?: "peak bucketing failed", e
        )
      }
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
    refusalKind: String? = null,
  ): ByteArray {
    val out = ByteArrayOutputStream()
    var ended = false
    var deadline = SystemClock.uptimeMillis() +
      if (refusalKind != null) REFUSED_PULL_PATIENCE_MS else FIRST_READ_TIMEOUT_MS
    // `<=` so an exactly-`cap` stream still reaches its EOF read.
    while (out.size() <= cap) {
      coroutineContext.ensureActive()
      val chunk = try {
        withContext(Dispatchers.IO) {
          host.streamPeek(handle, out.size().toULong(), READ_CHUNK.toULong())
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
            // A hole with refusal evidence fails as the refusal's
            // own kind — a terminal one (dead handle, invalid-response)
            // stays terminal instead of decaying to retry weather; an
            // unrefused hole is genuinely unbuffered content.
            throw CodedException(
              refusalKind ?: "unavailable",
              "stream bytes not yet buffered", null
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

  /* ---- sampled ranged extraction ------------------------------------------
   * The whole-file pull trails the pump's speculative fill — on a real
   * network the waveform lands seconds after 'playing' because every
   * byte must first arrive for the player. Sampling flips the shape:
   * a probe-backed MediaDataSource turns MediaExtractor's own reads
   * (container head, seek index, seeked sample windows) into one
   * bounded ranged GET each, all committed into the session's sparse
   * store where the player serves them for free. `SAMPLE_LANES`
   * parallel extractor+codec pairs overlap the probe RTTs; each lane
   * seeks to evenly spaced media times and decodes ~SAMPLE_PCM_MS of
   * audio per point. Buckets a sample never measured stay unmeasured
   * until the nearest-measured fill at emit — nothing is fabricated.
   */

  /**
   * Returns the flat `[up, down]` pair list, or `null` when the stream
   * isn't samplable (unknown total, small file, no decodable sample,
   * unseekable container) so the caller can run the honest whole-file
   * fallback. Throws only for sweep-fatal conditions.
   */
  private suspend fun sampledStream(
    requestId: String,
    host: PluginHost,
    handle: String,
    count: Int,
    cap: Long,
    provisionalCap: Boolean,
    job: Job?,
    onCoarse: ((List<Double>) -> Unit)?,
    probeRefused: AtomicReference<String?>,
  ): List<Double>? {
    val t0 = SystemClock.uptimeMillis()
    // Head probe: warms position 0 (the extractor's own sniff reads
    // then serve as committed hits) and reports the stream total.
    val head = try {
      withContext(Dispatchers.IO) {
        host.streamProbe(handle, 0uL, HEAD_PROBE_BYTES.toULong(), true)
      }
    } catch (e: StreamException) {
      probeRefused.compareAndSet(null, seamKind(e))
      throw seamError(e)
    }
    val total = head.total?.toLong() ?: return null
    if (total <= SAMPLED_MIN_TOTAL_BYTES || head.data.isEmpty()) {
      return null
    }
    // Same encoded-size refusal the local/pull paths apply — a
    // sampled profile can't ship bars the legacy sweep would refuse.
    if (total > cap) {
      throw CodedException(
        if (provisionalCap) "not-applicable" else "budget-exceeded",
        "audio too large for peak extraction",
        null
      )
    }
    Log.i(
      TAG,
      "peaks[$requestId] head-probe +${SystemClock.uptimeMillis() - t0}ms total=$total"
    )
    // Shared sweep spend: every lane's reads draw down one budget so a
    // container that makes the extractor scan forward (no seek index)
    // fails closed into the honest fallback rather than pulling the
    // whole file through probes.
    val budget = AtomicLong(0)
    val probeCalls = AtomicLong(0)
    // Seed pass: one bundled extractor parses the container IN-PROCESS
    // — the platform MediaExtractor's every call is a Binder trip into
    // a service that serializes all lanes, so the sweep rides Media3's
    // own demuxer (same OS-level demux semantics, no IPC). Its probe
    // reads leave the head committed for every later lane.
    var seed: SeedInfo? = null
    try {
      seed = withContext(Dispatchers.IO) {
        seedParse(host, handle, total, budget, probeCalls, job, probeRefused)
      }
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.w(
        TAG,
        "peaks[$requestId] seed parse failed: " +
          "${e.javaClass.simpleName} ${e.message}"
      )
    }
    if (seed === null || seed.durationUs <= 0 || !seed.seekable) {
      return null
    }
    val durationUs = seed.durationUs
    val durationMs = durationUs / 1000.0
    // The JS gate only sees the declared duration — a stream whose
    // catalog entry lacks one still answers to the same bound once
    // the container parses.
    if (durationMs > PEAKS_MAX_DECODE_MS) {
      throw CodedException(
        "budget-exceeded", "track too long for decorative peaks", null
      )
    }
    Log.i(
      TAG,
      "peaks[$requestId] seed +${SystemClock.uptimeMillis() - t0}ms " +
        "durationMs=${durationMs.toLong()} fetched=${budget.get()}"
    )
    val bucketMs = durationMs / count
    if (!(bucketMs > 0)) {
      return null
    }

    // One window = the sample's own encoded span plus container slack,
    // sized off the stream's average bitrate — a fixed 256KiB fetch
    // makes every point a ~6MiB-share ranged GET on throttled links
    // for audio the window never decodes, while a fixed small window
    // would re-probe mid-sample on fat streams.
    val probeWindow = (
      total * (SAMPLE_PCM_MS + 1_000L) / durationMs +
        PROBE_WINDOW_SLACK
      ).toLong().coerceIn(
        PROBE_WINDOW_MIN.toLong(), PROBE_READ_MAX.toLong()
      )
    val sparse = arrayOfNulls<DoubleArray>(count)
    val sparseLock = Any()
    val applied = AtomicInteger(0)
    val coarseSent = AtomicBoolean(false)
    val lanes = minOf(SAMPLE_LANES, SAMPLED_POINTS)
    coroutineScope {
      (0 until lanes).map { lane ->
        async(Dispatchers.IO) {
          sampleLane(
            requestId, host, handle, total, budget, probeCalls,
            lane, lanes, durationUs, durationMs, count, job,
            probeWindow, probeRefused
          ) { mediaMs, _, windows ->
            // Merge the sample's per-window RMS under the lock — an
            // overlap keeps the louder measured value, never averages
            // a transient away. `windows` is flat [up, down] pairs.
            synchronized(sparseLock) {
              val first = (mediaMs / bucketMs).toInt()
              var j = 0
              while (j < windows.size && first + j / 2 < count) {
                val i = first + j / 2
                if (i >= 0) {
                  val up = windows[j]
                  val down = windows[j + 1]
                  val prev = sparse[i]
                  sparse[i] = when {
                    prev === null -> doubleArrayOf(up, down)
                    else -> doubleArrayOf(
                      maxOf(prev[0], up), maxOf(prev[1], down)
                    )
                  }
                }
                j += 2
              }
            }
            val done = applied.incrementAndGet()
            if (done >= COARSE_MIN_SAMPLES &&
              coarseSent.compareAndSet(false, true)
            ) {
              val flat = synchronized(sparseLock) { fillFlat(sparse, count) }
              Log.i(
                TAG,
                "peaks[$requestId] coarse " +
                  "+${SystemClock.uptimeMillis() - t0}ms applied=$done"
              )
              try {
                onCoarse?.invoke(flat)
              } catch (e: Exception) {
                Log.w(TAG, "peaks[$requestId] coarse emit failed")
              }
            }
          }
        }
      }.forEach { it.await() }
    }
    // Coverage floor: below it the filled profile would be mostly
    // nearest-measured copies — honest bars, but the tracker persists
    // the result as finished and never retries. Degrade to the
    // whole-file sweep, which measures every bucket.
    if (applied.get() < SAMPLED_MIN_COVERAGE) {
      Log.w(
        TAG,
        "peaks[$requestId] sampled under-covered " +
          "${applied.get()}/$SAMPLED_POINTS — falling back"
      )
      return null
    }
    val flat = synchronized(sparseLock) { fillFlat(sparse, count) }
    Log.i(
      TAG,
      "peaks[$requestId] sampled-done " +
        "+${SystemClock.uptimeMillis() - t0}ms " +
        "samples=${applied.get()} fetched=${budget.get()} probes=${probeCalls.get()}"
    )
    return flat
  }

  /** One extractor+codec lane's share of the sweep: seeks to its
   *  strided slice of evenly spaced media times and decodes a bounded
   *  PCM window at each, reporting per-window RMS to the merger. A
   *  lane's own extractor/codec failures end the lane only — sibling
   *  lanes still deliver their coverage. */
  private suspend fun sampleLane(
    requestId: String,
    host: PluginHost,
    handle: String,
    total: Long,
    budget: AtomicLong,
    probeCalls: AtomicLong,
    lane: Int,
    lanes: Int,
    durationUs: Long,
    durationMs: Double,
    count: Int,
    job: Job?,
    probeWindow: Long,
    probeRefused: AtomicReference<String?>,
    onSample: (mediaMs: Double, pcmMs: Double, windows: List<Double>) -> Unit,
  ) {
    val reader = ProbeDataReader(
      host, handle, total, budget, probeCalls, probeWindow, probeRefused
    )
    val pump = SampleQueue()
    val adapter = BundledExtractorsAdapter(DefaultExtractorsFactory())
    var codec: MediaCodec? = null
    try {
      adapter.init(reader, Uri.EMPTY, emptyMap(), 0, total, pump)
      val format = awaitTrackFormat(reader, adapter, pump, total, job) ?: return
      val mime = format.sampleMimeType ?: return
      val decoder = try {
        MediaCodec.createDecoderByType(mime)
      } catch (_: Exception) {
        return
      }
      codec = decoder
      decoder.configure(codecFormat(format), null, null, 0)
      decoder.start()
      for (point in lane until SAMPLED_POINTS step lanes) {
        job?.ensureActive()
        val targetUs = durationUs * (point * 2L + 1) / (SAMPLED_POINTS * 2L)
        val wt = SystemClock.uptimeMillis()
        val fetchBefore = reader.srcFetched.get()
        val callsBefore = reader.srcCalls.get()
        val pcm = sampleWindowPcm(
          reader, adapter, pump, decoder, format, total, targetUs, job
        )
        Log.d(
          TAG,
          "peaks[$requestId] lane=$lane point=$point " +
            "+${SystemClock.uptimeMillis() - wt}ms " +
            "seek->${(pcm?.mediaMs ?: -1.0).toLong()}ms " +
            "pcmMs=${(pcm?.pcmMs ?: 0.0).toLong()} " +
            "fetched+${reader.srcFetched.get() - fetchBefore} " +
            "probes+${reader.srcCalls.get() - callsBefore}"
        )
        if (pcm === null) {
          continue
        }
        // A sample claims only the buckets its PCM honestly covers —
        // capped so an over-long window can't paint the whole row.
        val bucketMs = durationMs / count
        val windows = minOf(
          8,
          maxOf(1, ceil(pcm.pcmMs / bucketMs).toInt()),
        )
        onSample(
          pcm.mediaMs,
          pcm.pcmMs,
          rmsWindows(
            ByteBuffer.wrap(pcm.data).order(ByteOrder.LITTLE_ENDIAN),
            pcm.data.size.toLong(),
            pcm.channels,
            pcm.floatPcm,
            windows,
            job,
          ),
        )
      }
    } catch (e: CancellationException) {
      throw e
    } catch (_: Exception) {
      // Lane-local failure — the sweep keeps the lanes that did land.
    } finally {
      quiet("lane codec stop") { codec?.stop() }
      quiet("lane codec release") { codec?.release() }
      quiet("lane extractor release") { adapter.release() }
    }
  }

  /** One decoded sample window: PCM bytes plus the negotiated shape,
   *  at the extractor's own post-seek media time — never a guessed
   *  offset. `pcmMs` is the covered media span measured off the
   *  decoded output timestamps (falling back to the byte count when a
   *  codec stamps nothing). */
  private class SamplePcm(
    val mediaMs: Double,
    val pcmMs: Double,
    val data: ByteArray,
    val channels: Int,
    val floatPcm: Boolean,
  )

  /**
   * Seek → bounded decode at one sample point, driven through the
   * bundled extractor: `adapter.seek` posts the target, `read()`
   * repositions the probe reader at the returned byte offset and
   * demuxes samples into `pump.samples`; each whole access unit feeds
   * the codec at most `SAMPLE_FEED_US` of media past the first
   * delivered sample and keeps at most `SAMPLE_PCM_MS` of decoded
   * audio. `null` means the point produced nothing honest (dead
   * seek, empty decode).
   */
  private fun sampleWindowPcm(
    reader: ProbeDataReader,
    adapter: BundledExtractorsAdapter,
    pump: SampleQueue,
    decoder: MediaCodec,
    trackFormat: Format,
    total: Long,
    targetUs: Long,
    job: Job?,
  ): SamplePcm? {
    job?.ensureActive()
    pump.samples.clear()
    // Extractor.seek takes (byte position, timeUs) — resolve the
    // media-time target to a byte offset through the container's
    // SeekMap, re-anchor the reader there with a fresh input (stale
    // peek bytes must not splice onto the new position), then reset
    // the extractor's parser state.
    val seekMap = pump.seekMap ?: return null
    val bytePos = try {
      seekMap.getSeekPoints(targetUs).first.position
    } catch (_: Exception) {
      return null
    }
    try {
      adapter.seek(bytePos, targetUs)
      reposition(reader, adapter, pump, bytePos, total)
    } catch (_: Exception) {
      return null
    }
    try {
      decoder.flush()
    } catch (_: Exception) {
      return null
    }
    // Shape comes from the demuxed track format first — a codec that
    // never reports OUTPUT_FORMAT_CHANGED would otherwise starve the
    // early-exit math and decode the whole feed bound per window.
    var channels = trackFormat.channelCount
    var sampleRate = trackFormat.sampleRate
    var pcmEncoding = AudioFormat.ENCODING_PCM_16BIT
    var pcmBytes = 0L
    var firstPts = -1L
    var lastPts = -1L
    var firstSampleUs = -1L
    val out = ByteArrayOutputStream(SAMPLE_PCM_CAP_BYTES.coerceAtMost(256 * 1024))
    val info = MediaCodec.BufferInfo()
    val ph = PositionHolder()
    var inputEOS = false
    var parseEnded = false
    var fedPackets = 0
    var loops = 0
    while (true) {
      job?.ensureActive()
      if (loops++ > SAMPLE_MAX_LOOPS) {
        break
      }
      if (!inputEOS) {
        val inIdx = decoder.dequeueInputBuffer(DEQUEUE_US)
        if (inIdx >= 0) {
          var s = pump.samples.removeFirstOrNull()
          var pulls = 0
          while ((s === null || s.timeUs < 0) && !parseEnded &&
            pulls++ < SAMPLE_PARSE_PULLS
          ) {
            if (s !== null) {
              // Untimestamped access unit — unplaceable, drop it and
              // keep pulling rather than feed the codec a lie.
              s = null
              continue
            }
            when (adapter.read(ph)) {
              Extractor.RESULT_SEEK -> {
                try {
                  reposition(reader, adapter, pump, ph.position, total)
                } catch (_: Exception) {
                  // A broken re-anchor only ends this window's feed —
                  // decode what already queued and report the honest
                  // remainder instead of dying to the next point.
                  parseEnded = true
                }
              }
              Extractor.RESULT_END_OF_INPUT -> parseEnded = true
            }
            s = pump.samples.removeFirstOrNull()
          }
          val overFeed = s !== null && firstSampleUs >= 0 &&
            s.timeUs - firstSampleUs > SAMPLE_FEED_US
          if (s === null || overFeed || fedPackets > SAMPLE_MAX_PACKETS) {
            decoder.queueInputBuffer(
              inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM
            )
            inputEOS = true
          } else {
            if (firstSampleUs < 0) {
              firstSampleUs = s.timeUs
            }
            val buf = decoder.getInputBuffer(inIdx)
            if (buf === null || buf.remaining() < s.data.size) {
              // Access units must stay whole — a packet past the
              // codec's input capacity ends the window's feed.
              decoder.queueInputBuffer(
                inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              inputEOS = true
            } else {
              buf.put(s.data)
              decoder.queueInputBuffer(inIdx, 0, s.data.size, s.timeUs, 0)
              fedPackets += 1
            }
          }
        }
      }
      val outIdx = decoder.dequeueOutputBuffer(info, DEQUEUE_US)
      when {
        outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val outFormat = decoder.outputFormat
          channels = formatInt(outFormat, MediaFormat.KEY_CHANNEL_COUNT)
            ?: channels
          sampleRate = formatInt(outFormat, MediaFormat.KEY_SAMPLE_RATE)
            ?: sampleRate
          pcmEncoding = formatInt(outFormat, MediaFormat.KEY_PCM_ENCODING)
            ?: AudioFormat.ENCODING_PCM_16BIT
          if (pcmEncoding != AudioFormat.ENCODING_PCM_16BIT &&
            pcmEncoding != AudioFormat.ENCODING_PCM_FLOAT
          ) {
            return null
          }
        }
        outIdx >= 0 -> {
          if (info.size > 0) {
            val buf = decoder.getOutputBuffer(outIdx)
            if (buf !== null && pcmBytes + info.size <= SAMPLE_PCM_CAP_BYTES) {
              val slice = ByteArray(info.size)
              buf.position(info.offset)
              buf.limit(info.offset + info.size)
              buf.get(slice)
              out.write(slice)
              pcmBytes += info.size
              if (firstPts < 0) {
                firstPts = info.presentationTimeUs
              }
              lastPts = info.presentationTimeUs
            }
          }
          decoder.releaseOutputBuffer(outIdx, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            break
          }
          // Enough real audio for the window — stop early instead of
          // draining the rest of the feed bound. Past the cap more
          // slices would only be dropped — stop there too.
          if (pcmBytes >= SAMPLE_PCM_CAP_BYTES) {
            break
          }
          if (sampleRate > 0 && channels > 0) {
            val bytesPerMs =
              channels.toLong() *
              (if (pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2) *
              sampleRate / 1000
            if (bytesPerMs > 0 && pcmBytes >= SAMPLE_PCM_MS * bytesPerMs) {
              break
            }
          }
        }
      }
    }
    if (pcmBytes <= 0 || channels <= 0) {
      return null
    }
    val bytesMs = if (sampleRate > 0) {
      pcmBytes * 1000.0 /
        (channels * (if (pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2) *
          sampleRate)
    } else {
      0.0
    }
    val ptsMs = if (firstPts >= 0 && lastPts > firstPts) {
      (lastPts - firstPts) / 1000.0
    } else {
      0.0
    }
    val pcmMs = maxOf(ptsMs, bytesMs)
    if (pcmMs <= 0) {
      return null
    }
    return SamplePcm(
      (if (firstPts >= 0) firstPts else firstSampleUs) / 1000.0,
      pcmMs,
      out.toByteArray(),
      channels,
      pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT,
    )
  }

  /** What the seed pass proves about a stream: a seekable demuxer and
   *  its media duration — without both, the sweep can't sample. */
  private class SeedInfo(
    val durationUs: Long,
    val seekable: Boolean,
  )

  /** One bundled extractor over the probe reader, parsed just far
   *  enough for the audio track's format and the SeekMap duration to
   *  land — head bytes the player will later reuse. */
  private fun seedParse(
    host: PluginHost,
    handle: String,
    total: Long,
    budget: AtomicLong,
    probeCalls: AtomicLong,
    job: Job?,
    probeRefused: AtomicReference<String?>,
  ): SeedInfo? {
    val reader = ProbeDataReader(
      host, handle, total, budget, probeCalls,
      PROBE_READ_MAX.toLong(), probeRefused
    )
    val pump = SampleQueue()
    val adapter = BundledExtractorsAdapter(DefaultExtractorsFactory())
    try {
      adapter.init(reader, Uri.EMPTY, emptyMap(), 0, total, pump)
      val ph = PositionHolder()
      var pulls = 0
      while ((pump.audioFormat === null || pump.durationUs <= 0) &&
        pulls++ < SEED_PARSE_PULLS
      ) {
        job?.ensureActive()
        when (adapter.read(ph)) {
          Extractor.RESULT_SEEK -> reposition(reader, adapter, pump, ph.position, total)
          Extractor.RESULT_END_OF_INPUT -> break
        }
      }
    } finally {
      adapter.release()
    }
    if (pump.audioFormat === null) {
      return null
    }
    return SeedInfo(pump.durationUs, pump.seekable)
  }

  /**
   * Honor a RESULT_SEEK: re-anchor the probe reader at the parser's
   *  requested byte offset AND re-init the adapter there. `init`
   *  always swaps in a fresh DefaultExtractorInput (it only sniffs
   *  when no extractor was picked yet), so the stale peek buffer the
   *  old input carried can never splice head bytes onto the new
   *  stream position.
   */
  private fun reposition(
    reader: ProbeDataReader,
    adapter: BundledExtractorsAdapter,
    pump: SampleQueue,
    position: Long,
    total: Long,
  ) {
    reader.position = position
    adapter.init(
      reader, Uri.EMPTY, emptyMap(), position, total - position, pump
    )
  }

  /** Parse until the audio track's format AND SeekMap land — the
   *  codec needs the first to configure; every window seek needs the
   *  second to resolve media-time → byte offset. */
  private fun awaitTrackFormat(
    reader: ProbeDataReader,
    adapter: BundledExtractorsAdapter,
    pump: SampleQueue,
    total: Long,
    job: Job?,
  ): Format? {
    val ph = PositionHolder()
    var pulls = 0
    while ((pump.audioFormat === null || pump.seekMap === null) &&
      pulls++ < SEED_PARSE_PULLS
    ) {
      job?.ensureActive()
      when (adapter.read(ph)) {
        Extractor.RESULT_SEEK -> reposition(reader, adapter, pump, ph.position, total)
        Extractor.RESULT_END_OF_INPUT -> break
      }
    }
    return pump.audioFormat
  }

  /** MediaCodec format from the demuxed track — mime, shape, and the
   *  codec-specific init data (e.g. opus's csd-0/1/2) verbatim. */
  private fun codecFormat(format: Format): MediaFormat {
    val mf = MediaFormat()
    mf.setString(MediaFormat.KEY_MIME, format.sampleMimeType)
    if (format.channelCount > 0) {
      mf.setInteger(MediaFormat.KEY_CHANNEL_COUNT, format.channelCount)
    }
    if (format.sampleRate > 0) {
      mf.setInteger(MediaFormat.KEY_SAMPLE_RATE, format.sampleRate)
    }
    format.initializationData.forEachIndexed { i, csd ->
      mf.setByteBuffer("csd-$i", ByteBuffer.wrap(csd))
    }
    return mf
  }

  /**
   * Raw `[up, down]` RMS windows over a little-endian PCM buffer — the
   * shared scan `bucket` runs on the whole-file spill and each decoded
   * sample runs on its own window: stereo+ feeds even channels to `up`
   * and odd to `down`; mono splits by sign. Returns `count` pairs.
   */
  private fun rmsWindows(
    buf: ByteBuffer,
    pcmBytes: Long,
    channels: Int,
    floatPcm: Boolean,
    count: Int,
    job: Job?,
  ): List<Double> {
    val out = ArrayList<Double>(count * 2)
    if (count <= 0 || channels <= 0 || pcmBytes <= 0) {
      return out
    }
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
      job?.ensureActive()
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
    return out
  }

  /** Sparse → dense: unmeasured buckets take their nearest measured
   *  neighbor (ties prefer the earlier one — a seek bar reads
   *  left-to-right). All-empty input is honest zeros. Callers hold
   *  the sparse lock. */
  private fun fillFlat(
    sparse: Array<DoubleArray?>,
    count: Int,
  ): List<Double> {
    val out = ArrayList<Double>(count * 2)
    for (i in 0 until count) {
      var w = sparse[i]
      if (w === null) {
        var d = 1
        while (d < count) {
          val a = if (i - d >= 0) sparse[i - d] else null
          if (a !== null) {
            w = a
            break
          }
          val b = if (i + d < count) sparse[i + d] else null
          if (b !== null) {
            w = b
            break
          }
          d += 1
        }
      }
      out.add(w?.get(0) ?: 0.0)
      out.add(w?.get(1) ?: 0.0)
    }
    return out
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
      val (track, format) = (0 until extractor.trackCount)
        .firstNotNullOfOrNull { i ->
          extractor.getTrackFormat(i).takeIf {
            it.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
          }?.let { i to it }
        }
        ?: throw CodedException("invalid-response", "no audio track", null)
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
                // A file channel may short-write — keep draining the
                // buffer so pcmBytes only ever counts bytes on disk.
                while (buf.hasRemaining()) {
                  val n = pcmOut?.write(buf) ?: 0
                  if (n <= 0) {
                    throw CodedException(
                      "unavailable", "peak spill file write stalled", null
                    )
                  }
                  pcmBytes += n
                }
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
    } catch (e: Exception) {
      if (e is CodedException || e is CancellationException) throw e
      throw CodedException(
        "invalid-response", e.message ?: "audio decode failed", e
      )
    } finally {
      quiet("codec stop") { codec?.stop() }
      quiet("codec release") { codec?.release() }
      extractor.release()
      quiet("pcm spill close") { pcmOut?.close() }
    }
  }

  private fun quiet(what: String, block: () -> Unit) {
    try {
      block()
    } catch (e: Exception) {
      Log.i(TAG, "$what: ${e.message}")
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
    job: Job?,
  ): List<Double> {
    // Reject before the eager allocation — the seam validates
    // `count`, but a bogus direct call must not size the list from it.
    if (count <= 0 || channels <= 0 || pcmBytes <= 0) {
      return emptyList()
    }
    FileInputStream(pcmFile).channel.use { ch ->
      val buf = ch.map(FileChannel.MapMode.READ_ONLY, 0, pcmBytes)
        .order(ByteOrder.LITTLE_ENDIAN)
      return rmsWindows(buf, pcmBytes, channels, floatPcm, count, job)
    }
  }

  private fun formatInt(format: MediaFormat, key: String): Int? =
    if (!format.containsKey(key)) null
    else try {
      format.getInteger(key)
    } catch (_: Exception) {
      null
    }

  private fun formatLong(format: MediaFormat, key: String): Long? =
    if (!format.containsKey(key)) null
    else try {
      format.getLong(key)
    } catch (_: Exception) {
      null
    }

  /** Seam failures → the ABI kind the JS adapter maps — the same table
   *  the desktop port's `toError` applies. */
  private fun seamError(e: StreamException): CodedException {
    return CodedException(seamKind(e), e.message, e)
  }
}

/** The seam's kind mapping at file scope — probe readers below the
 *  peaks class need the same table to keep a refusal's own kind. */
private fun seamKind(e: StreamException): String {
  return when {
    e !is StreamException.Failed -> "unavailable"
    e.kind in DEAD_HANDLE_KINDS -> "released"
    e.kind in INVALID_RESPONSE_KINDS -> "invalid-response"
    else -> "transient"
  }
}

/** In-memory positional source for `MediaExtractor` over the pulled
 *  encoded bytes — the stream seam's own contract shape. */
private class ByteArrayMediaDataSource(
  private val bytes: ByteArray,
) : MediaDataSource() {
  override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
    if (position < 0 || position >= bytes.size.toLong()) return -1
    // Long→Int narrowing is safe past this guard: n ≤ size and
    // position < bytes.size, both under Int.MAX_VALUE.
    val n = minOf(size.toLong(), bytes.size.toLong() - position).toInt()
    if (n <= 0) return -1
    System.arraycopy(bytes, position.toInt(), buffer, offset, n)
    return n
  }

  override fun getSize(): Long = bytes.size.toLong()

  override fun close() {}
}

/** An encoded sample awaiting the codec — its presentation time and
 *  whole payload, demuxed by the bundled extractor. */
private class QueuedSample(
  val timeUs: Long,
  val data: ByteArray,
)

/** The ExtractorOutput side of a bundled parse: the first audio
 *  track's format + the SeekMap's duration land as state, and every
 *  demuxed access unit queues as a QueuedSample for the window's
 *  codec loop. Non-audio tracks discard. */
private class SampleQueue : ExtractorOutput {
  var audioFormat: Format? = null
  var durationUs = -1L
  var seekable = false
  var seekMap: SeekMap? = null
  val samples = ArrayDeque<QueuedSample>()

  override fun track(id: Int, type: Int): TrackOutput {
    if (type != C.TRACK_TYPE_AUDIO) {
      return DiscardingTrackOutput()
    }
    return object : TrackOutput {
      // Per-track accumulation — sampleData may arrive split and must
      // assemble whole before sampleMetadata stamps the boundary.
      private val cur = ByteArrayOutputStream(8192)

      override fun format(format: Format) {
        if (audioFormat === null) {
          audioFormat = format
        }
      }

      override fun sampleData(
        input: DataReader,
        length: Int,
        allowEndOfInput: Boolean,
        sampleDataPart: Int,
      ): Int {
        val scratch = ByteArray(minOf(length, 64 * 1024))
        var done = 0
        while (done < length) {
          val n = input.read(scratch, 0, minOf(scratch.size, length - done))
          if (n <= 0) {
            break
          }
          cur.write(scratch, 0, n)
          done += n
        }
        return done
      }

      override fun sampleData(
        data: ParsableByteArray,
        length: Int,
        sampleDataPart: Int,
      ) {
        val b = ByteArray(length)
        data.readBytes(b, 0, length)
        cur.write(b)
      }

      override fun sampleMetadata(
        timeUs: Long,
        flags: Int,
        size: Int,
        offset: Int,
        cryptoData: TrackOutput.CryptoData?,
      ) {
        samples.addLast(QueuedSample(timeUs, cur.toByteArray()))
        cur.reset()
      }
    }
  }

  override fun endTracks() {}

  override fun seekMap(seekMap: SeekMap) {
    this.seekMap = seekMap
    durationUs = seekMap.durationUs
    seekable = seekMap.isSeekable
  }
}

/**
 * Sequential DataReader over `streamProbe` — the bundled extractor's
 * `DefaultExtractorInput` drives it with small sequential reads, so a
 * fetched window is held and misses become the next ranged GET of
 * `windowBytes`. `position` is the cursor `seek` moves via RESULT_SEEK
 * handling in the caller. A failed probe counts one strike and dies
 * after `PROBE_MAX_STRIKES` in a row — a lone 429 or stalled reply
 * abandons the point, not the lane — while `refused` records for the
 * caller that the session itself said no. Past `budget` it fails
 * closed (EOF) — a runaway scan dies instead of pulling the whole
 * file for a decoration.
 */
private class ProbeDataReader(
  private val host: PluginHost,
  private val handle: String,
  private val size: Long,
  private val budget: AtomicLong,
  private val calls: AtomicLong,
  private val windowBytes: Long,
  private val refused: AtomicReference<String?>,
) : DataReader {
  var position = 0L

  // The last probe's payload — the parser's reads are small and many,
  // so reads inside the held window never cross the JNI seam.
  private var winStart = -1L
  private var win = ByteArray(0)
  private var dead = false
  private var strikes = 0

  /** This source's own probe traffic — the shared `budget` counts
   *  payload across all lanes, these two attribute it per window. */
  val srcFetched = AtomicLong(0)
  val srcCalls = AtomicLong(0)

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (position < 0 || position >= size || dead ||
      budget.get() >= PROBE_BUDGET_BYTES
    ) {
      return -1
    }
    val winEnd = winStart + win.size
    if (winStart >= 0 && position >= winStart && position < winEnd) {
      val n = minOf(length.toLong(), winEnd - position).toInt()
      System.arraycopy(win, (position - winStart).toInt(), buffer, offset, n)
      position += n
      return n
    }
    val want = minOf(size - position, windowBytes).toULong()
    val result = try {
      host.streamProbe(handle, position.toULong(), want, true)
    } catch (e: StreamException) {
      // First refusal keeps its seam kind — a terminal kind (dead
      // handle, invalid-response) must not decay to `transient` and
      // retry a session that cannot serve.
      refused.compareAndSet(null, seamKind(e))
      if (++strikes >= PROBE_MAX_STRIKES) {
        dead = true
      }
      return -1
    } catch (_: Exception) {
      refused.compareAndSet(null, "transient")
      if (++strikes >= PROBE_MAX_STRIKES) {
        dead = true
      }
      return -1
    }
    if (result.data.isEmpty()) {
      // A refused or empty probe reports EOF to the parser — the
      // sweep counts fewer measured windows, never fabricated ones.
      refused.compareAndSet(null, "transient")
      if (++strikes >= PROBE_MAX_STRIKES) {
        dead = true
      }
      return -1
    }
    strikes = 0
    calls.incrementAndGet()
    srcCalls.incrementAndGet()
    budget.addAndGet(result.data.size.toLong())
    srcFetched.addAndGet(result.data.size.toLong())
    winStart = position
    win = result.data
    val n = minOf(length, result.data.size)
    System.arraycopy(result.data, 0, buffer, offset, n)
    position += n
    return n
  }
}
