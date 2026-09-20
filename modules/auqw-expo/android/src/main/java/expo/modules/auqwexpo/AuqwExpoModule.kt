package expo.modules.auqwexpo

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.FileDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy.LoadErrorInfo
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.auqw_mobile_bindings.AttemptSummary
import uniffi.auqw_mobile_bindings.HostConfig
import uniffi.auqw_mobile_bindings.HostException
import uniffi.auqw_mobile_bindings.PluginHost
import uniffi.auqw_mobile_bindings.PrepareListener
import uniffi.auqw_mobile_bindings.PrepareOutcome
import uniffi.auqw_mobile_bindings.RequestListener
import uniffi.auqw_mobile_bindings.RequestOutcome
import uniffi.auqw_mobile_bindings.ResolveListener
import uniffi.auqw_mobile_bindings.ResolveOutcome
import uniffi.auqw_mobile_bindings.SpinReport
import uniffi.auqw_mobile_bindings.StreamException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val TAG = "AuqwExpo"
private const val EVENT_OUTCOME = "onResolveOutcome"
private const val EVENT_REQUEST_OUTCOME = "onRequestOutcome"
private const val EVENT_PREPARE_OUTCOME = "onPrepareOutcome"
private const val EVENT_PLAYBACK_STATUS = "onPlaybackStatus"
private const val EVENT_PHASE_MARK = "onPhaseMark"
private const val EVENT_QUEUE_TRANSITION = "onQueueTransition"
private const val BIND_TIMEOUT_MS = 5_000L
private const val REMOTE_PREVIOUS_RESTART_MS = 3_000L
private const val POSITION_TICK_MS = 1_000L

/** Cap on the released-handle marks — they only matter across the
 * queued-attach window, so a few hundred is far past any real case. */
private const val RELEASED_HANDLES_CAP = 512

class HostConfigInput : Record {
  @Field
  var fuelPerEntry: Double = 0.0

  @Field
  var fuelTotal: Double = 0.0

  @Field
  var potProviderUrl: String? = null

  /** Optional overrides — both default to app-private dirs below. */
  @Field
  var statePath: String? = null

  @Field
  var streamPath: String? = null
}

/**
 * Identity + timing for the stream currently attached to the warm
 * player. `attachElapsedMs` is t0 of the attach→rendered-first-frame
 * metric (the JS call instant, recorded before the player-thread hop).
 * The flags dedupe the once-per-attach phase marks. `attemptId` and
 * `queueRev` are re-keyed when the service adopts its own transition
 * identity or a fresh projection installs — status events must echo
 * the identity the application currently accepts.
 */
private class Attachment(
  val handle: String,
  var attemptId: String,
  var queueRev: Double,
  val attachElapsedMs: Long,
) {
  var readyMarked = false
  var firstFrameMarked = false
}

/** One immutable projected queue item — never carries a signed URL. */
class ProjectionItemInput : Record {
  @Field
  var occurrenceId: String = ""

  @Field
  var provider: String? = null

  @Field
  var sourceRef: String? = null

  @Field
  var title: String = ""

  @Field
  var artist: String? = null

  @Field
  var artworkUrl: String? = null
}

/**
 * The application's identified queue revision, installed whole: the
 * service moves only a cursor inside it — never reorder/add/remove —
 * and reports `queue-transition` events for reconciliation.
 */
class QueueProjectionInput : Record {
  @Field
  var projectionId: String = ""

  @Field
  var queueRev: Double = 0.0

  @Field
  var currentOccurrenceId: String? = null

  @Field
  var positionMs: Double = 0.0

  @Field
  var mode: String = "stopped"

  @Field
  var items: List<ProjectionItemInput> = emptyList()
}

