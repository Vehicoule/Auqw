@file:OptIn(UnstableApi::class)

package expo.modules.auqwexpo

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
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
import java.util.TreeMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
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
/** Decoration, not analysis — the same encoded pull cap as the desktop port. */
private const val MAX_PEAK_BYTES = 24 * 1024 * 1024
/** Post-decode belt — matches the desktop port's PCM ceiling. */
private const val MAX_PCM_BYTES = 256 * 1024 * 1024
/** Whole-decode deadline — a wedged codec never owns the sweep. */
private const val DECODE_DEADLINE_MS = 60_000L
/** Bound on pending cancel tombstones — see `cancels`. */
private const val MAX_TOMBSTONES = 64
private const val DEQUEUE_US = 10_000L

/* ---- streamed extraction bounds -------------------------------------------
 * `streamProbe` reads are bounded ranged fetches that commit into the
 * session's sparse store — every fetched byte is real media data the
 * player serves for free, never a discarded duplicate. Extraction runs
 * as parallel contiguous stripe pulls feeding one forward decode lane,
 * so the sweep completes in lockstep with the bytes the track itself
 * needs instead of paying a scattered round-trip per sampled window.
 */
/** Head probe: learns the stream total and commits the container head —
 *  the extractor's sniff + header reads then serve off committed bytes. */
private const val HEAD_PROBE_BYTES = 256 * 1024
/** Per-probe pull bound — the seam clamps each probe at its own
 *  `chunk_bytes`, so a lane never asks for more than one ranged GET. */
private const val PULL_CHUNK_BYTES = 256 * 1024
/** Parallel contiguous stripe pulls; the seam's probe issues its own
 *  ranged GET rather than queueing on the pump's fill lane, so lanes
 *  overlap wire latency. */
private const val PULL_LANES = 4
/** Smallest stripe worth a lane of its own — below it a sequential lane
 *  beats splitting (fewer probes, no join). */
private const val STRIPE_MIN_BYTES = 512 * 1024
/** Consecutive refused or empty probes before a lane abandons its
 *  stripe — one stalled or rate-limited reply must not kill it. */
private const val LANE_MAX_STRIKES = 3
/** Backoff between a lane's probe retries — a refusal is usually a
 *  provider cooldown; the tracker's own retry heals what three strikes
 *  cannot. */
private const val LANE_STRIKE_BACKOFF_MS = 120L
/** RMS accumulation granularity — slices fold into `count` windows at
 *  emit, so the decode lane never needs the duration early. A slice
 *  straddling a window boundary lands by midpoint (~25 ms of blur, far
 *  under one bucket's width). */
private const val SLICE_US = 50_000L
/** A coarse profile renders once this share of the stream has decoded —
 *  a contiguous-prefix measurement beats a sparse scatter of samples
 *  at the same coverage. */
private const val COARSE_FRACTION = 0.35
/** Leading-edge milestone: the coarse emit fires at the tighter of this
 *  pts bound and the fraction — the head fill is already committed at
 *  attach, so first real bars land at the pace of the first seconds of
 *  audio, not at a third of the track. */
private const val COARSE_LEAD_PTS_US = 20_000_000L
/** Parser pulls to land the audio track's format — container headers
 *  plus sniff retries. */
private const val FORMAT_PARSE_PULLS = 400
/** Consecutive demuxer reads that yield no placeable audio sample
 *  before the decode lane calls the parser stalled — an honest typed
 *  failure, never a silently-truncated profile. Sized well past the
 *  longest plausible non-audio interleave an audio-bearing container
 *  can carry; audio-only streams land samples every read. */
private const val PARSE_STALL_PULLS = 2000
/** Decorative decode bound — the JS port's `PEAKS_MAX_DECODE_MS`:
 *  tracks longer than this refuse extraction. The caller gates known
 *  durations; the decode lane re-gates on the PARSED duration so an
 *  unknown-duration stream can't produce a profile the same check
 *  would have refused. */
private const val PEAKS_MAX_DECODE_MS = 8L * 60 * 1000
/** Honest-settle slack: a finished decode's measured span may trail
 *  the demuxer-declared duration by at most the larger of this and a
 *  tenth of that duration — a bigger gap means the feed starved
 *  mid-track while bytes still arrived, and settling would let
 *  `fillFlat` clone the last measured bucket across an unmeasured
 *  tail the tracker would cache as real. The proportional share
 *  tolerates a container's overstated duration; the floor keeps the
 *  gate honest on short tracks. */
private const val SETTLE_TAIL_US = 2_000_000L

