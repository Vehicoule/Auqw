package expo.modules.auqwexpo

import android.content.Intent
import android.os.Binder
import android.os.IBinder
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Hosts the app's single player: ONE warm [ExoPlayer] + [MediaSession]
 * created at service start and reused across every attach. Building a
 * player per attach (the cold-start canonical pattern) would blow the
 * ≤200 ms prepared-path budget, so the service owns the singleton.
 *
 * The module drives the player through [LocalBinder], not a
 * MediaController/SessionToken: the controller's async `connect()`
 * sits on the click path, and it cannot register an AnalyticsListener
 * (onRenderedFirstFrame is THE latency-metric event). The in-process
 * binder is the canonical same-app alternative; the MediaSession still
 * serves lock-screen/SystemUI controllers.
 *
 * Buffer tuning uses the *streaming* setters — a custom DataSource is
 * streaming by definition — and mirrors the same values for local
 * playback so the gate-0 file leg (file:// URIs) is measured on an
 * identical floor.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AuqwMediaSessionService : MediaSessionService() {

  companion object {
    /** bindService action that selects the in-process [LocalBinder]. */
    const val ACTION_LOCAL_BIND = "expo.modules.auqwexpo.LOCAL_BIND"
    private const val MIN_BUFFER_MS = 2_000
    private const val MAX_BUFFER_MS = 20_000
    private const val BUFFER_FOR_PLAYBACK_MS = 75
    private const val BUFFER_FOR_REBUFFER_MS = 100
  }

  private var player: ExoPlayer? = null
  private var session: MediaSession? = null
  private val localBinder = LocalBinder()

  inner class LocalBinder : Binder() {
    fun player(): ExoPlayer? = this@AuqwMediaSessionService.player
  }

  override fun onCreate() {
    super.onCreate()
    val loadControl = DefaultLoadControl.Builder()
      // ~50–100 ms to start/resume: the ≤200 ms budget leaves almost
      // nothing for a buffer gate, and the seam's head fill is bounded
      // upstream — buffering longer buys nothing.
      .setBufferDurationsMsForStreaming(
        MIN_BUFFER_MS, MAX_BUFFER_MS,
        BUFFER_FOR_PLAYBACK_MS, BUFFER_FOR_REBUFFER_MS,
      )
      .setBufferDurationsMsForLocalPlayback(
        MIN_BUFFER_MS, MAX_BUFFER_MS,
        BUFFER_FOR_PLAYBACK_MS, BUFFER_FOR_REBUFFER_MS,
      )
      .build()
    val p = ExoPlayer.Builder(this)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(C.USAGE_MEDIA)
          .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
          .build(),
        /* handleAudioFocus= */ true,
      )
      .setWakeMode(C.WAKE_MODE_LOCAL)
      .setHandleAudioBecomingNoisy(true)
      .setLoadControl(loadControl)
      .build()
    player = p
    session = MediaSession.Builder(this, p).build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onBind(intent: Intent?): IBinder? {
    if (intent?.action == ACTION_LOCAL_BIND) {
      return localBinder
    }
    // SERVICE_INTERFACE / media-browser binds keep the default handling.
    return super.onBind(intent)
  }

  override fun onDestroy() {
    session?.release()
    player?.release()
    session = null
    player = null
    super.onDestroy()
  }
}
