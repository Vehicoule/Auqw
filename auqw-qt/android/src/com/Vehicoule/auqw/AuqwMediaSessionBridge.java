package com.Vehicoule.auqw;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class AuqwMediaSessionBridge {
    public static final String ACTION_ENSURE_SESSION = "com.Vehicoule.auqw.playback.ENSURE_SESSION";
    public static final String ACTION_SHUTDOWN = "com.Vehicoule.auqw.playback.SHUTDOWN";
    public static final String ACTION_SYNC = "com.Vehicoule.auqw.playback.SYNC";
    public static final String EXTRA_STATE = "state";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";
    public static final String EXTRA_ALBUM = "album";
    public static final String EXTRA_POSITION_MS = "position_ms";
    public static final String EXTRA_DURATION_MS = "duration_ms";

    private static Context applicationContext;
    private static final long UNSET_POSITION_MS = -1;

    private AuqwMediaSessionBridge() {
    }

    public static synchronized void attach(Context context) {
        if (context != null) {
            applicationContext = context.getApplicationContext();
        }
    }

    public static synchronized void detach(Context context) {
        if (context != null && applicationContext == context.getApplicationContext()) {
            applicationContext = null;
        }
    }

    public static void ensureSession() {
        Context context = context();
        if (context == null) {
            return;
        }

        Intent intent = new Intent(context, AuqwPlaybackService.class);
        intent.setAction(ACTION_ENSURE_SESSION);
        context.startService(intent);
    }

    public static void sync(String state, String title, String artist, String album, long positionMs, long durationMs) {
        Context context = context();
        if (context == null) {
            return;
        }

        Intent intent = new Intent(context, AuqwPlaybackService.class);
        intent.setAction(ACTION_SYNC);
        intent.putExtra(EXTRA_STATE, nullToEmpty(state));
        intent.putExtra(EXTRA_TITLE, nullToEmpty(title));
        intent.putExtra(EXTRA_ARTIST, nullToEmpty(artist));
        intent.putExtra(EXTRA_ALBUM, nullToEmpty(album));
        intent.putExtra(EXTRA_POSITION_MS, positionMs);
        intent.putExtra(EXTRA_DURATION_MS, durationMs);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && startsForeground(state)) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void shutdown() {
        Context context = context();
        if (context == null) {
            return;
        }

        Intent intent = new Intent(context, AuqwPlaybackService.class);
        intent.setAction(ACTION_SHUTDOWN);
        context.startService(intent);
    }

    public static void dispatchPlaybackCommand(String command) {
        dispatchPlaybackCommand(command, UNSET_POSITION_MS);
    }

    public static void dispatchPlaybackCommand(String command, long positionMs) {
        if (command == null || command.isEmpty()) {
            return;
        }

        try {
            nativeDispatchPlaybackCommand(command, positionMs);
        } catch (UnsatisfiedLinkError ignored) {
            // Qt native library may not be loaded if Android replays service events early.
        }
    }

    private static synchronized Context context() {
        return applicationContext;
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static boolean startsForeground(String state) {
        return "playing".equals(state) || "loading".equals(state);
    }

    private static native void nativeDispatchPlaybackCommand(String command, long positionMs);
}
