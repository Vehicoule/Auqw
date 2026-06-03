package com.Vehicoule.auqw;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import java.io.IOException;
import java.util.HashMap;

public final class AuqwNativeAudioPlayer {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final long UNKNOWN_TIME_MS = -1;

    private static MediaPlayer player;
    private static long activePlaybackId;

    private static final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            MediaPlayer current = player;
            if (current == null) {
                return;
            }
            try {
                if (current.isPlaying()) {
                    notifyState(activePlaybackId, "playing", current.getCurrentPosition(), durationMs(current));
                    MAIN.postDelayed(this, 1000);
                }
            } catch (IllegalStateException ignored) {
                notifyError(activePlaybackId, "Android playback failed");
                releasePlayer();
            }
        }
    };

    private AuqwNativeAudioPlayer() {
    }

    public static void play(long playbackId, String url, HashMap<String, String> headers) {
        MAIN.post(() -> playOnMain(playbackId, url, headers));
    }

    public static void pause(long playbackId) {
        MAIN.post(() -> {
            if (!isCurrentPlayback(playbackId) || player == null) {
                return;
            }
            try {
                player.pause();
                notifyState(playbackId, "paused", player.getCurrentPosition(), durationMs(player));
            } catch (IllegalStateException ignored) {
                notifyError(playbackId, "Android playback failed");
                releasePlayer();
            }
        });
    }

    public static void resume(long playbackId) {
        MAIN.post(() -> {
            if (!isCurrentPlayback(playbackId) || player == null) {
                return;
            }
            try {
                player.start();
                notifyState(playbackId, "playing", player.getCurrentPosition(), durationMs(player));
                scheduleProgress();
            } catch (IllegalStateException ignored) {
                notifyError(playbackId, "Android playback failed");
                releasePlayer();
            }
        });
    }

    public static void stop(long playbackId) {
        MAIN.post(() -> {
            if (!isCurrentPlayback(playbackId)) {
                return;
            }
            notifyState(playbackId, "stopped", 0, player == null ? UNKNOWN_TIME_MS : durationMs(player));
            releasePlayer();
        });
    }

    public static void seek(long playbackId, long positionMs) {
        MAIN.post(() -> {
            if (!isCurrentPlayback(playbackId) || player == null) {
                return;
            }
            try {
                player.seekTo((int) Math.max(0, positionMs));
                notifyState(playbackId, "playing", player.getCurrentPosition(), durationMs(player));
            } catch (IllegalStateException ignored) {
                notifyError(playbackId, "Android playback failed");
                releasePlayer();
            }
        });
    }

    public static void shutdown() {
        MAIN.post(() -> {
            activePlaybackId = 0;
            releasePlayer();
        });
    }

    private static void playOnMain(long playbackId, String url, HashMap<String, String> headers) {
        activePlaybackId = 0;
        releasePlayer();
        activePlaybackId = playbackId;

        Context context = AuqwMediaSessionBridge.context();
        if (context == null || url == null || url.isEmpty()) {
            notifyError(playbackId, "Playback URL is empty");
            return;
        }

        notifyState(playbackId, "loading", 0, UNKNOWN_TIME_MS);

        MediaPlayer nextPlayer = new MediaPlayer();
        player = nextPlayer;
        try {
            nextPlayer.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
            nextPlayer.setOnPreparedListener(mediaPlayer -> {
                if (!isCurrentPlayer(playbackId, mediaPlayer)) {
                    return;
                }
                mediaPlayer.start();
                notifyState(playbackId, "playing", mediaPlayer.getCurrentPosition(), durationMs(mediaPlayer));
                scheduleProgress();
            });
            nextPlayer.setOnCompletionListener(mediaPlayer -> {
                if (!isCurrentPlayer(playbackId, mediaPlayer)) {
                    return;
                }
                long durationMs = durationMs(mediaPlayer);
                notifyState(playbackId, "stopped", durationMs, durationMs);
                releasePlayer();
            });
            nextPlayer.setOnErrorListener((mediaPlayer, what, extra) -> {
                if (!isCurrentPlayer(playbackId, mediaPlayer)) {
                    return true;
                }
                notifyError(playbackId, "Android playback failed");
                releasePlayer();
                return true;
            });
            HashMap<String, String> requestHeaders = headers == null ? new HashMap<>() : headers;
            setRemoteDataSource(context, nextPlayer, url, requestHeaders);
            nextPlayer.prepareAsync();
        } catch (IOException | RuntimeException error) {
            releasePlayer();
            String message = error.getMessage();
            notifyError(playbackId, message == null || message.isEmpty() ? "Android playback failed" : message);
        }
    }

    private static void setRemoteDataSource(
            Context context,
            MediaPlayer nextPlayer,
            String url,
            HashMap<String, String> requestHeaders) throws IOException {
        if (isHttpRemoteUrl(url) && requestHeaders.isEmpty()) {
            nextPlayer.setDataSource(url);
            return;
        }
        nextPlayer.setDataSource(context, Uri.parse(url), requestHeaders);
    }

    private static boolean isHttpRemoteUrl(String url) {
        String lowerUrl = url.toLowerCase();
        return lowerUrl.startsWith("http://") || lowerUrl.startsWith("https://");
    }

    private static boolean isCurrentPlayback(long playbackId) {
        return playbackId != 0 && playbackId == activePlaybackId;
    }

    private static boolean isCurrentPlayer(long playbackId, MediaPlayer mediaPlayer) {
        return isCurrentPlayback(playbackId) && mediaPlayer != null && mediaPlayer == player;
    }

    private static long durationMs(MediaPlayer mediaPlayer) {
        try {
            int duration = mediaPlayer.getDuration();
            return duration < 0 ? UNKNOWN_TIME_MS : duration;
        } catch (IllegalStateException ignored) {
            return UNKNOWN_TIME_MS;
        }
    }

    private static void scheduleProgress() {
        MAIN.removeCallbacks(progressTick);
        MAIN.postDelayed(progressTick, 1000);
    }

    private static void releasePlayer() {
        MAIN.removeCallbacks(progressTick);
        if (player == null) {
            return;
        }
        detachPlayerCallbacks(player);
        try {
            player.reset();
        } catch (IllegalStateException ignored) {
        }
        player.release();
        player = null;
    }

    private static void detachPlayerCallbacks(MediaPlayer mediaPlayer) {
        try {
            mediaPlayer.setOnPreparedListener(null);
            mediaPlayer.setOnCompletionListener(null);
            mediaPlayer.setOnErrorListener(null);
        } catch (RuntimeException ignored) {
        }
    }

    private static void notifyState(long playbackId, String state, long positionMs, long durationMs) {
        try {
            nativeOnPlaybackState(playbackId, state, positionMs, durationMs);
        } catch (UnsatisfiedLinkError ignored) {
        }
    }

    private static void notifyError(long playbackId, String message) {
        try {
            nativeOnPlaybackError(playbackId, message);
        } catch (UnsatisfiedLinkError ignored) {
        }
    }

    private static native void nativeOnPlaybackState(long playbackId, String state, long positionMs, long durationMs);

    private static native void nativeOnPlaybackError(long playbackId, String message);
}
