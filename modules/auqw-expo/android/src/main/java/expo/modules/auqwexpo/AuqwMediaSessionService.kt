package expo.modules.auqwexpo

import android.app.PendingIntent
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.view.KeyEvent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
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

    /** The next/previous commands the session advertises and routes
     * to the projection cursor (a single-item ExoPlayer never
     * reports them itself). */
    private val QUEUE_COMMANDS = setOf(
      Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
      Player.COMMAND_SEEK_TO_NEXT,
      Player.COMMAND_SEEK_TO_PREVIOUS,
    )
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

  /**
   * The session's view of the player. Media3 intersects the
   * connection result's advertised commands with the session player's
   * `availableCommands` — and a single-item ExoPlayer never reports
   * next/previous, so lock-screen/SystemUI buttons would render
   * disabled and `onPlayerCommandRequest` unreachable. The wrapper
   * only *reports* the commands: the callback consumes them and the
   * delegate's own seek never runs.
   */
  private class QueuePlayer(player: Player) : ForwardingPlayer(player) {
    override fun getAvailableCommands(): Player.Commands =
      super.getAvailableCommands().buildUpon()
        .also { QUEUE_COMMANDS.forEach(it::add) }
        .build()

    override fun isCommandAvailable(command: Int): Boolean =
      command in QUEUE_COMMANDS || super.isCommandAvailable(command)
  }

  inner class LocalBinder : Binder() {
    // The service is exported (MediaSession controllers bind from
    // SystemUI); the raw player/service handles are same-UID only.
    private fun <T> sameUid(value: T): T? =
      if (Binder.getCallingUid() == Process.myUid()) value else null

    fun player(): ExoPlayer? = sameUid(this@AuqwMediaSessionService.player)

    fun service(): AuqwMediaSessionService? = sameUid(this@AuqwMediaSessionService)
  }

  private val sessionCallback = object : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo
    ): MediaSession.ConnectionResult {
      // Advertise next/previous commands on the session too — the
      // session consumes them through the projection cursor (the
      // QueuePlayer is what makes them report *available*).
      val playerCommands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
        .also { QUEUE_COMMANDS.forEach(it::add) }
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
      val command = when (playerCommand) {
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_NEXT -> "remote-next"
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS -> "remote-previous"
        else -> return super.onPlayerCommandRequest(session, controllerInfo, playerCommand)
      }
      // Consumed only when the projection cursor heard it — a dead
      // dispatcher (module destroyed, service surviving on foreground
      // playback) falls through to the player's own seek instead of
      // swallowing the press.
      remoteDispatcher?.dispatch(command)
        ?: return super.onPlayerCommandRequest(session, controllerInfo, playerCommand)
      return SessionResult.RESULT_ERROR_NOT_SUPPORTED
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
      val command = when (keyEvent?.keyCode) {
        KeyEvent.KEYCODE_MEDIA_NEXT -> "remote-next"
        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "remote-previous"
        else -> null
      }
      if (keyEvent?.action == KeyEvent.ACTION_DOWN && command != null) {
        remoteDispatcher?.dispatch(command)
          ?: return super.onMediaButtonEvent(session, controllerInfo, intent)
        return true
      }
      return super.onMediaButtonEvent(session, controllerInfo, intent)
    }
  }

  override fun onCreate() {
    super.onCreate()
    // The default provider falls back to the launcher icon — a raster
    // square the status bar masks into a solid block. The alpha-only
    // glyph keeps the collapsed notification and shade tile readable.
    setMediaNotificationProvider(
      DefaultMediaNotificationProvider(this).apply {
        setSmallIcon(R.drawable.ic_notification)
      }
    )
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
          // android.media.AudioAttributes.FLAG_LOW_LATENCY (hidden):
          // route off the deep-buffer output — its ~240 ms start cost
          // alone breaks the ≤200 ms attach budget on this APM.
          .setFlags(0x100)
          .build(),
        /* handleAudioFocus= */ true,
      )
      .setWakeMode(C.WAKE_MODE_LOCAL)
      .setHandleAudioBecomingNoisy(true)
      .setLoadControl(loadControl)
      .build()
    player = p
    // The session sees the player through QueuePlayer — the module
    // keeps the raw ExoPlayer, the wrapper only advertises the
    // next/previous commands the projection cursor consumes.
    val builder = MediaSession.Builder(this, QueuePlayer(p))
      .setCallback(sessionCallback)
    // Notification card tap opens the app — without a session
    // activity the notification posts with contentIntent=null and
    // taps are dead. getLaunchIntentForPackage resolves the app's
    // launcher activity without hardcoding its class.
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      builder.setSessionActivity(
        PendingIntent.getActivity(
          this, 0, it,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      )
    }
    val s = builder.build()
    session = s
    // The module's only service contact is the ACTION_LOCAL_BIND
    // binder, which bypasses the SERVICE_INTERFACE/controller-connect
    // path where MediaSessionService.addSession normally runs — and
    // only added sessions feed MediaNotificationManager. Without this,
    // the media notification is never posted and the service never
    // promotes to foreground.
    addSession(s)
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
