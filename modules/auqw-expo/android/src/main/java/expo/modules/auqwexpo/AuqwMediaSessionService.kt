package expo.modules.auqwexpo

import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.view.KeyEvent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionResult

/**
 * Routes a remote transport command ("remote-next"/"remote-previous")
 * to the queue-projection cursor. The module installs one once bound;
 * the session callback calls it instead of letting the player's own
 * single-item next/previous no-op swallow lock-screen commands.
 */
fun interface RemoteCommandDispatcher {
  fun dispatch(command: String)
}

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

  /**
   * The queue cursor's remote-command sink, installed by the module.
   * The session never owns queue edits — it forwards remote
   * next/previous here so the projection contract decides the move.
   */
  var remoteDispatcher: RemoteCommandDispatcher? = null

  inner class LocalBinder : Binder() {
    // The service is exported (MediaSession controllers bind from
    // SystemUI); the raw player/service handles are same-UID only.
    fun player(): ExoPlayer? =
      if (Binder.getCallingUid() == Process.myUid()) {
        this@AuqwMediaSessionService.player
      } else {
        null
      }

    fun service(): AuqwMediaSessionService? =
      if (Binder.getCallingUid() == Process.myUid()) {
        this@AuqwMediaSessionService
      } else {
        null
      }
  }

  private val sessionCallback = object : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo
    ): MediaSession.ConnectionResult {
      // Advertise next/previous-item commands even on a single-item
      // player: the session consumes them through the projection
      // cursor, so lock-screen/SystemUI keep their buttons.
      val playerCommands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
        .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
        .setAvailablePlayerCommands(playerCommands)
        .build()
    }

    // Deprecated in Media3 1.11 with no replacement on the callback
    // surface: a real ExoPlayer cannot gate commands at the Player
    // layer, so this remains the only interception point — and the
    // session still honors it.
    @Suppress("DEPRECATION")
    override fun onPlayerCommandRequest(
      session: MediaSession,
      controllerInfo: MediaSession.ControllerInfo,
      playerCommand: Int
    ): Int {
      when (playerCommand) {
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_NEXT -> {
          remoteDispatcher?.dispatch("remote-next")
          // Consumed — the player's own single-item seek must not run.
          return SessionResult.RESULT_ERROR_NOT_SUPPORTED
        }
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS -> {
          remoteDispatcher?.dispatch("remote-previous")
          return SessionResult.RESULT_ERROR_NOT_SUPPORTED
        }
      }
      return super.onPlayerCommandRequest(session, controllerInfo, playerCommand)
    }

    override fun onMediaButtonEvent(
      session: MediaSession,
      controllerInfo: MediaSession.ControllerInfo,
      intent: Intent
    ): Boolean {
      val keyEvent: KeyEvent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
      }
      if (keyEvent?.action == KeyEvent.ACTION_DOWN) {
        when (keyEvent.keyCode) {
          KeyEvent.KEYCODE_MEDIA_NEXT -> {
            remoteDispatcher?.dispatch("remote-next")
            return true
          }
          KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
            remoteDispatcher?.dispatch("remote-previous")
            return true
          }
        }
      }
      return super.onMediaButtonEvent(session, controllerInfo, intent)
    }
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
    session = MediaSession.Builder(this, p)
      .setCallback(sessionCallback)
      .build()
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
    remoteDispatcher = null
    session?.release()
    player?.release()
    session = null
    player = null
    super.onDestroy()
  }
}
