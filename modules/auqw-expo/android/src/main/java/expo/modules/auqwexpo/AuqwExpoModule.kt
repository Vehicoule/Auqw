package expo.modules.auqwexpo

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.FileDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.ProgressiveMediaSource
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
private const val BIND_TIMEOUT_MS = 5_000L

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
 * The flags dedupe the once-per-attach phase marks.
 */
private class Attachment(
  val handle: String,
  val attemptId: String,
  val queueRev: Double,
  val attachElapsedMs: Long,
) {
  var readyMarked = false
  var firstFrameMarked = false
}

@androidx.annotation.OptIn(UnstableApi::class)
class AuqwExpoModule : Module() {
  private var host: PluginHost? = null
  private val streamRegistry = AuqwStreamRegistry()
  private val streamDataSourceFactory = AuqwStreamDataSource.Factory(streamRegistry)

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

  override fun definition() = ModuleDefinition {
    Name("AuqwExpo")

    Events(
      EVENT_OUTCOME,
      EVENT_REQUEST_OUTCOME,
      EVENT_PREPARE_OUTCOME,
      EVENT_PLAYBACK_STATUS,
      EVENT_PHASE_MARK
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
      if (streamRegistry.hostFor(handle) == null) {
        throw CodedException("ERR_HANDLE_UNKNOWN", "unknown stream handle", null)
      }
      attachNow(
        handle, attemptId, queueRev, positionMs,
        Uri.parse("auqw-stream://$handle"), streamDataSourceFactory
      )
      null
    }

    AsyncFunction("pause") Coroutine { ->
      val p = awaitPlayer()
      onPlayerThread(p) { p.pause() }
      null
    }

    AsyncFunction("seekTo") Coroutine { positionMs: Double ->
      val p = awaitPlayer()
      onPlayerThread(p) { p.seekTo(positionMs.toLong()) }
      null
    }

    AsyncFunction("stop") Coroutine { ->
      val p = awaitPlayer()
      onPlayerThread(p) {
        attached = null
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
      try {
        h.streamRelease(handle)
      } catch (e: StreamException) {
        throw CodedException("ERR_STREAM", "${streamKind(e)}: ${e.message}", e)
      }
      // Released — unmap only on success so a failed release keeps the
      // handle routable (the session is still alive).
      streamRegistry.unregister(handle)
      // Releasing the attached stream stops its playback; the status
      // join is cleared first so a released handle emits nothing stale.
      val a = attached
      if (a?.handle == handle) {
        attached = null
        val p = awaitPlayer()
        onPlayerThread(p) {
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
        throw CodedException("ERR_STREAM", "${streamKind(e)}: ${e.message}", e)
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
      val handle = "dev-file-${devAttachSeq.incrementAndGet()}"
      val uri = Uri.parse(if (path.contains("://")) path else "file://$path")
      attachNow(handle, "dev", 0.0, null, uri, FileDataSource.Factory())
      handle
    }
  }

  // ---- player plumbing ----

  private val serviceConnection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      val p = (binder as? AuqwMediaSessionService.LocalBinder)?.player() ?: return
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
      // The bound player is dead — reset so the next awaitPlayer
      // rebinds instead of resolving a stale deferred.
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
    dataSourceFactory: DataSource.Factory
  ) {
    val p = awaitPlayer()
    val a = Attachment(handle, attemptId, queueRev, SystemClock.elapsedRealtime())
    emitPhaseMark(a, "attach")
    onPlayerThread(p) {
      attached = a
      val source = ProgressiveMediaSource.Factory(dataSourceFactory)
        .createMediaSource(MediaItem.fromUri(uri))
      p.setMediaSource(source, positionMs?.toLong() ?: 0L)
      p.prepare()
      p.play()
    }
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
    val a = attached ?: return
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
      val a = attached ?: return
      val p = player ?: return
      // STATE_READY is a phase mark, never the latency metric.
      if (playbackState == Player.STATE_READY && !a.readyMarked) {
        a.readyMarked = true
        emitPhaseMark(a, "state-ready")
      }
      emitStatus(stateOf(p))
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      val p = player ?: return
      if (attached == null) {
        return
      }
      emitStatus(stateOf(p))
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
