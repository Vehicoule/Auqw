import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { FileHandle } from 'expo-file-system';
import { appError, err, ok } from '@auqw/application';
import { CancellationSource } from '@auqw/application';
import type {
  AppError,
  AttemptTrace,
  IdPort,
  OperationContext,
  PlayableResource,
  PlaybackIdentity,
  PlayerEvent,
  PlayerPort,
  ProviderPort,
  Result,
  SourceRef,
} from '@auqw/application';
import { DownloadFailure, asAppError, downloadTo } from './range-download.ts';
import type { ByteSink, RangeFetch, StreamSource } from './range-download.ts';

function toStreamSource(resource: PlayableResource): StreamSource {
  return {
    url: resource.url,
    mime: resource.mime,
    ...(resource.bitrateKbps === null
      ? {}
      : { bitrateKbps: resource.bitrateKbps }),
    ...(resource.contentLength === null
      ? {}
      : { contentLength: resource.contentLength }),
    ...(resource.itag === null ? {} : { itag: resource.itag }),
    ...(resource.expiresAtMs === null
      ? {}
      : { expiresAtMs: resource.expiresAtMs }),
  };
}

/**
 * The provisional iOS PlayerPort: resolve through the injected
 * ProviderPort, progressive range download to a cache file, expo-audio
 * on the growing file. The stream-seam contract applies where it can:
 * `prepare` returns a request id and the outcome arrives on the event
 * stream; a new prepare supersedes every unattached one; handles are
 * opaque; every event echoes the identity it was invoked with.
 *
 * Honest limits of this surface: no background queue cursor
 * (`setQueueProjection` returns `not-applicable`, so the Session keeps
 * its designed JS-advance fallback), no lock-screen next/previous, and
 * expo-audio's duration on a growing file is an estimate. The Media3
 * seam is the shipped player on Android; this adapter exists so the
 * iOS simulator can exercise the same Session path until the
 * resource-loader seam lands post-release.
 */

const READY_AT_BYTES = 256 * 1024;
const PREPARE_TTL_MS = 120_000;
const RESOLVE_DEADLINE_MS = 15_000;

type AttachedRecord = {
  player: AudioPlayer;
  identity: PlaybackIdentity;
  statusSub: { remove(): void };
};

type PreparedRecord = {
  readonly handle: string;
  readonly requestId: string;
  readonly identity: PlaybackIdentity;
  readonly providerId: string;
  readonly sourceRef: string;
  readonly source: CancellationSource;
  file: File;
  sinkHandle: FileHandle | null;
  downloadDone: boolean;
  ready: boolean;
  failed: AppError | null;
  attached: AttachedRecord | null;
  /** play() is in flight — supersede must not race the attach. */
  attaching: boolean;
  detachedAt: number;
  /** Set while a premature file-end waits on the growing download. */
  resumeAtSec: number | null;
  onBytes: (() => void) | null;
};

function zeroTrace(requestId: string, elapsedMs: number): AttemptTrace {
  return {
    requestId,
    steps: 0,
    httpCalls: 0,
    bytes: 0,
    fuelUsed: 0,
    elapsedMs,
    httpTrace: [],
    guestLog: [],
  };
}

export type ExpoAudioPlayerDeps = {
  readonly providers: ReadonlyMap<string, ProviderPort>;
  readonly ids: IdPort;
  readonly qualityKbps: number;
  readonly directory?: Directory;
  readonly fetchImpl?: RangeFetch;
  readonly now?: () => number;
};

