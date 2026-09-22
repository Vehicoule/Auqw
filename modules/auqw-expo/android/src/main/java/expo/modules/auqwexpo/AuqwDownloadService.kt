package expo.modules.auqwexpo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * `dataSync` foreground service for Slice-3 downloads (plan item 8):
 * keeps network access under Doze and the process alive mid-transfer.
 * It holds NO transfer state — the JS-side DownloadManager owns the
 * ledger; this service is a dumb keep-alive plus an IMPORTANCE_LOW
 * ongoing notification, driven by `downloadsActiveChanged`.
 *
 * Honest resume: on a null-intent restart (the system restarted us
 * after a kill), the volatile count is gone — the service posts
 * nothing and stops itself. Real resume happens on next app start,
 * when the ledger's init() picks `requested`/`transferring` rows back
 * up at their committed offsets. START_STICKY exists only for the
 * app-process-revival case; nothing here promises work it can't see.
 */
class AuqwDownloadService : Service() {

  companion object {
    const val CHANNEL_ID = "auqw-downloads"
    private const val NOTIFICATION_ID = 4157
    private const val EXTRA_ACTIVE = "active"

    /**
     * In-flight transfer count — process-volatile, which is honest:
     * killed with the process alongside the JS DownloadManager.
     */
    @Volatile
    private var activeCount = 0

    /**
     * The module calls this when the active-transfer count changes.
     * >0 starts the FGS (or refreshes its count); 0 delivers an edge
     * the service uses to tear itself down.
     */
    fun update(context: Context, active: Int) {
      activeCount = active
      val intent = Intent(context, AuqwDownloadService::class.java)
        .putExtra(EXTRA_ACTIVE, active)
      if (active > 0) {
        ContextCompat.startForegroundService(context, intent)
      } else {
        // startService, not stopService: the 0 edge must reach
        // onStartCommand so stopForeground runs before stopSelf.
        context.startService(intent)
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "downloads",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "media downloads — posted only while transfers run"
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java)
        ?.createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val reported = intent?.getIntExtra(EXTRA_ACTIVE, -1) ?: -1
    val active = if (reported >= 0) reported else activeCount
    // Null intent on a sticky restart, or a delivered 0 edge: no
    // in-flight transfer exists in this process. Stop honestly —
    // rows resume from committed offsets on the next app-side init().
    if (active <= 0) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
      return START_NOT_STICKY
    }
    startForeground(NOTIFICATION_ID, notification(active))
    return START_STICKY
  }

  private fun notification(active: Int): Notification {
    // Tap → the app's launcher intent; no deep-link fabrication.
    val tap = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(
        if (active == 1) "downloading 1 track" else "downloading $active tracks",
      )
      .setContentText("interrupted transfers resume from their last offset")
      .setOngoing(true)
      .setShowWhen(false)
      .setOnlyAlertOnce(true)
      .setContentIntent(tap)
      .build()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
