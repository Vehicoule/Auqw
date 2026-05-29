package com.Vehicoule.auqw;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;

public class AuqwPlaybackService extends Service {
    private static final String CHANNEL_ID = "auqw_playback";
    private static final int NOTIFICATION_ID = 41;

    private MediaSession mediaSession;
    private String playbackState = "stopped";
    private String title = "";
    private String artist = "";
    private String album = "";
    private long positionMs = 0;
    private long durationMs = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        mediaSession = new MediaSession(this, "Auqw");
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                publishCommand("play");
            }

            @Override
            public void onPause() {
                publishCommand("pause");
            }

            @Override
            public void onStop() {
                publishCommand("stop");
            }

            @Override
            public void onSkipToNext() {
                publishCommand("next");
            }

            @Override
            public void onSkipToPrevious() {
                publishCommand("previous");
            }
        });
        mediaSession.setActive(true);
        updateSession();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? AuqwMediaSessionBridge.ACTION_ENSURE_SESSION : intent.getAction();

        if (AuqwMediaSessionBridge.ACTION_SHUTDOWN.equals(action)) {
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }

        if (AuqwMediaSessionBridge.ACTION_SYNC.equals(action)) {
            playbackState = intent.getStringExtra(AuqwMediaSessionBridge.EXTRA_STATE);
            title = intent.getStringExtra(AuqwMediaSessionBridge.EXTRA_TITLE);
            artist = intent.getStringExtra(AuqwMediaSessionBridge.EXTRA_ARTIST);
            album = intent.getStringExtra(AuqwMediaSessionBridge.EXTRA_ALBUM);
            positionMs = intent.getLongExtra(AuqwMediaSessionBridge.EXTRA_POSITION_MS, 0);
            durationMs = intent.getLongExtra(AuqwMediaSessionBridge.EXTRA_DURATION_MS, 0);
        }

        updateSession();
        if (isForegroundState(playbackState)) {
            startForeground(NOTIFICATION_ID, buildNotification());
        } else {
            stopForegroundCompat();
        }

        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    private void updateSession() {
        if (mediaSession == null) {
            return;
        }

        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, fallbackTitle())
            .putString(MediaMetadata.METADATA_KEY_ARTIST, safeText(artist))
            .putString(MediaMetadata.METADATA_KEY_ALBUM, safeText(album));
        if (durationMs > 0) {
            metadata.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        }
        mediaSession.setMetadata(metadata.build());

        long actions = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_STOP
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SEEK_TO;
        PlaybackState.Builder state = new PlaybackState.Builder()
            .setActions(actions)
            .setState(androidPlaybackState(playbackState), positionMs, 1.0f);
        mediaSession.setPlaybackState(state.build());
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;
        if (launchIntent != null) {
            contentIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(fallbackTitle())
            .setContentText(notificationSubtitle())
            .setOnlyAlertOnce(true)
            .setOngoing("playing".equals(playbackState))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setStyle(new Notification.MediaStyle().setMediaSession(mediaSession.getSessionToken()));

        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }

        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Playback",
            NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Auqw playback controls");
        manager.createNotificationChannel(channel);
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private void publishCommand(String command) {
        Intent intent = new Intent("com.Vehicoule.auqw.playback.COMMAND");
        intent.setPackage(getPackageName());
        intent.putExtra("command", command);
        sendBroadcast(intent);
    }

    private String fallbackTitle() {
        return safeText(title).isEmpty() ? "Auqw" : safeText(title);
    }

    private String notificationSubtitle() {
        String safeArtist = safeText(artist);
        String safeAlbum = safeText(album);
        if (!safeArtist.isEmpty() && !safeAlbum.isEmpty()) {
            return safeArtist + " - " + safeAlbum;
        }
        if (!safeArtist.isEmpty()) {
            return safeArtist;
        }
        if (!safeAlbum.isEmpty()) {
            return safeAlbum;
        }
        return safeText(playbackState);
    }

    private static String safeText(String value) {
        return value == null ? "" : value;
    }

    private static boolean isForegroundState(String state) {
        return "playing".equals(state) || "loading".equals(state);
    }

    private static int androidPlaybackState(String state) {
        if ("playing".equals(state)) {
            return PlaybackState.STATE_PLAYING;
        }
        if ("paused".equals(state)) {
            return PlaybackState.STATE_PAUSED;
        }
        if ("loading".equals(state)) {
            return PlaybackState.STATE_BUFFERING;
        }
        if ("error".equals(state)) {
            return PlaybackState.STATE_ERROR;
        }
        return PlaybackState.STATE_STOPPED;
    }
}