@androidx.annotation.OptIn(UnstableApi::class)
class AuqwExpoModule : Module() {
  @Volatile
  private var host: PluginHost? = null
  private val streamRegistry = AuqwStreamRegistry()
  private val streamDataSourceFactory = AuqwStreamDataSource.Factory(streamRegistry)
  // The seam's terminal kinds (released/expired/superseded/…) can
  // never succeed on retry — let them fail to onPlayerError at once
  // instead of burning the default policy's ~3s of retries; the
  // latched transient/rate-limit hints stay retryable because a
  // re-read re-drives the pump and may recover.
  private val streamLoadErrorPolicy = object : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(error: LoadErrorInfo): Long {
      val kind = (error.exception as? AuqwStreamException)?.kind
      if (kind != null && kind != "transient" && kind != "rate-limit") {
        return C.TIME_UNSET
      }
      return super.getRetryDelayMsFor(error)
    }
  }
  private val streamMediaSourceFactory = ProgressiveMediaSource
    .Factory(streamDataSourceFactory)
    .setLoadErrorHandlingPolicy(streamLoadErrorPolicy)

  // Warm singleton player, owned by AuqwMediaSessionService and reached
  // via an in-process binder — bound at module create so the bind never
  // sits on the play path. `playerReady` is replaced on disconnect so a
  // rebind completes a fresh deferred (never resolves a dead player).
  @Volatile
  private var playerReady = CompletableDeferred<ExoPlayer>()
  @Volatile
  private var player: ExoPlayer? = null
  @Volatile
  private var bound = false
  @Volatile
  private var attached: Attachment? = null
  private val devAttachSeq = java.util.concurrent.atomic.AtomicInteger(0)

  // ~1 Hz position ticks while `isPlaying`: statuses between state
  // transitions would otherwise carry a frozen position, leaving
  // progress UI and persisted position stuck at the attach offset.
  // The runnable self-terminates (no reschedule when not playing or
  // no attach) and is confined to the player looper.
  private var tickerPosted = false
  private val positionTicker = object : Runnable {
    override fun run() {
      tickerPosted = false
      val p = player ?: return
      if (attached == null || !p.isPlaying) {
        return
      }
      emitStatus(stateOf(p))
      tickerPosted = true
      Handler(p.applicationLooper).postDelayed(this, POSITION_TICK_MS)
    }
  }

  // Handles `releaseStream` was invoked for. The mark is set before the
  // session's terminal transition, so an attach still queued on the
  // player looper sees it and skips instead of resurrecting an ended
  // handle into a stale "failed" status. Marks are lifted only while
  // the session is still routable (a genuinely failed release).
  private val releasedHandles = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

  // ---- queue projection state (player-looper confined) ----
  // The service executes a cursor inside ONE installed immutable
  // revision, per the PlayerPort contract: never reorder/add/remove,
  // report every cursor move as a queue-transition. The attached
  // occurrence is the moving cursor; currentOccurrenceId is only its
  // initial value. JS may consume several moves after resuming.
  @Volatile
  private var boundService: AuqwMediaSessionService? = null
  @Volatile
  private var installedProjection: QueueProjectionInput? = null
  // The occurrence the currently attached stream serves: FIXED at a
  // service-initiated attach, the projected current for an
  // app-initiated `play`, null when unknown (dev leg).
  @Volatile
  private var attachedForOccurrence: String? = null
  @Volatile
  private var attachedByService: Boolean = false
  // The projection a pending service-initiated attach derives from,
  // stamped with a monotonic move seq: an off-looper clear (host swap,
  // disconnect) can free the slot, and a stale outcome can never
  // misattribute a *newer* move's latch because the seqs differ.
  private class ArmedMove(val proj: QueueProjectionInput, val seq: Long)

  @Volatile
  private var transitionInFlight: ArmedMove? = null
  private var transitionSeq = 0L
  private var svcSeq = 0
  @Volatile
  private var notificationsRequested = false

  /** Arm the tick loop — idempotent; it reschedules itself only while
   * the attach is live and playing. */
  private fun kickPositionTicker() {
    val p = player ?: return
    if (tickerPosted || attached == null || !p.isPlaying) {
      return
    }
    tickerPosted = true
    Handler(p.applicationLooper).post(positionTicker)
  }

  /** Thrown seam errors carry the ABI taxonomy verbatim as the code —
   * the JS surface maps `error.code` onto the ErrorKind union, so a
   * generic `ERR_STREAM` would erase `released`/`expired`/… to
   * `internal`. */
  private fun streamErrCode(e: StreamException): String = when (e) {
    is StreamException.Failed -> e.kind
    is StreamException.Unavailable -> "unavailable"
  }

  /** Dev-only legs must not exist in a release binary — file/URL
   * attach primitives are instrumentation, gated on the app itself
   * being debuggable. */
  private fun requireDebuggable() {
    val ctx = appContext.reactContext
    val debuggable = ctx != null &&
      (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debuggable) {
      throw CodedException("ERR_DEV_ONLY", "dev instrumentation is debug-build only", null)
    }
  }

  /** Which occurrence an attach binds the stream to. */
  private enum class OccurrenceBind {
    /** App-initiated play: the installed projection's current. */
    CURSOR,

    /** Service-initiated transition attach: a fixed target id. */
    FIXED,

    /** Dev/instrumented attach: no occurrence. */
    NONE,
  }

  override fun definition() = ModuleDefinition {
    Name("AuqwExpo")

    Events(
      EVENT_OUTCOME,
      EVENT_REQUEST_OUTCOME,
      EVENT_PREPARE_OUTCOME,
      EVENT_PLAYBACK_STATUS,
      EVENT_PHASE_MARK,
      EVENT_QUEUE_TRANSITION
    )

    OnCreate {
      try {
        ensureServiceBound()
      } catch (e: Exception) {
        Log.w(TAG, "media service bind deferred: ${e.message}")
      }
    }

    OnDestroy {
      try {
        boundService?.remoteDispatcher = null
        appContext.reactContext?.unbindService(serviceConnection)
      } catch (e: Exception) {
        Log.w(TAG, "unbind: ${e.message}")
      }
    }

    AsyncFunction("createHost") { config: HostConfigInput ->
      val ctx = appContext.reactContext
        ?: throw CodedException("ERR_RUNTIME", "no react context", null)
      val statePath = config.statePath
        ?: ctx.filesDir.resolve("plugin-kv.json").absolutePath
      // The stream seam's sparse cache — app-private, cacheDir so the
      // system can reclaim it; the registry sweeps it at host start.
      val streamPath = config.streamPath
        ?: ctx.cacheDir.resolve("auqw-stream").absolutePath
      val h = try {
        PluginHost(
          HostConfig(
            fuelPerEntry = config.fuelPerEntry.toULong(),
            fuelTotal = config.fuelTotal.toULong(),
            potProviderUrl = config.potProviderUrl,
            statePath = statePath,
            streamPath = streamPath
          )
        )
      } catch (e: HostException) {
        throw coded(e)
      }
      host = h
      // A replaced host can never serve the old host's handles — drop
      // every routing entry so a stale handle resolves to nothing
      // rather than pinning the dropped host (and its runtime) alive.
      streamRegistry.clear()
      releasedHandles.clear()
      // A pending service move prepared on the old host is already
      // stale — free it now so a fresh move isn't stalled waiting on
      // an outcome the new host can never use. (Off-looper clear is
      // safe: the latch is seq-stamped, so a stale outcome can never
      // take a newer move's slot.)
      transitionInFlight = null
      // Every handle the old host served is dead — stop playback and
      // drop the join rather than let the old stream keep playing
      // until its reads fail one by one.
      player?.let { p ->
        Handler(p.applicationLooper).post {
          attached = null
          attachedForOccurrence = null
          attachedByService = false
          p.stop()
          p.clearMediaItems()
        }
      }
      Log.i(TAG, "host created")
      null
    }

    AsyncFunction("loadPlugin") { wasmBase64: String, manifestJson: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val wasm = Base64.decode(wasmBase64, Base64.DEFAULT)
      try {
        h.loadPlugin(wasm, manifestJson)
      } catch (e: HostException) {
        throw coded(e)
      }
    }

    AsyncFunction("startResolve") { pluginId: String, sourceRef: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val listener = object : ResolveListener {
        override fun onOutcome(requestId: String, outcome: ResolveOutcome) {
          when (outcome) {
            is ResolveOutcome.Resolved -> {
              Log.i(
                TAG,
                "resolve $requestId resolved client=${outcome.resource.client} " +
                  "mime=${outcome.resource.mime} steps=${outcome.attempt.steps} " +
                  "elapsed=${outcome.attempt.elapsedMs}ms"
              )
            }
            is ResolveOutcome.Failed -> {
              Log.i(
                TAG,
                "resolve $requestId failed kind=${outcome.kind} " +
                  "message=${outcome.message}"
              )
            }
          }
          sendEvent(
            EVENT_OUTCOME,
            Bundle().apply {
              putString("requestId", requestId)
              putBundle("outcome", outcomeBundle(outcome))
            }
          )
        }
      }
      try {
        h.startResolve(pluginId, sourceRef, listener)
      } catch (e: HostException) {
        throw coded(e)
      }
    }

    AsyncFunction("startRequest") { pluginId: String, capability: String, payloadJson: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val listener = object : RequestListener {
        override fun onOutcome(requestId: String, outcome: RequestOutcome) {
          when (outcome) {
            is RequestOutcome.Succeeded -> {
              Log.i(
                TAG,
                "request $requestId succeeded steps=${outcome.attempt.steps} " +
                  "elapsed=${outcome.attempt.elapsedMs}ms"
              )
            }
            is RequestOutcome.Failed -> {
              Log.i(
                TAG,
                "request $requestId failed kind=${outcome.kind} " +
                  "message=${outcome.message}"
              )
            }
          }
          sendEvent(
            EVENT_REQUEST_OUTCOME,
            Bundle().apply {
              putString("requestId", requestId)
              putBundle("outcome", requestOutcomeBundle(outcome))
            }
          )
        }
      }
      try {
        h.startRequest(pluginId, capability, payloadJson, listener)
      } catch (e: HostException) {
        throw coded(e)
      }
    }

    Function("cancel") { requestId: String ->
      host?.cancel(requestId)
      Log.i(TAG, "cancel requested: $requestId")
      null
    }

    AsyncFunction("runSpin") { wasmBase64: String, manifestJson: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val wasm = Base64.decode(wasmBase64, Base64.DEFAULT)
      val report = try {
        h.runSpin(wasm, manifestJson)
      } catch (e: HostException) {
        throw coded(e)
      }
      Log.i(
        TAG,
        "spin: kind=${report.kind} elapsed=${report.elapsedMs}ms " +
          "fuel=${report.fuelUsed}"
      )
      reportBundle(report)
    }

    // ---- Player surface: the PlayerPort transport contract ----

    AsyncFunction("prepare") { provider: String, sourceRef: String, attemptId: String, queueRev: Double ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val listener = object : PrepareListener {
        override fun onOutcome(requestId: String, outcome: PrepareOutcome) {
          when (outcome) {
            is PrepareOutcome.Prepared -> {
              // Drop routing for handles this prepare superseded or
              // pruned — a dead session's entry must never serve a
              // later attach against the wrong host.
              outcome.superseded.forEach(streamRegistry::unregister)
              streamRegistry.register(outcome.stream.handle, h)
              Log.i(
                TAG,
                "prepare $requestId prepared handle=${outcome.stream.handle} " +
                  "mime=${outcome.stream.mime} elapsed=${outcome.attempt.elapsedMs}ms"
              )
            }
            is PrepareOutcome.Failed -> {
              Log.i(
                TAG,
                "prepare $requestId failed kind=${outcome.kind} " +
                  "message=${outcome.message}"
              )
            }
          }
          sendEvent(
            EVENT_PREPARE_OUTCOME,
            Bundle().apply {
              putString("requestId", requestId)
              putString("attemptId", attemptId)
              putDouble("queueRev", queueRev)
              putBundle("outcome", prepareOutcomeBundle(outcome))
            }
          )
        }
      }
      try {
        h.startPrepare(provider, sourceRef, listener)
      } catch (e: HostException) {
        throw coded(e)
      }
    }

    AsyncFunction("play") Coroutine { handle: String, attemptId: String, queueRev: Double, positionMs: Double? ->
      if (attemptId.isEmpty() || !isSafeNonNegative(queueRev) ||
        (positionMs != null && !isSafeNonNegative(positionMs))
      ) {
        throw CodedException("ERR_INVALID_ARGUMENT", "bad play arguments", null)
      }
      if (streamRegistry.hostFor(handle) == null) {
        throw CodedException("not-found", "unknown stream handle", null)
      }
      attachNow(
        handle, attemptId, queueRev, positionMs,
        Uri.parse("auqw-stream://$handle"), streamDataSourceFactory,
        OccurrenceBind.CURSOR, null
      )
      // After the attach post so a first-play permission prompt can't
      // queue ahead of it on the main looper.
      maybeRequestNotificationPermission()
      null
    }

    AsyncFunction("pause") Coroutine { ->
      val p = awaitPlayer()
      onPlayerThread(p) { p.pause() }
      null
    }

    AsyncFunction("seekTo") Coroutine { positionMs: Double ->
      if (!isSafeNonNegative(positionMs)) {
        throw CodedException(
          "ERR_INVALID_ARGUMENT", "positionMs must be a safe non-negative integer", null
        )
      }
      val p = awaitPlayer()
      onPlayerThread(p) { p.seekTo(positionMs.toLong()) }
      null
    }

    AsyncFunction("stop") Coroutine { ->
      val p = awaitPlayer()
      onPlayerThread(p) {
        attached = null
        attachedForOccurrence = null
        attachedByService = false
        // A stop kills any pending service move: its prepare outcome
        // will land, see the superseded marker, and free its handle.
        transitionInFlight = null
        p.stop()
        p.clearMediaItems()
      }
      null
    }

    AsyncFunction("cancelPrepare") { requestId: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      h.cancel(requestId)
      Log.i(TAG, "cancelPrepare requested: $requestId")
      null
    }

    AsyncFunction("releaseStream") Coroutine { handle: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      // Mark the handle ended before terminating: an attach still
      // queued on the player looper checks the mark and skips, so a
      // released handle is never resurrected into a stale status.
      // The set is bounded — marks only matter across the queued-
      // attach window.
      if (releasedHandles.size < RELEASED_HANDLES_CAP) {
        releasedHandles.add(handle)
      }
      try {
        h.streamRelease(handle)
      } catch (e: StreamException) {
        // Release failed — unmark only while the session is still
        // routable: a release that failed because the handle was
        // already ended must not resurrect it.
        if (streamRegistry.hostFor(handle) != null) {
          releasedHandles.remove(handle)
        }
        // The UniFFI message already formats "{kind}: {detail}" — do
        // not prefix the kind a second time; the code carries the
        // ABI kind so the JS taxonomy survives the boundary.
        throw CodedException(streamErrCode(e), e.message, e)
      }
      // Released — unmap only on success so a failed release keeps the
      // handle routable (the session is still alive).
      streamRegistry.unregister(handle)
      // Releasing the attached stream stops its playback — the check
      // and the stop are one atomic looper block, so a newer attach
      // that landed mid-release keeps both its join and its playback.
      val p = awaitPlayer()
      onPlayerThread(p) {
        if (attached?.handle == handle) {
          attached = null
          attachedForOccurrence = null
          attachedByService = false
          p.stop()
          p.clearMediaItems()
        }
      }
      null
    }

    AsyncFunction("phaseMarks") { handle: String ->
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val marks = try {
        h.streamPhaseMarks(handle)
      } catch (e: StreamException) {
        throw CodedException(streamErrCode(e), e.message, e)
      }
      // The generated record is flat — epoch fields pass through
      // verbatim and durations keep their names (no invented epochs).
      buildMap {
        put("prepareStartedMs", marks.prepareStartedMs.toDouble())
        marks.resolveMs?.let { put("resolveMs", it.toDouble()) }
        marks.mintMs?.let { put("remintMs", it.toDouble()) }
        marks.firstByteMs?.let { put("firstByteMs", it.toDouble()) }
        marks.headReadyMs?.let { put("headReadyMs", it.toDouble()) }
        marks.attachMs?.let { put("attachMs", it.toDouble()) }
      }
    }

    // Gate-0 file leg: same warm player, FileDataSource-backed
    // ProgressiveMediaSource over a pushed file — measures the player
    // floor independent of the seam. Dev instrumentation only.
    AsyncFunction("devAttachFile") Coroutine { path: String ->
      requireDebuggable()
      val handle = "dev-file-${devAttachSeq.incrementAndGet()}"
      val uri = Uri.parse(if (path.contains("://")) path else "file://$path")
      attachNow(
        handle, "dev", 0.0, null, uri, FileDataSource.Factory(),
        OccurrenceBind.NONE, null
      )
      handle
    }

    // Dev-gate URL leg: registers a real seam session for a bare URL —
    // skips only the guest resolve (bot-check-blocked during dev), so
    // prepare→attach→render still runs through the sparse store, pump,
    // fetch-through, and phase marks. Dev instrumentation only.
    AsyncFunction("devPrepareUrl") Coroutine { url: String, mime: String, contentLength: Double? ->
      requireDebuggable()
      val h = host ?: throw CodedException("ERR_NO_HOST", "createHost first", null)
      val prepared = try {
        h.devPrepareUrl(url, mime, contentLength?.toULong())
      } catch (e: StreamException) {
        throw CodedException(streamErrCode(e), e.message, e)
      }
      streamRegistry.register(prepared.handle, h)
      prepared.handle
    }

    /**
     * Install one immutable identified queue revision for background
     * execution. The service moves only a cursor inside it — never
     * reorder/add/remove — and reports `queue-transition` events.
     */
    AsyncFunction("setQueueProjection") Coroutine { projection: QueueProjectionInput ->
      validateProjection(projection)
      val p = awaitPlayer()
      onPlayerThread(p) { installProjection(p, projection) }
      null
    }
  }

  // ---- player plumbing ----

  private val serviceConnection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      val b = binder as? AuqwMediaSessionService.LocalBinder ?: return
      val p = b.player() ?: return
      boundService = b.service()
      // Remote transport commands (lock screen, headset, SystemUI)
      // reach the session callback on the player's own looper — the
      // dispatcher hops there anyway so every projection mutation is
      // confined to the one thread that owns it.
      boundService?.remoteDispatcher = RemoteCommandDispatcher { command ->
        val pl = player ?: return@RemoteCommandDispatcher
        Handler(pl.applicationLooper).post { driveTransition(command) }
      }
      // Listeners register once, on the player's own looper. Remove
      // first: a rebind of the same service instance must not stack a
      // second listener set and emit every event twice.
      Handler(p.applicationLooper).post {
        p.removeListener(playerListener)
        p.removeAnalyticsListener(analyticsListener)
        p.addListener(playerListener)
        p.addAnalyticsListener(analyticsListener)
      }
      player = p
      playerReady.complete(p)
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      boundService?.remoteDispatcher = null
      boundService = null
      // The bound player is dead — the attach dies with it. Emit
      // `failed` under the dying identity BEFORE clearing the join:
      // a silent clear would leave the application showing a zombie
      // `playing` for a stream no player owns.
      val a = attached
      val p = player
      if (a != null && p != null) {
        sendEvent(
          EVENT_PLAYBACK_STATUS,
          Bundle().apply {
            putString("handle", a.handle)
            putString("attemptId", a.attemptId)
            putDouble("queueRev", a.queueRev)
            putString("state", "failed")
            putDouble(
              "positionMs",
              runCatching { p.currentPosition }
                .getOrDefault(0L)
                .coerceAtLeast(0)
                .toDouble()
            )
            putBundle(
              "error",
              Bundle().apply {
                // transient — the session convention for player-side
                // death (retryable); the stream itself may be fine.
                putString("kind", "transient")
                putString("message", "media service disconnected")
              }
            )
          }
        )
      }
      attached = null
      attachedForOccurrence = null
      attachedByService = false
      transitionInFlight = null
      // Reset so the next awaitPlayer rebinds instead of resolving a
      // stale deferred.
      player = null
      bound = false
      playerReady = CompletableDeferred()
    }
  }

  private fun ensureServiceBound() {
    if (bound) {
      return
    }
    // Concurrent calls must not double-bind: a second connection would
    // register a second listener set and emit every event twice.
    synchronized(this) {
      if (bound) {
        return
      }
      val ctx = appContext.reactContext
        ?: throw CodedException("ERR_RUNTIME", "no react context", null)
      val intent = Intent(ctx, AuqwMediaSessionService::class.java).apply {
        action = AuqwMediaSessionService.ACTION_LOCAL_BIND
      }
      bound = ctx.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
      if (!bound) {
        throw CodedException("ERR_PLAYER", "media service bind refused", null)
      }
    }
  }

  private suspend fun awaitPlayer(): ExoPlayer {
    ensureServiceBound()
    return withTimeoutOrNull(BIND_TIMEOUT_MS) { playerReady.await() }
      ?: throw CodedException("ERR_PLAYER", "media service bind timed out", null)
  }

  /** All ExoPlayer calls must land on the player's application looper. */
  private suspend fun <T> onPlayerThread(player: ExoPlayer, block: () -> T): T =
    suspendCancellableCoroutine { cont ->
      Handler(player.applicationLooper).post {
        if (!cont.isActive) {
          return@post
        }
        try {
          cont.resume(block())
        } catch (e: CodedException) {
          cont.resumeWithException(e)
        } catch (e: Exception) {
          cont.resumeWithException(CodedException("ERR_PLAYER", e.message, e))
        }
      }
    }

  private suspend fun attachNow(
    handle: String,
    attemptId: String,
    queueRev: Double,
    positionMs: Double?,
    uri: Uri,
    dataSourceFactory: DataSource.Factory,
    bind: OccurrenceBind,
    occurrenceId: String?,
  ) {
    val p = awaitPlayer()
    val a = Attachment(handle, attemptId, queueRev, SystemClock.elapsedRealtime())
    onPlayerThread(p) {
      attachOnPlayerThread(p, a, positionMs, uri, dataSourceFactory, bind, occurrenceId)
    }
  }

  /** Player-looper attach — shared by `play`, dev legs, and service
   * transition attaches so the skip/binding rules stay identical. */
  private fun attachOnPlayerThread(
    p: ExoPlayer,
    a: Attachment,
    positionMs: Double?,
    uri: Uri,
    dataSourceFactory: DataSource.Factory,
    bind: OccurrenceBind,
    occurrenceId: String?,
  ) {
    // A release that landed while this attach was queued ended the
    // handle before it reached the player — skip rather than emit a
    // stale failure for a stream the caller already ended.
    if (releasedHandles.contains(a.handle)) {
      return
    }
    // A stream handle unmapped meanwhile (superseded, pruned, or
    // evicted) is dead: attaching could only fail, but silently
    // skipping leaves the app waiting on a status that never comes —
    // report the attach as failed under its own identity.
    if (dataSourceFactory === streamDataSourceFactory &&
      streamRegistry.hostFor(a.handle) == null
    ) {
      emitStatusFor(
        a,
        "failed",
        Bundle().apply {
          putString("kind", "superseded")
          putString("message", "stream handle ended before attach")
        }
      )
      return
    }
    // The occurrence this attach serves decides both the occurrence
    // bind and the lock-screen metadata source — resolve it once.
    val occId = when (bind) {
      OccurrenceBind.FIXED -> occurrenceId
      OccurrenceBind.CURSOR -> installedProjection?.currentOccurrenceId
      OccurrenceBind.NONE -> null
    }
    // Lock-screen/notification metadata comes from the projected item
    // — a bare fromUri MediaItem leaves title/artist/artwork dead.
    val projected = installedProjection?.items?.firstOrNull {
      it.occurrenceId == occId
    }
    val mediaItem = MediaItem.Builder()
      .setUri(uri)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(projected?.title)
          .setArtist(projected?.artist)
          .setArtworkUri(
            projected?.artworkUrl?.let {
              runCatching { Uri.parse(it) }.getOrNull()
            }
          )
          .build()
      )
      .build()
    val source = (if (dataSourceFactory === streamDataSourceFactory) {
      streamMediaSourceFactory
    } else {
      ProgressiveMediaSource.Factory(dataSourceFactory)
    }).createMediaSource(mediaItem)
    p.setMediaSource(source, positionMs?.toLong() ?: 0L)
    p.prepare()
    p.play()
    // The mark is emitted only once the attach is accepted — a
    // skipped attach leaves no stale mark behind; after play() the
    // sendEvent cost stays off the source-creation path.
    emitPhaseMark(a, "attach")
    // The join is committed only once the player accepted the source:
    // a thrown setMediaSource leaves no Attachment echoing statuses
    // for a stream that never played.
    attached = a
    attachedByService = bind == OccurrenceBind.FIXED
    attachedForOccurrence = occId
  }

  private fun stateOf(p: ExoPlayer): String = when (p.playbackState) {
    Player.STATE_IDLE -> "idle"
    Player.STATE_BUFFERING -> "buffering"
    Player.STATE_ENDED -> "ended"
    else -> when {
      p.isPlaying -> "playing"
      !p.playWhenReady -> "paused"
      else -> "ready"
    }
  }

  private fun emitStatus(state: String, error: Bundle? = null) {
    emitStatusFor(attached, state, error)
  }

  /** Status under an explicit attachment — an attach that fails
   * before it can claim the player still owes its caller a failure
   * under its own identity. */
  private fun emitStatusFor(a: Attachment?, state: String, error: Bundle? = null) {
    if (a == null) {
      return
    }
    val p = player ?: return
    sendEvent(
      EVENT_PLAYBACK_STATUS,
      Bundle().apply {
        putString("handle", a.handle)
        putString("attemptId", a.attemptId)
        putDouble("queueRev", a.queueRev)
        putString("state", state)
        putDouble("positionMs", p.currentPosition.coerceAtLeast(0).toDouble())
        if (p.duration != C.TIME_UNSET) {
          putDouble("durationMs", p.duration.toDouble())
        }
        if (error != null) {
          putBundle("error", error)
        }
      }
    )
  }

  private fun emitPhaseMark(a: Attachment, name: String) {
    sendEvent(
      EVENT_PHASE_MARK,
      Bundle().apply {
        putString("handle", a.handle)
        putString("attemptId", a.attemptId)
        putDouble("queueRev", a.queueRev)
        putString("name", name)
        putDouble("atMs", System.currentTimeMillis().toDouble())
        putDouble("sinceStartMs", (SystemClock.elapsedRealtime() - a.attachElapsedMs).toDouble())
      }
    )
  }

  // ---- queue projection: a cursor inside one immutable revision ----

  /** Service-issued attempt identity — the application adopts it
   * verbatim on transition acceptance, so statuses keep echoing it. */
  private fun nextSvcId(): String = "svc-${++svcSeq}"

  private fun isSafeNonNegative(v: Double): Boolean =
    v.isFinite() && v >= 0.0 && v <= 9_007_199_254_740_991.0 && kotlin.math.floor(v) == v

  /** Contract-shape validation — the port surfaces a rejection as a
   * failed install, never as a partial projection. */
  private fun validateProjection(p: QueueProjectionInput) {
    fun bad(msg: String): Nothing =
      throw CodedException("ERR_INVALID_PROJECTION", msg, null)
    if (p.projectionId.isEmpty()) {
      bad("projectionId required")
    }
    if (!isSafeNonNegative(p.queueRev)) {
      bad("queueRev must be a safe non-negative integer")
    }
    if (!isSafeNonNegative(p.positionMs)) {
      bad("positionMs must be a safe non-negative integer")
    }
    if (p.mode != "stopped" && p.mode != "paused" && p.mode != "playing") {
      bad("unknown projection mode")
    }
    if (p.items.size > 500) {
      bad("projection exceeds item bound")
    }
    for (item in p.items) {
      if (item.occurrenceId.isEmpty()) {
        bad("occurrenceId required")
      }
      if ((item.provider == null) != (item.sourceRef == null)) {
        bad("provider/sourceRef must be null together")
      }
    }
    if (p.items.map { it.occurrenceId }.toSet().size != p.items.size) {
      bad("duplicate occurrenceId")
    }
    if (p.currentOccurrenceId != null &&
      p.items.none { it.occurrenceId == p.currentOccurrenceId }
    ) {
      bad("currentOccurrenceId outside items")
    }
  }

  /**
   * Install on the player looper: bind the attached stream to the new
   * cursor (or stop a superseded service move), then re-drive `ended`
   * when the cursor item finished while a projection swap was in
   * flight — its transition is owed to a revision that exists now.
   */
  private fun installProjection(p: ExoPlayer, proj: QueueProjectionInput) {
    installedProjection = proj
    val att = attached
    when {
      att == null -> {
        attachedForOccurrence = null
        attachedByService = false
      }
      !attachedByService -> {
        // An app-initiated attach always serves the app's current
        // cursor — rebind it onto the fresh revision.
        attachedForOccurrence = proj.currentOccurrenceId
      }
      attachedForOccurrence != proj.currentOccurrenceId -> {
        // A service move the app superseded is still on the player —
        // stop it rather than keep playing a rejected move.
        attached = null
        attachedForOccurrence = null
        attachedByService = false
        p.stop()
        p.clearMediaItems()
      }
    }
    // The application re-keys its active identity's queueRev to the
    // revision every mutation produces — statuses only join while
    // they echo that revision, so the surviving attach must track it.
    attached?.queueRev = proj.queueRev
    if (attachedForOccurrence != null &&
      attachedForOccurrence == proj.currentOccurrenceId &&
      p.playbackState == Player.STATE_ENDED
    ) {
      driveTransition("ended")
    }
  }

  /**
   * Advance the projected cursor one legal step. `ended` fires only
   * when the stream that finished is the cursor item; remote commands
   * move the cursor directly. Unfillable moves park — the service
   * never guesses a jump and never emits a transition whose
   * identity/handle pair the application would reject.
   */
  private fun driveTransition(reason: String) {
    if (reason != "ended" && reason != "remote-next" && reason != "remote-previous") {
      return
    }
    val proj = installedProjection ?: return
    val p = player ?: return
    val att = attached ?: return
    val from = attachedForOccurrence ?: return
    // One move at a time: a second press while a target prepares is
    // dropped — the landed attach re-arms the next command.
    if (transitionInFlight != null) {
      return
    }
    val idx = proj.items.indexOfFirst { it.occurrenceId == from }
    if (idx < 0) {
      return
    }
    if (reason == "remote-previous") {
      // Transport rule: past the restart threshold, or at the head of
      // the queue, previous restarts the current item — the only
      // legal same-item target. It reuses the live handle/identity.
      if (idx == 0 || p.currentPosition > REMOTE_PREVIOUS_RESTART_MS) {
        p.seekTo(0)
        emitTransition(
          proj, from, from, reason, 0.0,
          att.attemptId to att.queueRev, att.handle
        )
      } else {
        moveTo(p, proj, from, proj.items[idx - 1], reason)
      }
      return
    }
    val next = proj.items.getOrNull(idx + 1)
    if (next == null) {
      // Ran off the tail: a null-target transition is the legal stop.
      val endPosition = p.currentPosition.coerceAtLeast(0).toDouble()
      attached = null
      attachedForOccurrence = null
      attachedByService = false
      p.stop()
      p.clearMediaItems()
      emitTransition(proj, from, null, reason, endPosition, null, null)
      return
    }
    moveTo(p, proj, from, next, reason)
  }

  /** Resolve + attach the legal target, then emit the transition. */
  private fun moveTo(
    p: ExoPlayer,
    proj: QueueProjectionInput,
    from: String,
    target: ProjectionItemInput,
    reason: String,
  ) {
    val provider = target.provider
    val sourceRef = target.sourceRef
    if (provider.isNullOrEmpty() || sourceRef.isNullOrEmpty()) {
      // Honest unavailable: the item cannot produce a handle, so no
      // legal nonnull-target transition exists — park on the cursor.
      failEndedAttach(reason, "unavailable", "queue successor is unplayable")
      Log.i(TAG, "queue transition parked: target unavailable")
      return
    }
    val h = host ?: return
    val seq = ++transitionSeq
    transitionInFlight = ArmedMove(proj, seq)
    val listener = object : PrepareListener {
      override fun onOutcome(requestId: String, outcome: PrepareOutcome) {
        // Prepare outcomes fire on a host runtime worker — hop back
        // to the player looper before touching projection state.
        val pl = player
        if (pl == null) {
          releaseOutcomeHandle(h, outcome)
          return
        }
        Handler(pl.applicationLooper).post {
          finishTransition(pl, h, proj, seq, from, target.occurrenceId, reason, outcome)
        }
      }
    }
    try {
      // startPrepare only registers the request — it never blocks on
      // resolve, so the player looper (= main thread) is safe.
      h.startPrepare(provider, sourceRef, listener)
    } catch (e: HostException) {
      transitionInFlight = null
      failEndedAttach(reason, "unavailable", e.message)
      Log.w(TAG, "transition prepare rejected: ${e.message}")
    }
  }

  private fun finishTransition(
    p: ExoPlayer,
    h: PluginHost,
    proj: QueueProjectionInput,
    seq: Long,
    from: String,
    to: String,
    reason: String,
    outcome: PrepareOutcome,
  ) {
    if (transitionInFlight?.seq != seq) {
      releaseOutcomeHandle(h, outcome)
      return
    }
    transitionInFlight = null
    if (installedProjection !== proj || h !== host) {
      // A fresher revision installed — or the host was recreated —
      // while the prepare ran: this event could only arrive stale;
      // free the prepared handle on the host that owns it.
      releaseOutcomeHandle(h, outcome)
      // installProjection could not re-drive EOF while this old prepare
      // owned the latch. Now that it is clear, retry against the installed
      // intent, provided its cursor still owns the ended attachment.
      val latest = installedProjection
      if (h === host && latest != null &&
        attachedForOccurrence == latest.currentOccurrenceId &&
        p.playbackState == Player.STATE_ENDED
      ) {
        driveTransition("ended")
      }
      return
    }
    when (outcome) {
      is PrepareOutcome.Prepared -> {
        outcome.superseded.forEach(streamRegistry::unregister)
        streamRegistry.register(outcome.stream.handle, h)
        val attemptId = nextSvcId()
        val a = Attachment(
          outcome.stream.handle, attemptId, proj.queueRev,
          SystemClock.elapsedRealtime()
        )
        try {
          attachOnPlayerThread(
            p, a, 0.0, Uri.parse("auqw-stream://${outcome.stream.handle}"),
            streamDataSourceFactory, OccurrenceBind.FIXED, to
          )
        } catch (e: Exception) {
          Log.w(TAG, "transition attach failed: ${e.message}")
          failEndedAttach(reason, "internal", e.message)
          return
        }
        // Emit only once the attach was accepted — a skipped attach
        // leaves the cursor parked, not advanced.
        if (attached === a) {
          emitTransition(
            proj, from, to, reason, 0.0,
            attemptId to proj.queueRev, outcome.stream.handle
          )
        }
      }
      is PrepareOutcome.Failed -> {
        // The target could not be resolved — park on the cursor; a
        // remote retry drives the move again. `ended` is deferred
        // app-side: surface the failure or the queue freezes here.
        failEndedAttach(reason, outcome.kind, outcome.message)
        Log.i(TAG, "transition prepare failed kind=${outcome.kind}")
      }
    }
  }

  /** `ended` defers the queue's advance to this transition — when no
   * legal move exists the app must hear the block as a failure on the
   * attach that ended, or it waits forever. Remote presses simply
   * no-op: the app is not deferring on them. */
  private fun failEndedAttach(reason: String, kind: String, message: String?) {
    if (reason != "ended") {
      return
    }
    emitStatus(
      "failed",
      Bundle().apply {
        putString("kind", kind)
        putString("message", message)
      }
    )
  }

  /** Free a prepared stream the projection can no longer use — on
   * the host that minted it, never the current (possibly swapped) one. */
  private fun releaseOutcomeHandle(h: PluginHost, outcome: PrepareOutcome) {
    if (outcome !is PrepareOutcome.Prepared) {
      return
    }
    streamRegistry.unregister(outcome.stream.handle)
    try {
      h.streamRelease(outcome.stream.handle)
    } catch (e: Exception) {
      Log.w(TAG, "release of stale transition handle: ${e.message}")
    }
  }

  private fun emitTransition(
    proj: QueueProjectionInput,
    from: String?,
    to: String?,
    reason: String,
    positionMs: Double,
    identity: Pair<String, Double>?,
    handle: String?,
  ) {
    sendEvent(
      EVENT_QUEUE_TRANSITION,
      Bundle().apply {
        putString("projectionId", proj.projectionId)
        putDouble("projectedQueueRev", proj.queueRev)
        putString("fromOccurrenceId", from)
        putString("toOccurrenceId", to)
        putString("reason", reason)
        putDouble("positionMs", positionMs)
        putBundle(
          "identity",
          identity?.let { (attemptId, queueRev) ->
            Bundle().apply {
              putString("attemptId", attemptId)
              putDouble("queueRev", queueRev)
            }
          }
        )
        putString("handle", handle)
      }
    )
  }

  /** Android 13+ gates the media notification behind a runtime
   * permission — ask once, on the first play, on the UI thread. */
  private fun maybeRequestNotificationPermission() {
    if (notificationsRequested || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return
    }
    val ctx = appContext.reactContext ?: return
    if (ContextCompat.checkSelfPermission(
        ctx, android.Manifest.permission.POST_NOTIFICATIONS
      ) == PackageManager.PERMISSION_GRANTED
    ) {
      notificationsRequested = true
      return
    }
    val activity = appContext.currentActivity ?: return
    notificationsRequested = true
    activity.runOnUiThread {
      ActivityCompat.requestPermissions(
        activity, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 0
      )
    }
  }

  private fun errorKind(error: PlaybackException): String {
    var cause: Throwable? = error
    while (cause != null) {
      if (cause is AuqwStreamException) {
        return cause.kind
      }
      cause = cause.cause
    }
    return when (error.errorCode) {
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
      PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE,
      PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
      PlaybackException.ERROR_CODE_TIMEOUT -> "transient"
      PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "not-found"
      else -> "internal"
    }
  }

  private val playerListener = object : Player.Listener {
    override fun onPlaybackStateChanged(playbackState: Int) {
      val p = player ?: return
      val a = attached
      // STATE_READY is a phase mark, never the latency metric.
      if (a != null && playbackState == Player.STATE_READY && !a.readyMarked) {
        a.readyMarked = true
        emitPhaseMark(a, "state-ready")
      }
      if (a != null) {
        emitStatus(stateOf(p))
      }
      if (p.isPlaying) {
        kickPositionTicker()
      }
      // The cursor item ran out inside an installed projection: the
      // service owns the advance, JS defers to the queue-transition.
      if (playbackState == Player.STATE_ENDED) {
        driveTransition("ended")
      }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      val p = player ?: return
      if (attached == null) {
        return
      }
      emitStatus(stateOf(p))
      if (isPlaying) {
        kickPositionTicker()
      }
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      val p = player ?: return
      if (attached == null) {
        return
      }
      emitStatus(stateOf(p))
    }

    override fun onPlayerError(error: PlaybackException) {
      if (attached == null) {
        return
      }
      val kind = errorKind(error)
      Log.i(TAG, "player error kind=$kind")
      emitStatus(
        "failed",
        Bundle().apply {
          putString("kind", kind)
          putString("message", error.message)
        }
      )
    }
  }

  private val analyticsListener = object : AnalyticsListener {
    override fun onRenderedFirstFrame(
      eventTime: AnalyticsListener.EventTime,
      output: Any,
      renderTimeMs: Long
    ) {
      val a = attached ?: return
      if (a.firstFrameMarked) {
        return
      }
      a.firstFrameMarked = true
      // THE ≤200 ms metric event: attach → first frame handed to output.
      emitPhaseMark(a, "rendered-first-frame")
      Log.i(
        TAG,
        "attach ${a.handle} rendered-first-frame " +
          "${SystemClock.elapsedRealtime() - a.attachElapsedMs}ms"
      )
    }
  }

  // ---- host-surface payload shaping (ported from plugin-host-expo) ----

  private fun attemptBundle(a: AttemptSummary) = Bundle().apply {
    putString("requestId", a.requestId)
    putDouble("steps", a.steps.toDouble())
    putDouble("httpCalls", a.httpCalls.toDouble())
    putDouble("bytes", a.bytes.toDouble())
    putDouble("fuelUsed", a.fuelUsed.toDouble())
    putDouble("elapsedMs", a.elapsedMs.toDouble())
    putParcelableArrayList(
      "httpTrace",
      ArrayList(
        a.httpTrace.map { e ->
          Bundle().apply {
            putString("method", e.method)
            putString("url", e.url)
            e.status?.let { putDouble("status", it.toDouble()) }
            putDouble("bytes", e.bytes.toDouble())
            putDouble("elapsedMs", e.elapsedMs.toDouble())
          }
        }
      )
    )
    putParcelableArrayList(
      "guestLog",
      ArrayList(
        a.guestLog.map { e ->
          Bundle().apply {
            putString("level", e.level)
            putString("message", e.message)
          }
        }
      )
    )
  }

  private fun outcomeBundle(outcome: ResolveOutcome): Bundle = when (outcome) {
    is ResolveOutcome.Resolved -> Bundle().apply {
      putString("type", "resolved")
      putBundle(
        "resource",
        Bundle().apply {
          putString("url", outcome.resource.url)
          putString("mime", outcome.resource.mime)
          outcome.resource.bitrateKbps?.let { putDouble("bitrateKbps", it.toDouble()) }
          outcome.resource.expiresAtMs?.let { putDouble("expiresAtMs", it.toDouble()) }
          putString("client", outcome.resource.client)
          outcome.resource.contentLength?.let { putDouble("contentLength", it.toDouble()) }
          outcome.resource.itag?.let { putDouble("itag", it.toDouble()) }
        }
      )
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
    is ResolveOutcome.Failed -> Bundle().apply {
      putString("type", "failed")
      putString("kind", outcome.kind)
      putString("message", outcome.message)
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
  }

  private fun requestOutcomeBundle(outcome: RequestOutcome): Bundle = when (outcome) {
    is RequestOutcome.Succeeded -> Bundle().apply {
      putString("type", "succeeded")
      putString("resultJson", outcome.resultJson)
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
    is RequestOutcome.Failed -> Bundle().apply {
      putString("type", "failed")
      putString("kind", outcome.kind)
      putString("message", outcome.message)
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
  }

  // onPrepareOutcome stream payload: the JS contract shape —
  // {handle, mime, itag?, contentLength?, expiresAtMs?, bitrateKbps?} —
  // never carries the signed URL.
  private fun prepareOutcomeBundle(outcome: PrepareOutcome): Bundle = when (outcome) {
    is PrepareOutcome.Prepared -> Bundle().apply {
      putString("type", "prepared")
      putBundle(
        "stream",
        Bundle().apply {
          putString("handle", outcome.stream.handle)
          putString("mime", outcome.stream.mime)
          outcome.stream.itag?.let { putDouble("itag", it.toDouble()) }
          outcome.stream.contentLength?.let { putDouble("contentLength", it.toDouble()) }
          outcome.stream.expiresAtMs?.let { putDouble("expiresAtMs", it.toDouble()) }
          outcome.stream.bitrateKbps?.let { putDouble("bitrateKbps", it.toDouble()) }
        }
      )
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
    is PrepareOutcome.Failed -> Bundle().apply {
      putString("type", "failed")
      putString("kind", outcome.kind)
      putString("message", outcome.message)
      putBundle("attempt", attemptBundle(outcome.attempt))
    }
  }

  private fun reportBundle(r: SpinReport) = Bundle().apply {
    putDouble("elapsedMs", r.elapsedMs.toDouble())
    putDouble("fuelUsed", r.fuelUsed.toDouble())
    putString("kind", r.kind)
  }

  private fun coded(e: HostException): CodedException = when (e) {
    is HostException.Load -> CodedException("ERR_LOAD", e.message, e)
    is HostException.UnknownPlugin -> CodedException("ERR_UNKNOWN_PLUGIN", e.message, e)
    is HostException.Runtime -> CodedException("ERR_RUNTIME", e.message, e)
  }
}