private val DEAD_HANDLE_KINDS = setOf(
  "released", "evicted", "expired", "superseded", "not-found"
)
private val INVALID_RESPONSE_KINDS = setOf(
  "invalid-request", "invalid-response", "invalid-message"
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
 * The streamed path borrows the playing stream's own `streamProbe` —
 * parallel contiguous stripe pulls each issuing bounded ranged GETs
 * that commit into the session's sparse store, so extraction costs
 * only the wire latency the track itself needs and every fetched byte
 * is player prefetch. A single forward demux+decode lane folds PCM
 * into 50 ms RMS slices as bytes land — nothing seeks, nothing waits
 * on whole-file delivery, and cancellation unwinds without leaving
 * fetch-through demand competing with the player's reads.
 * `provider:'local'` (lf-*) handles never reach the seam — they resolve
 * to their file/content URI and decode straight off disk.
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
   * Pull → decode → bucket. Returns `count` flat `[up, down]` pairs of
   * raw RMS magnitudes. Every failure is a typed [CodedException] whose
   * code is the application kind (`unavailable` for an unsupported PCM
   * encoding or a wedged codec, `released` for a dead handle,
   * `budget-exceeded` over caps, `not-applicable` for the provisional
   * unknown-duration cap, `invalid-response` for undecodable bytes,
   * `cancelled` on cancel).
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
    // alongside the player. Only the local-file path uses it — the
    // streamed path accumulates RMS straight off the codec.
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
      if (local === null) {
        val host = registry.hostFor(handle)
          ?: throw CodedException("released", "unknown stream handle", null)
        return streamedStream(
          requestId, host, handle, count, cap, provisionalCap, onCoarse
        )
      }
      if (local.bytes > cap) {
        throw CodedException(
          if (provisionalCap) "not-applicable" else "budget-exceeded",
          "audio too large for peak extraction",
          null
        )
      }
      val decodeStart = SystemClock.uptimeMillis()
      val decoded = decodePcm(
        { it.setDataSource(local.context, local.uri, null) },
        cap, provisionalCap, pcmFile
      )
      Log.i(
        TAG,
        "peaks[$requestId] decode " +
          "+${SystemClock.uptimeMillis() - decodeStart}ms pcm=${decoded.bytes}"
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

  /* ---- streamed extraction --------------------------------------------------
   * Whole-file arrival at wire pace: a head probe learns the total,
   * contiguous stripes pull the rest in parallel ranged GETs (each
   * committed into the session's sparse store — player prefetch), and
   * a forward demux+decode lane over a blocking sparse reader folds
   * PCM into per-slice RMS as the bytes land. No seeks, no probe-per-
   * window scatter, no PCM spill file.
   */

  /**
   * Returns the flat `[up, down]` pair list. Throws the seam's typed
   * kind on every failure — a lane that abandons truncates the decode
   * at its dead hole; whatever bars were measured still emit as the
   * coarse profile before the throw, so a retry (the tracker's own
   * healing path) re-probes off committed hits instead of starting
   * cold.
   */
  private suspend fun streamedStream(
    requestId: String,
    host: PluginHost,
    handle: String,
    count: Int,
    cap: Long,
    provisionalCap: Boolean,
    onCoarse: ((List<Double>) -> Unit)?,
  ): List<Double> {
    val t0 = SystemClock.uptimeMillis()
    val probeRefused = AtomicReference<String?>(null)
    val head = try {
      withContext(Dispatchers.IO) {
        host.streamProbe(handle, 0uL, HEAD_PROBE_BYTES.toULong(), true)
      }
    } catch (e: StreamException) {
      throw seamError(e)
    }
    if (head.eof && head.data.isEmpty()) {
      throw CodedException("invalid-response", "empty stream", null)
    }
    val total = head.total?.toLong() ?: -1L
    if (total > cap) {
      throw CodedException(
        if (provisionalCap) "not-applicable" else "budget-exceeded",
        "audio too large for peak extraction",
        null
      )
    }
    // `end` bounds both the stripes and the buffer's completion check:
    // a known total clamps at the cap (already gated above); an unknown
    // total runs one open-ended lane until a confirmed EOF or the cap.
    val end = if (total > 0) minOf(total, cap) else cap
    val buf = PullBuffer(end)
    if (head.data.isNotEmpty()) {
      buf.put(0L, head.data)
      buf.observeTotal(total)
    }
    Log.i(
      TAG,
      "peaks[$requestId] head-probe +${SystemClock.uptimeMillis() - t0}ms " +
        "total=$total head=${head.data.size}"
    )

    val slices = TreeMap<Long, DoubleArray>()
    val durationUs = AtomicLong(-1L)
    val lastPtsUs = AtomicLong(-1L)
    val coarseSent = AtomicBoolean(false)
    // `slices` is written on the decode lane and folded on it (coarse)
    // or after it (final/abort emit) — no lock needed.
    val buildFlat = {
      val dur = durationUs.get().takeIf { it > 0 } ?: lastPtsUs.get()
      // Zero slices = zero measured audio — a container that publishes
      // only its duration must not emit a fabricated flat baseline as a
      // finished waveform. Decoded-silent PCM still lands slices, so
      // measured silence keeps its honest zeros.
      if (dur <= 0 || slices.isEmpty()) {
        null
      } else {
        fillFlat(foldSlices(slices, count, dur), count)
      }
    }
    val emitCoarse = {
      // Fold first: a null profile (duration never landed, nothing
      // decoded yet) must not burn the one-shot emit flag.
      val flat = buildFlat()
      if (flat !== null && coarseSent.compareAndSet(false, true)) {
        try {
          onCoarse?.invoke(flat)
        } catch (_: Exception) {
          Log.w(TAG, "peaks[$requestId] coarse emit failed")
        }
        Log.i(
          TAG,
          "peaks[$requestId] coarse " +
            "+${SystemClock.uptimeMillis() - t0}ms"
        )
      }
    }
    val maybeCoarse = {
      val dur = durationUs.get()
      if (dur > 0 && !coarseSent.get() &&
        lastPtsUs.get() >=
          minOf(COARSE_LEAD_PTS_US, (dur * COARSE_FRACTION).toLong())
      ) {
        emitCoarse()
      }
    }

    // Stripes: [headSize, end) split over lanes only when wide enough —
    // an unknown total runs one open-ended lane until EOF or the cap.
    val start = head.data.size.toLong()
    val laneCount = if (total > 0) {
      minOf(
        PULL_LANES,
        maxOf(1, ceil((end - start).toDouble() / STRIPE_MIN_BYTES).toInt())
      )
    } else {
      1
    }
    val stripe = if (end > start) {
      ceil((end - start).toDouble() / laneCount).toLong()
    } else {
      0L
    }
    var decodeError: Exception? = null
    coroutineScope {
      val pullers = (0 until laneCount).map { lane ->
        val lo = start + lane * stripe
        val hi = minOf(lo + stripe, end)
        async(Dispatchers.IO) {
          pullLane(
            host, handle, buf, lo, hi,
            total <= 0, provisionalCap, probeRefused
          )
        }
      }
      val decoding = async(Dispatchers.IO) {
        streamDecode(
          buf, total, count, slices, durationUs, lastPtsUs,
          maybeCoarse
        )
      }
      // A lane's typed failure propagates through `await` — the scope
      // cancels the decode lane and sibling stripes; a lane that
      // abandons returns normally after marking its hole dead. The
      // decode lane's own failure is captured, not thrown yet: an
      // incomplete pull means the pull's refusal is the honest cause.
      pullers.forEach { it.await() }
      buf.markPullDone()
      try {
        decoding.await()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        decodeError = e
      }
    }

    if (!buf.pullComplete()) {
      // A lane abandoned: decode stopped at the dead hole. Emit what
      // was measured (prefix bars are honest) and surface a typed
      // failure so the tracker's retry heals off committed bytes —
      // hits on the next attempt return instantly. The pull's refusal
      // kind wins over whatever the starved decode surfaced.
      emitCoarse()
      throw CodedException(
        probeRefused.get() ?: "transient",
        "stream pull stopped before end of stream",
        null
      )
    }
    decodeError?.let { throw it }
    val dur = durationUs.get()
    if (dur > 0 && dur - lastPtsUs.get() > maxOf(SETTLE_TAIL_US, dur / 10)) {
      // pullComplete gates on byte coverage, not decode coverage: a
      // feed that starved mid-track still arrives here with every
      // byte committed, and fillFlat would clone the last measured
      // bucket across the unmeasured tail as a finished profile the
      // tracker caches forever. Emit the honest prefix as coarse and
      // fail typed so the retry re-measures rather than persisting
      // the fabrication.
      emitCoarse()
      throw CodedException(
        "invalid-response",
        "decode settled short of the stream's duration",
        null
      )
    }
    val flat = buildFlat()
      ?: throw CodedException("invalid-response", "no decodable audio", null)
    Log.i(
      TAG,
      "peaks[$requestId] streamed-done +${SystemClock.uptimeMillis() - t0}ms " +
        "slices=${slices.size} fetched=${buf.fetchedBytes.get()} " +
        "probes=${buf.probeCalls.get()}"
    )
    return flat
  }

  /** One stripe's sequential probe pull: bounded ranged GETs from `lo`
   *  to `hi`, each committed into the shared sparse store (player
   *  prefetch). A refused or empty probe retries with a short backoff;
   *  three in a row abandons the stripe — the decode lane ends at the
   *  dead hole and the caller's typed failure lets the tracker retry
   *  re-probe off committed hits. `openEnded` (unknown total) reaching
   *  `hi` without a confirmed EOF means the stream outruns the cap —
   *  the same size refusal the local path applies. */
  private suspend fun pullLane(
    host: PluginHost,
    handle: String,
    buf: PullBuffer,
    lo: Long,
    hi: Long,
    openEnded: Boolean,
    provisionalCap: Boolean,
    probeRefused: AtomicReference<String?>,
  ) {
    var pos = lo
    var strikes = 0
    while (pos < hi) {
      coroutineContext.ensureActive()
      // Another lane already died — bytes past its hole can never be
      // decoded, so this stripe stops spending probes on them.
      if (buf.aborted) return
      val want = minOf(PULL_CHUNK_BYTES.toLong(), hi - pos)
      val res = try {
        host.streamProbe(handle, pos.toULong(), want.toULong(), true)
      } catch (e: StreamException) {
        recordRefusal(probeRefused, seamKind(e))
        if (++strikes >= LANE_MAX_STRIKES) {
          buf.abandonFrom(pos)
          return
        }
        delay(LANE_STRIKE_BACKOFF_MS * strikes)
        continue
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        recordRefusal(probeRefused, "transient")
        if (++strikes >= LANE_MAX_STRIKES) {
          buf.abandonFrom(pos)
          return
        }
        delay(LANE_STRIKE_BACKOFF_MS * strikes)
        continue
      }
      buf.probeCalls.incrementAndGet()
      if (res.data.isEmpty()) {
        if (res.eof) {
          buf.observeEof(pos)
          return
        }
        // A fetch on a hole returned nothing — a refusal without a
        // classified kind; strike and retry rather than fabricate EOF.
        recordRefusal(probeRefused, "transient")
        if (++strikes >= LANE_MAX_STRIKES) {
          buf.abandonFrom(pos)
          return
        }
        delay(LANE_STRIKE_BACKOFF_MS * strikes)
        continue
      }
      buf.put(pos, res.data)
      buf.fetchedBytes.addAndGet(res.data.size.toLong())
      pos += res.data.size
      res.total?.let { buf.observeTotal(it.toLong()) }
      if (res.eof) {
        buf.observeEof(pos)
        return
      }
      strikes = 0
    }
    if (openEnded) {
      // Unknown-total lane reached the cap without ever seeing EOF —
      // the stream is larger than the decorative bound.
      throw CodedException(
        if (provisionalCap) "not-applicable" else "budget-exceeded",
        "stream too large for peak extraction",
        null
      )
    }
  }

  /** Forward demux+decode over the pull buffer — the bundled extractor
   *  drives a blocking sparse reader that parks on uncommitted holes
   *  until a stripe lands them (or the pull ends/abandons → EOF). Each
   *  decoded buffer folds straight into `slices` by presentation time
   *  so no PCM ever spills to disk; `maybeCoarse` fires once past the
   *  coarse fraction. End-of-input means truly drained (pull done) or
   *  truncated at a dead hole — the caller checks `buf.pullComplete`. */
  private suspend fun streamDecode(
    buf: PullBuffer,
    total: Long,
    count: Int,
    slices: TreeMap<Long, DoubleArray>,
    durationUs: AtomicLong,
    lastPtsUs: AtomicLong,
    maybeCoarse: () -> Unit,
  ) {
    // The decode lane's OWN job — a cancelled scope (puller failure,
    // tracker cancel) must unwind a reader parked on the frontier,
    // which is exactly where the coroutine's ensureActive can't reach.
    val self = coroutineContext[Job]
    val reader = PullReader(buf) { self?.isActive != false }
    val pump = SampleQueue()
    val adapter = BundledExtractorsAdapter(DefaultExtractorsFactory())
    var codec: MediaCodec? = null
    try {
      adapter.init(
        reader, Uri.EMPTY, emptyMap(), 0L,
        if (total > 0) total else C.LENGTH_UNSET.toLong(), pump
      )
      val ph = PositionHolder()
      var pulls = 0
      while (pump.audioFormat === null && pulls++ < FORMAT_PARSE_PULLS) {
        coroutineContext.ensureActive()
        when (adapter.read(ph)) {
          Extractor.RESULT_SEEK ->
            reposition(reader, adapter, pump, ph.position, total)
          Extractor.RESULT_END_OF_INPUT -> break
        }
      }
      val format = pump.audioFormat
        ?: throw CodedException("invalid-response", "no audio track", null)
      val mime = format.sampleMimeType
        ?: throw CodedException("invalid-response", "audio track has no mime", null)
      val decoder = try {
        MediaCodec.createDecoderByType(mime)
      } catch (e: Exception) {
        throw CodedException("invalid-response", "no decoder for $mime", e)
      }
      codec = decoder
      decoder.configure(codecFormat(format), null, null, 0)
      decoder.start()
      var channels = format.channelCount
      var sampleRate = format.sampleRate
      var pcmEncoding = AudioFormat.ENCODING_PCM_16BIT
      var pcmBytes = 0L
      val info = MediaCodec.BufferInfo()
      var inputEOS = false
      var outputEOS = false
      var parseEnded = false
      val deadline = SystemClock.uptimeMillis() + DECODE_DEADLINE_MS
      while (!outputEOS) {
        coroutineContext.ensureActive()
        if (SystemClock.uptimeMillis() > deadline) {
          throw CodedException("unavailable", "audio decode timed out", null)
        }
        if (!inputEOS) {
          val inIdx = decoder.dequeueInputBuffer(DEQUEUE_US)
          if (inIdx >= 0) {
            var s = pump.samples.removeFirstOrNull()
            var stalePulls = 0
            while (s === null || s.timeUs < 0) {
              if (s !== null) {
                // Untimestamped access unit — unplaceable, drop it and
                // keep pulling rather than feed the codec a lie. The
                // drop also applies at parse end: trailing junk at the
                // queue head is not end-of-input while timestamped
                // units may still sit behind it.
                s = pump.samples.removeFirstOrNull()
                continue
              }
              if (parseEnded) break
              // Reads keep flowing while the demuxer still owes audio —
              // a bounded stall guard, never a silent EOS on a
              // non-ended parser: a truncated-at-limit profile would
              // persist the measured prefix as if it were the whole.
              if (++stalePulls > PARSE_STALL_PULLS) {
                throw CodedException(
                  "invalid-response",
                  "demuxer produced no audio samples",
                  null
                )
              }
              when (adapter.read(ph)) {
                Extractor.RESULT_SEEK ->
                  reposition(reader, adapter, pump, ph.position, total)
                Extractor.RESULT_END_OF_INPUT -> parseEnded = true
              }
              s = pump.samples.removeFirstOrNull()
            }
            // Past the loop the sample is either a timestamped access
            // unit or null at a drained, ended parse — the only true
            // end-of-input. An unfeedable unit is neither.
            val ib = decoder.getInputBuffer(inIdx)
            if (s === null) {
              decoder.queueInputBuffer(
                inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              inputEOS = true
            } else if (ib === null) {
              // A dequeued slot with no buffer is a wedged codec, not
              // a drained queue — typed failure, never a quiet EOS.
              throw CodedException(
                "unavailable", "codec input buffer lost", null
              )
            } else if (ib.remaining() < s.data.size) {
              // An access unit too large for the vendor input slot can
              // never be fed — drop it and hand the slot back empty
              // rather than fake end-of-stream mid-track. If the drops
              // starve the measured span the settle gate below refuses
              // the truncated profile instead of fabricating its tail.
              Log.w(
                TAG,
                "dropped unfeedable access unit " +
                  "bytes=${s.data.size} slot=${ib.remaining()}"
              )
              decoder.queueInputBuffer(inIdx, 0, 0, 0, 0)
            } else {
              ib.put(s.data)
              decoder.queueInputBuffer(inIdx, 0, s.data.size, s.timeUs, 0)
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
              throw CodedException(
                "unavailable", "unsupported PCM encoding $pcmEncoding", null
              )
            }
          }
          outIdx >= 0 -> {
            if (info.size > 0) {
              if (pcmBytes + info.size > MAX_PCM_BYTES) {
                throw CodedException(
                  "budget-exceeded", "decoded audio too large for peaks", null
                )
              }
              pcmBytes += info.size
              val ob = decoder.getOutputBuffer(outIdx)
              if (ob !== null && channels > 0 && sampleRate > 0) {
                ob.position(info.offset)
                ob.limit(info.offset + info.size)
                accumPcm(
                  slices, info.presentationTimeUs, ob,
                  channels, sampleRate,
                  pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT
                )
              }
              lastPtsUs.updateAndGet { maxOf(it, info.presentationTimeUs) }
            }
            decoder.releaseOutputBuffer(outIdx, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
              outputEOS = true
            }
          }
        }
        // The SeekMap may land mid-parse — duration settles whenever
        // the container publishes it.
        val dur = pump.durationUs
        if (dur > 0) {
          if (dur > PEAKS_MAX_DECODE_MS * 1000) {
            throw CodedException(
              "budget-exceeded", "track too long for decorative peaks", null
            )
          }
          durationUs.set(dur)
        }
        maybeCoarse()
      }
    } catch (e: CodedException) {
      throw e
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      throw CodedException(
        "invalid-response", e.message ?: "audio decode failed", e
      )
    } finally {
      quiet("decode codec stop") { codec?.stop() }
      quiet("decode codec release") { codec?.release() }
      quiet("decode extractor release") { adapter.release() }
    }
  }

  /**
   * Honor a RESULT_SEEK: re-anchor the pull reader at the parser's
   * requested byte offset AND re-init the adapter there. `init`
   * always swaps in a fresh DefaultExtractorInput (it only sniffs
   * when no extractor was picked yet), so the stale peek buffer the
   * old input carried can never splice head bytes onto the new
   * stream position. Samples queued from the old position are stale —
   * drop them rather than feed the codec pre-seek access units.
   */
  private fun reposition(
    reader: PullReader,
    adapter: BundledExtractorsAdapter,
    pump: SampleQueue,
    position: Long,
    total: Long,
  ) {
    pump.samples.clear()
    reader.position = position
    adapter.init(
      reader, Uri.EMPTY, emptyMap(), position,
      if (total > 0) total - position else C.LENGTH_UNSET.toLong(), pump
    )
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

  /** Fold one decoded PCM buffer into `slices`: every frame's squared
   *  magnitude accumulates under its 50 ms media slice — stereo+ feeds
   *  even channels to `up` and odd to `down`, mono splits by sign —
   *  the same split `rmsWindows` applies to whole-file PCM. Runs on
   *  the decode lane only, so `slices` needs no lock. */
  private fun accumPcm(
    slices: TreeMap<Long, DoubleArray>,
    ptsUs: Long,
    buf: ByteBuffer,
    channels: Int,
    sampleRate: Int,
    floatPcm: Boolean,
  ) {
    if (ptsUs < 0 || channels <= 0 || sampleRate <= 0) return
    val stereo = channels >= 2
    val bps = if (floatPcm) 4 else 2
    val frames = buf.remaining() / (channels * bps)
    if (frames <= 0) return
    val sample: (Int) -> Double
    if (floatPcm) {
      val floats = buf.order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
      sample = { i -> floats.get(i).toDouble() }
    } else {
      val shorts = buf.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      sample = { i -> shorts.get(i).toDouble() / 32768.0 }
    }
    val frameUs = 1_000_000.0 / sampleRate
    var us = ptsUs.toDouble()
    var acc = slices.getOrPut(us.toLong() / SLICE_US) { DoubleArray(4) }
    var nextSliceUs = ((us.toLong() / SLICE_US) + 1).toDouble() * SLICE_US
    for (f in 0 until frames) {
      if (us >= nextSliceUs) {
        val idx = us.toLong() / SLICE_US
        acc = slices.getOrPut(idx) { DoubleArray(4) }
        nextSliceUs = (idx + 1).toDouble() * SLICE_US
      }
      val base = f * channels
      if (stereo) {
        var c = 0
        while (c < channels) {
          val v = sample(base + c)
          if (c % 2 == 0) {
            acc[0] += v * v
            acc[1] += 1
          } else {
            acc[2] += v * v
            acc[3] += 1
          }
          c += 1
        }
      } else {
        val v = sample(base)
        if (v >= 0) {
          acc[0] += v * v
          acc[1] += 1
        } else {
          acc[2] += v * v
          acc[3] += 1
        }
      }
      us += frameUs
    }
  }

  /** Fold 50 ms slices into `count` sparse `[up, down]` windows — a
   *  slice lands in the window containing its midpoint, sum-of-squares
   *  merged first so the RMS root is taken once per window. */
  private fun foldSlices(
    slices: Map<Long, DoubleArray>,
    count: Int,
    durationUs: Long,
  ): Array<DoubleArray?> {
    val sparse = arrayOfNulls<DoubleArray>(count)
    if (count <= 0 || durationUs <= 0) {
      return sparse
    }
    val bucketUs = durationUs.toDouble() / count
    for ((idx, a) in slices) {
      val w = ((idx * SLICE_US + SLICE_US / 2) / bucketUs)
        .toInt().coerceIn(0, count - 1)
      val prev = sparse[w]
      if (prev === null) {
        sparse[w] = a.copyOf()
      } else {
        prev[0] += a[0]
        prev[1] += a[1]
        prev[2] += a[2]
        prev[3] += a[3]
      }
    }
    for (i in sparse.indices) {
      val a = sparse[i] ?: continue
      sparse[i] = doubleArrayOf(
        if (a[1] > 0) sqrt(a[0] / a[1]) else 0.0,
        if (a[3] > 0) sqrt(a[2] / a[3]) else 0.0
      )
    }
    return sparse
  }

  /** MediaExtractor + MediaCodec over a local file/content URI → PCM
   *  spilled to `pcmFile` (never the heap — a long stereo track is
   *  ~92 MiB of PCM alongside the player), plus the negotiated shape
   *  the bucketer needs. `encodedCap` bounds consumed compressed
   *  bytes for sources whose size was unknown (local paths that
   *  couldn't be stat'ed). */
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

  /**
   * Raw `[up, down]` RMS windows over a little-endian PCM buffer —
   * stereo+ feeds even channels to `up` and odd to `down`; mono splits
   * by sign. Returns `count` pairs.
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
   *  left-to-right). All-empty input is honest zeros. */
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

  private fun formatInt(format: MediaFormat, key: String): Int? =
    if (!format.containsKey(key)) null
    else try {
      format.getInteger(key)
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

/** Refusal kinds a retry can't beat — a dead handle or a malformed
 *  response stays terminal even when an earlier lane only met retry
 *  weather. */
private val TERMINAL_REFUSAL_KINDS = setOf("released", "invalid-response")

/** Fold a probe refusal into the shared kind: first-wins among equally
 *  ranked kinds, but a terminal refusal always supersedes retryable
 *  evidence — a later invalid-response must not hide behind an earlier
 *  lane's 429 and retry a session that cannot serve. */
private fun recordRefusal(ref: AtomicReference<String?>, kind: String) {
  ref.updateAndGet { cur ->
    when {
      cur == null -> kind
      cur in TERMINAL_REFUSAL_KINDS -> cur
      kind in TERMINAL_REFUSAL_KINDS -> kind
      else -> cur
    }
  }
}

/** An encoded sample awaiting the codec — its presentation time and
 *  whole payload, demuxed by the bundled extractor. */
internal class QueuedSample(
  val timeUs: Long,
  val data: ByteArray,
)

/** The ExtractorOutput side of a bundled parse: the first audio
 *  track's format + the SeekMap's duration land as state, and every
 *  demuxed access unit of THAT track queues as a QueuedSample for
 *  the decode loop. Non-audio tracks discard — and so does every
 *  audio track after the first: the shared queue feeds one codec
 *  configured for the first track's format, and a second track's
 *  access units must never reach it. The selection keys on the
 *  extractor's track id so a re-parse after a seek that re-emits
 *  the same id keeps feeding the same track. */
internal class SampleQueue : ExtractorOutput {
  var audioFormat: Format? = null
  var durationUs = -1L
  var seekable = false
  var seekMap: SeekMap? = null
  val samples = ArrayDeque<QueuedSample>()
  private var audioTrackId: Int? = null

  override fun track(id: Int, type: Int): TrackOutput {
    if (type != C.TRACK_TYPE_AUDIO) {
      return DiscardingTrackOutput()
    }
    val selected = audioTrackId
    if (selected !== null && selected != id) {
      return DiscardingTrackOutput()
    }
    audioTrackId = id
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

/** The stripe pool's shared sparse store: probe-fetched chunks keyed
 *  at their stream offset, a contiguous-prefix frontier the decode
 *  lane reads at, and the terminal conditions a blocked reader ends
 *  on — pull done, an abandoned hole, confirmed EOF, a known total
 *  passed, or the job cancelled. Bytes stay resident until the sweep
 *  ends: an extractor's internal seek may walk back into them, and at
 *  ≤ MAX_PEAK_BYTES they cost the same footprint the old whole-pull
 *  byte array took. */
internal class PullBuffer(
  private val end: Long,
) {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private val chunks = TreeMap<Long, ByteArray>()
  /** Longest unbroken [0, ·) coverage — the only region a forward
   *  reader may ever serve. */
  @Volatile var contiguousEnd = 0L
    private set
  /** Lowest stripe position a lane abandoned — decode truncates here
   *  because bytes past it can never be read in order anyway. */
  private val deadPos = AtomicLong(Long.MAX_VALUE)
  /** Lowest position a lane saw a confirmed EOF — an unknown total
   *  resolves here. */
  private val eofPos = AtomicLong(Long.MAX_VALUE)
  /** Every pull lane has exited — nothing more will ever commit. */
  @Volatile var pullDone = false
    private set
  @Volatile var knownTotal = -1L
    private set
  val probeCalls = AtomicLong(0)
  val fetchedBytes = AtomicLong(0)
  val aborted: Boolean get() = deadPos.get() != Long.MAX_VALUE

  fun put(position: Long, data: ByteArray) {
    if (data.isEmpty()) return
    lock.lock()
    try {
      chunks[position] = data
      // Extend the contiguous frontier while a chunk covers or starts
      // exactly at it — stripes are disjoint, so one floorEntry hop
      // per landed chunk is the whole walk.
      while (true) {
        val e = chunks.floorEntry(contiguousEnd) ?: break
        val eEnd = e.key + e.value.size
        if (eEnd <= contiguousEnd) break
        contiguousEnd = eEnd
      }
      changed.signalAll()
    } finally {
      lock.unlock()
    }
  }

  /** A lane gave up on `position` — readers end at the hole rather
   *  than park on bytes that will never arrive. */
  fun abandonFrom(position: Long) {
    deadPos.updateAndGet { minOf(it, position) }
    lock.lock()
    try {
      changed.signalAll()
    } finally {
      lock.unlock()
    }
  }

  /** A lane met a confirmed EOF at `position`. */
  fun observeEof(position: Long) {
    eofPos.updateAndGet { minOf(it, position) }
    lock.lock()
    try {
      changed.signalAll()
    } finally {
      lock.unlock()
    }
  }

  fun observeTotal(total: Long) {
    if (total > 0) {
      knownTotal = total
    }
  }

  /** All pull lanes exited — a blocked reader at the frontier is EOF
   *  for real, whether the frontier reached `end` or a hole died. */
  fun markPullDone() {
    pullDone = true
    lock.lock()
    try {
      changed.signalAll()
    } finally {
      lock.unlock()
    }
  }

  /** True when the sweep's bytes fully arrived — the frontier reached
   *  the bounded end or a lane saw a confirmed EOF inside it, with no
   *  dead hole anywhere before them (an abandoned stripe can never
   *  complete the prefix, whatever lands after it). */
  fun pullComplete(): Boolean =
    !aborted && (eofPos.get() != Long.MAX_VALUE || contiguousEnd >= end)

  /** Serve committed bytes at `position` — parks on an uncommitted
   *  hole until a stripe lands it or a terminal condition lands: pull
   *  done at the frontier, an abandoned hole, a confirmed EOF, the
   *  known total passed, or `alive` reporting the reader's coroutine
   *  dead (scope cancellation can't reach a parked wait any other
   *  way). Returns the byte count or -1 at end-of-input. */
  fun readAt(
    position: Long,
    buffer: ByteArray,
    offset: Int,
    length: Int,
    alive: () -> Boolean,
  ): Int {
    if (position < 0 || length <= 0) return -1
    while (true) {
      lock.lock()
      try {
        if (position < contiguousEnd) {
          var remaining = minOf(length.toLong(), contiguousEnd - position)
          var p = position
          var wrote = 0
          while (remaining > 0) {
            val e = chunks.floorEntry(p) ?: break
            val avail = e.key + e.value.size - p
            if (avail <= 0) break
            val n = minOf(remaining, avail).toInt()
            System.arraycopy(
              e.value, (p - e.key).toInt(), buffer, offset + wrote, n
            )
            p += n
            wrote += n
            remaining -= n
          }
          if (wrote > 0) return wrote
        }
        if (position >= deadPos.get() || position >= eofPos.get() ||
          pullDone ||
          (knownTotal > 0 && position >= knownTotal) ||
          !alive()
        ) {
          return -1
        }
        changed.await(50, TimeUnit.MILLISECONDS)
      } finally {
        lock.unlock()
      }
    }
  }
}

/** Blocking sequential reader over the pull buffer — the bundled
 *  extractor's DefaultExtractorInput drives it with small reads that
 *  park at the contiguous-prefix frontier until a stripe lands the
 *  bytes. `position` moves on adapter-initiated repositions. */
private class PullReader(
  private val buf: PullBuffer,
  private val alive: () -> Boolean,
) : DataReader {
  var position = 0L

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    val n = buf.readAt(position, buffer, offset, length, alive)
    if (n > 0) position += n
    return n
  }
}