export function createExpoAudioPlayer(deps: ExpoAudioPlayerDeps): PlayerPort {
  const directory = deps.directory ?? Paths.cache;
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<(event: PlayerEvent) => void>();
  const prepared = new Map<string, PreparedRecord>();
  /** In-flight prepares by requestId — cancelPrepare's lookup. */
  const pending = new Map<string, PreparedRecord>();

  function emit(event: PlayerEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber must not break event fan-out.
      }
    }
  }

  function alive(record: PreparedRecord): boolean {
    return prepared.get(record.handle) === record;
  }

  function fileExt(mime: string): string {
    return mime === 'audio/mp4' ? 'm4a' : 'webm';
  }

  function detach(record: PreparedRecord): void {
    if (record.attached !== null) {
      try {
        record.attached.statusSub.remove();
        record.attached.player.remove();
      } catch {
        // Player already released.
      }
      record.attached = null;
      record.detachedAt = now();
    }
  }

  function closeSink(record: PreparedRecord): void {
    if (record.sinkHandle !== null) {
      try {
        record.sinkHandle.close();
      } catch {
        // Already closed.
      }
      record.sinkHandle = null;
    }
  }

  function teardown(record: PreparedRecord): void {
    record.source.cancel();
    detach(record);
    closeSink(record);
    try {
      if (record.file.exists) {
        record.file.delete();
      }
    } catch {
      // A stale cache file is reclaimed by the OS sweep; not fatal.
    }
    prepared.delete(record.handle);
    pending.delete(record.requestId);
  }

  /**
   * End every unattached record — the contract's single-prepare rule
   * where the seam enforces it natively. Records detached past the TTL
   * end `evicted`; live ones end `superseded`. An attach in flight is
   * exempt: it wins the race exactly as the seam's terminal check lets
   * a landed attach win.
   */
  function supersedeUnattached(): void {
    for (const record of [...prepared.values()]) {
      if (record.attached !== null || record.attaching) {
        continue;
      }
      const evicted = now() - record.detachedAt >= PREPARE_TTL_MS;
      emit({
        type: 'prepare',
        requestId: record.requestId,
        identity: record.identity,
        outcome: {
          type: 'failed',
          error: appError(
            evicted ? 'evicted' : 'superseded',
            evicted ? 'prepare evicted' : 'prepare superseded',
          ),
          attempt: zeroTrace(record.requestId, 0),
        },
      });
      teardown(record);
    }
  }

  function openSink(record: PreparedRecord, mime: string): ByteSink {
    closeSink(record);
    const file = new File(directory, `${record.handle}.${fileExt(mime)}`);
    if (file.exists) {
      file.delete();
    }
    file.create();
    record.file = file;
    const sinkHandle = file.open(FileMode.Append);
    record.sinkHandle = sinkHandle;
    return {
      reset() {
        // Re-mint restarts route through openSink (fresh file) — reset
        // is only reachable on a same-encoding resume, where it is a
        // no-op by construction.
      },
      write(bytes: Uint8Array) {
        sinkHandle.writeBytes(bytes);
        record.onBytes?.();
      },
    };
  }

  function failPrepare(
    record: PreparedRecord,
    requestId: string,
    error: AppError,
    elapsedMs: number,
  ): void {
    if (!alive(record)) {
      return;
    }
    if (!record.ready) {
      emit({
        type: 'prepare',
        requestId,
        identity: record.identity,
        outcome: {
          type: 'failed',
          error,
          attempt: zeroTrace(requestId, elapsedMs),
        },
      });
      teardown(record);
      return;
    }
    record.failed = error;
    if (record.attached !== null) {
      emit({
        type: 'status',
        handle: record.handle,
        identity: record.attached.identity,
        state: 'failed',
        positionMs: 0,
        error,
      });
      teardown(record);
    }
  }

  async function runPrepare(record: PreparedRecord): Promise<void> {
    const started = now();
    const fail = (error: AppError): void => {
      pending.delete(record.requestId);
      failPrepare(record, record.requestId, error, now() - started);
    };
    try {
      const provider = deps.providers.get(record.providerId);
      if (provider === undefined) {
        fail(appError('not-found', `no provider ${record.providerId}`));
        return;
      }
      const context: OperationContext = {
        requestId: record.requestId,
        deadlineMs: now() + RESOLVE_DEADLINE_MS,
        signal: record.source.signal,
      };
      const ref: SourceRef = {
        provider: record.providerId,
        kind: 'track',
        id: record.sourceRef,
      };
      const resolved = await provider.resolvePlayback(
        ref,
        {
          targetBitrateKbps: deps.qualityKbps,
          prefer: ['audio/mp4', 'audio/webm'],
          pinItag: null,
          resumeOffset: null,
        },
        context,
      );
      if (!alive(record)) {
        return;
      }
      if (!resolved.ok) {
        fail(resolved.error);
        return;
      }
      const first = toStreamSource(resolved.value);
      const remint = async (): Promise<StreamSource> => {
        const again = await provider.resolvePlayback(
          ref,
          {
            targetBitrateKbps: deps.qualityKbps,
            prefer: ['audio/mp4', 'audio/webm'],
            pinItag: first.itag ?? null,
            resumeOffset: null,
          },
          context,
        );
        if (!again.ok) {
          throw new DownloadFailure(again.error.kind, again.error.message);
        }
        return toStreamSource(again.value);
      };
      await downloadTo({
        first,
        remint,
        openSink: (mime) => openSink(record, mime),
        fetchImpl,
        signal: record.source.signal,
        readyAtBytes: READY_AT_BYTES,
        onReady: () => {
          if (!alive(record)) {
            return;
          }
          record.ready = true;
          emit({
            type: 'prepare',
            requestId: record.requestId,
            identity: record.identity,
            outcome: {
              type: 'prepared',
              stream: {
                handle: record.handle,
                mime: first.mime,
                ...(first.itag === undefined ? {} : { itag: first.itag }),
                ...(first.contentLength === undefined
                  ? {}
                  : { contentLength: first.contentLength }),
                ...(first.expiresAtMs === undefined
                  ? {}
                  : { expiresAtMs: first.expiresAtMs }),
                ...(first.bitrateKbps === undefined
                  ? {}
                  : { bitrateKbps: first.bitrateKbps }),
              },
              attempt: zeroTrace(record.requestId, now() - started),
            },
          });
        },
      });
      record.downloadDone = true;
      closeSink(record);
    } catch (thrown) {
      fail(asAppError(thrown));
      return;
    }
    pending.delete(record.requestId);
  }

  function emitStatus(
    record: PreparedRecord,
    attached: AttachedRecord,
    status: AudioStatus,
  ): void {
    const error = status.error;
    if (typeof error === 'string' && error.length > 0) {
      emit({
        type: 'status',
        handle: record.handle,
        identity: attached.identity,
        state: 'failed',
        positionMs: Math.max(0, Math.floor(status.currentTime * 1000)),
        error: appError('transient', 'playback failed'),
      });
      return;
    }
    if (status.didJustFinish) {
      if (!record.downloadDone) {
        // Growing-file edge, not end-of-stream: wait for more bytes
        // and resume where the player ran out.
        record.resumeAtSec = status.currentTime;
        return;
      }
      emit({
        type: 'status',
        handle: record.handle,
        identity: attached.identity,
        state: 'ended',
        positionMs: Math.max(0, Math.floor(status.currentTime * 1000)),
        ...(status.duration > 0
          ? { durationMs: Math.floor(status.duration * 1000) }
          : {}),
      });
      return;
    }
    const state =
      !status.isLoaded || status.isBuffering
        ? 'buffering'
        : status.playing
          ? 'playing'
          : 'paused';
    emit({
      type: 'status',
      handle: record.handle,
      identity: attached.identity,
      state,
      positionMs: Math.max(0, Math.floor(status.currentTime * 1000)),
      ...(status.duration > 0
        ? { durationMs: Math.floor(status.duration * 1000) }
        : {}),
    });
  }

  return {
    prepare(input) {
      const requestId = deps.ids.next('prep');
      supersedeUnattached();
      const record: PreparedRecord = {
        handle: deps.ids.next('aud'),
        requestId,
        identity: input.identity,
        providerId: input.provider,
        sourceRef: input.sourceRef,
        source: new CancellationSource(),
        file: new File(directory, `${requestId}.tmp`),
        sinkHandle: null,
        downloadDone: false,
        ready: false,
        failed: null,
        attached: null,
        attaching: false,
        detachedAt: now(),
        resumeAtSec: null,
        onBytes: null,
      };
      record.onBytes = () => {
        if (record.resumeAtSec !== null && record.attached !== null) {
          const at = record.resumeAtSec;
          record.resumeAtSec = null;
          void record.attached.player
            .seekTo(at)
            .then(() => record.attached?.player.play())
            .catch(() => undefined);
        }
      };
      prepared.set(record.handle, record);
      pending.set(requestId, record);
      void runPrepare(record);
      return Promise.resolve(ok(requestId));
    },

    async play(input) {
      const record = prepared.get(input.handle);
      if (record === undefined || !record.ready) {
        return err(
          appError('not-found', 'no prepared stream for handle'),
        );
      }
      if (record.failed !== null) {
        return err(record.failed);
      }
      if (record.source.signal.cancelled) {
        return err(appError('cancelled', 'prepare was cancelled'));
      }
      record.attaching = true;
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: 'doNotMix',
        });
        // A teardown racing the audio-mode await leaves nothing to
        // attach to — check before touching the player.
        if (!alive(record) || record.source.signal.cancelled) {
          return err(appError('released', 'stream released'));
        }
        detach(record);
        const player = createAudioPlayer({ uri: record.file.uri });
        const attached: AttachedRecord = {
          player,
          identity: input.identity,
          statusSub: player.addListener(
            'playbackStatusUpdate',
            (status: AudioStatus) => {
              if (record.attached !== attached) {
                return;
              }
              emitStatus(record, attached, status);
            },
          ),
        };
        record.attached = attached;
        if (input.positionMs !== undefined && input.positionMs > 0) {
          await player.seekTo(input.positionMs / 1000);
        }
        player.play();
        return ok(undefined);
      } catch {
        return err(appError('internal', 'player attach failed'));
      } finally {
        record.attaching = false;
      }
    },

    pause(identity) {
      for (const record of prepared.values()) {
        if (record.attached !== null) {
          record.attached.identity = identity;
          record.attached.player.pause();
        }
      }
      return Promise.resolve(ok(undefined));
    },

    seekTo(input) {
      for (const record of prepared.values()) {
        if (record.attached !== null) {
          record.attached.identity = input.identity;
          void record.attached.player
            .seekTo(input.positionMs / 1000)
            .catch(() => undefined);
        }
      }
      return Promise.resolve(ok(undefined));
    },

    stop() {
      for (const record of prepared.values()) {
        detach(record);
      }
      return Promise.resolve(ok(undefined));
    },

    cancelPrepare(input) {
      const record = pending.get(input.requestId);
      if (record === undefined) {
        return Promise.resolve(ok(undefined));
      }
      emit({
        type: 'prepare',
        requestId: record.requestId,
        identity: record.identity,
        outcome: {
          type: 'failed',
          error: appError('cancelled', 'cancelled'),
          attempt: zeroTrace(record.requestId, 0),
        },
      });
      teardown(record);
      return Promise.resolve(ok(undefined));
    },

    release(input) {
      const record = prepared.get(input.handle);
      if (record !== undefined) {
        teardown(record);
      }
      return Promise.resolve(ok(undefined));
    },

    setQueueProjection() {
      // No service cursor exists on this surface — the Session's
      // designed fallback (JS-side advance on `ended`) engages on a
      // failed install, which is exactly the honest answer here.
      return Promise.resolve(
        err(
          appError(
            'not-applicable',
            'queue projection unsupported on the provisional player',
          ),
        ),
      );
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
