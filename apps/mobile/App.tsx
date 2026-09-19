import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Asset } from 'expo-asset';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { File, FileMode, Paths } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import type { EventSubscription } from 'expo-modules-core';
import {
  addResolveOutcomeListener,
  cancel,
  createHost,
  loadPlugin,
  runSpin,
  startResolve,
  type ResolvedResource,
} from 'auqw-plugin-host-expo';

const VIDEO_IDS = ['dQw4w9WgXcQ', 'kJQP7kiw5Fk'] as const;

// PO-token service (bgutil /get_pot contract). Off unless configured —
// set EXPO_PUBLIC_POT_PROVIDER_URL at bundle time (from the Android
// emulator, http://10.0.2.2:4416 reaches a provider on the host
// machine). Unset: the resolve stays on the anonymous ladder.
const POT_PROVIDER_URL = process.env.EXPO_PUBLIC_POT_PROVIDER_URL || undefined;

const PLUGIN_WASM = require('./assets/plugins/youtube-music.wasm');
const SPIN_WASM = require('./assets/plugins/spin.wasm');
const PLUGIN_MANIFEST = require('./assets/plugins/youtube-music.manifest.json');
const SPIN_MANIFEST = require('./assets/plugins/spin.manifest.json');

// Slice-0 gate evidence: every [slice0] line also lands in the app
// container so `adb run-as` / `simctl get_app_container` can read it
// while the screen is off and metro may not be watched.
let logHandle: ReturnType<File['open']> | null = null;
function slog(line: string): void {
  console.log(`[slice0] ${line}`);
  try {
    if (!logHandle) {
      const f = new File(Paths.cache, 'auqw-slice0.log');
      if (f.exists) {
        f.delete();
      }
      f.create();
      logHandle = f.open(FileMode.Append);
    }
    logHandle.writeBytes(new TextEncoder().encode(`${line}\n`));
  } catch {
    // logging must never break the gate path
  }
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading-plugin' }
  | { kind: 'resolving'; note?: string }
  | {
      kind: 'playing';
      positionS: number;
      durationS: number;
      client: string;
      mime: string;
    }
  | { kind: 'failed'; errorKind: string; message: string }
  | { kind: 'cancelled' };

function statusText(phase: Phase): string {
  switch (phase.kind) {
    case 'idle':
      return 'idle';
    case 'loading-plugin':
      return 'loading-plugin';
    case 'resolving':
      return phase.note ? `resolving — ${phase.note}` : 'resolving';
    case 'playing':
      return `playing(${phase.positionS}s / ${phase.durationS}s, ${phase.client}, ${phase.mime})`;
    case 'failed':
      return `failed(${phase.errorKind}, ${phase.message})`;
    case 'cancelled':
      return 'cancelled';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function wasmAssetBase64(moduleRef: number): Promise<string> {
  const asset = Asset.fromModule(moduleRef);
  await asset.downloadAsync();
  if (!asset.localUri) {
    throw new Error('asset has no localUri after download');
  }
  return new File(asset.localUri).base64();
}

// Minted googlevideo URLs may stop serving mid-download (GVS caps are
// stochastic per-mint). On a 403 the downloader re-resolves for a fresh
// mint and resumes at the written offset — the predecessor's mint
// loop — but a mint that serves no new bytes counts as zero progress:
// after two in a row the cap is reported as `expired-resource` rather
// than hammering /player or playing a truncated file. Playback starts
// once PLAYBACK_MIN_BYTES are on disk (m4a is moov-first; the old app
// used 128 KiB, ExoPlayer gets a margin). A re-mint that returns a
// different encoding (mime/length changed) restarts the file — splicing
// bytes across encodings would corrupt the stream.
const CHUNK = 1_048_576;
const PLAYBACK_MIN_BYTES = 256 * 1024;
const MINT_BUDGET = 8;
const ZERO_PROGRESS_MINT_LIMIT = 2;
// One stalled chunk fetch cannot park the gate run forever: the
// timeout covers headers AND the body read (1 MiB stays under it even
// at GVS's ~33 KB/s throttle). `signal` carries Cancel into the loop.
const CHUNK_TIMEOUT_MS = 60_000;

class StreamCapped extends Error {
  constructor() {
    super('stream capped by provider');
  }
}

type Chunk = {
  status: number;
  contentRange: string | null;
  bytes: Uint8Array;
};

async function fetchChunk(
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Chunk> {
  // The host already validates the resolved url against the manifest
  // allowlist; this is the app's own belt at the actual fetch site.
  if (!url.startsWith('https://')) {
    throw new Error('refusing non-https stream url');
  }
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) {
    ctl.abort();
  }
  const timer = setTimeout(() => ctl.abort(), CHUNK_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: ctl.signal,
    });
    // Only a 206 carries bytes we want. Buffering the body before the
    // status check would read a whole-file 200 — or an unbounded error
    // body — into memory for nothing.
    const bytes =
      resp.status === 206 ? new Uint8Array(await resp.arrayBuffer()) : new Uint8Array(0);
    return {
      status: resp.status,
      contentRange: resp.headers.get('content-range'),
      bytes,
    };
  } catch (error) {
    if (!signal.aborted && (error as Error).name === 'AbortError') {
      throw new Error(`chunk ${start}-${end}: timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function downloadStream(
  first: ResolvedResource,
  remint: () => Promise<ResolvedResource>,
  signal: AbortSignal,
  onEnoughData: (file: File) => void,
): Promise<void> {
  const ext = first.mime === 'audio/mp4' ? 'm4a' : 'webm';
  const file = new File(Paths.cache, `auqw-slice0.${ext}`);
  if (file.exists) {
    file.delete();
  }
  file.create();
  let handle = file.open(FileMode.Append);
  let url = first.url;
  let start = 0;
  let total = first.contentLength ?? -1;
  let playbackStarted = false;
  let mints = 0;
  let zeroProgress = 0;
  let mintStart = 0;
  const restart = () => {
    handle.close();
    file.delete();
    file.create();
    handle = file.open(FileMode.Append);
    start = 0;
    mintStart = 0;
    playbackStarted = false;
  };
  try {
    while (total < 0 || start < total) {
      const end = total < 0 ? start + CHUNK - 1 : Math.min(start + CHUNK - 1, total - 1);
      const chunk = await fetchChunk(url, start, end, signal);
      // 403 is the known cap signal; 416 on an in-range request means the
      // mint no longer serves the byte window we know exists — same
      // treatment: re-mint and resume, bounded by the progress budget.
      if (chunk.status === 403 || chunk.status === 416) {
        zeroProgress = start === mintStart ? zeroProgress + 1 : 0;
        if (zeroProgress >= ZERO_PROGRESS_MINT_LIMIT || mints >= MINT_BUDGET) {
          throw new StreamCapped();
        }
        mints += 1;
        const fresh = await remint();
        if (fresh.mime === first.mime && fresh.contentLength === first.contentLength) {
          mintStart = start;
          url = fresh.url;
        } else {
          restart();
          total = fresh.contentLength ?? -1;
          url = fresh.url;
        }
        continue;
      }
      // Every request sends a Range, so anything but 206 is a serving
      // violation — a mid-stream 200 would append the whole file at the
      // resume offset and corrupt the download.
      if (chunk.status !== 206) {
        throw new Error(`chunk ${start}-${end}: HTTP ${chunk.status}`);
      }
      if (total < 0) {
        total = Number((chunk.contentRange ?? '').split('/').pop());
        if (!Number.isFinite(total) || total <= 0) {
          throw new Error('stream size probe failed');
        }
      }
      // An empty partial body makes no progress — without this check
      // the loop re-requests the same window forever.
      if (chunk.bytes.length === 0) {
        throw new Error(`chunk ${start}-${end}: empty body`);
      }
      // A 206 that over-serves would corrupt the file by overlapping
      // the next range fetch.
      if (chunk.bytes.length > end - start + 1) {
        throw new Error(`chunk ${start}-${end}: oversized body`);
      }
      handle.writeBytes(chunk.bytes);
      start += chunk.bytes.length;
      if (!playbackStarted && start >= PLAYBACK_MIN_BYTES) {
        playbackStarted = true;
        onEnoughData(file);
      }
    }
  } finally {
    handle.close();
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [fuelLine, setFuelLine] = useState<string>('');
  const [videoId, setVideoId] = useState<string>(VIDEO_IDS[0]);

  const hostReady = useRef(false);
  const pluginId = useRef<string | null>(null);
  const player = useRef<AudioPlayer | null>(null);
  const statusSub = useRef<EventSubscription | null>(null);
  const requestId = useRef<string | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const pendingResolves = useRef(
    new Map<
      string,
      {
        resolve: (resource: ResolvedResource) => void;
        reject: (error: Error & { kind?: string }) => void;
      }
    >(),
  );

  const ensureHost = useCallback(async () => {
    if (!hostReady.current) {
      await createHost({
        fuelPerEntry: 200_000_000,
        fuelTotal: 2_000_000_000,
        potProviderUrl: POT_PROVIDER_URL,
      });
      hostReady.current = true;
    }
  }, []);

  const ensurePlugin = useCallback(async () => {
    if (!pluginId.current) {
      const wasmBase64 = await wasmAssetBase64(PLUGIN_WASM);
      pluginId.current = await loadPlugin(wasmBase64, JSON.stringify(PLUGIN_MANIFEST));
    }
    return pluginId.current;
  }, []);

  // Promise-shaped resolve: the outcome event settles the deferred
  // recorded under the request id. `requestId.current` still tracks
  // the in-flight id so Cancel aborts it at the host.
  const resolveOnce = useCallback(
    async (sourceRef: string): Promise<ResolvedResource> => {
      const id = await ensurePlugin();
      const reqId = await startResolve(id, sourceRef);
      requestId.current = reqId;
      return new Promise<ResolvedResource>((resolve, reject) => {
        pendingResolves.current.set(reqId, { resolve, reject });
      });
    },
    [ensurePlugin],
  );

  const startPlayback = useCallback(
    async (
      resource: ResolvedResource,
      remint: () => Promise<ResolvedResource>,
    ) => {
      const ctl = new AbortController();
      downloadAbort.current = ctl;
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: 'doNotMix',
        });
        await downloadStream(resource, remint, ctl.signal, (file) => {
          statusSub.current?.remove();
          player.current?.remove();
          const next = createAudioPlayer({ uri: file.uri });
          player.current = next;
          next.setActiveForLockScreen(true, {
            title: 'Auqw Slice 0',
            artist: `resolved via ${resource.client}`,
          });
          statusSub.current = next.addListener(
            'playbackStatusUpdate',
            (status: AudioStatus) => {
              const positionS = Math.floor(status.currentTime);
              const durationS = Math.floor(status.duration);
              slog(`pos=${positionS}s/${durationS}s t=${Date.now()}`);
              setPhase({
                kind: 'playing',
                positionS,
                durationS,
                client: resource.client,
                mime: resource.mime,
              });
            },
          );
          next.play();
        });
      } catch (error) {
        // A superseded download (a newer Play owns downloadAbort now)
        // must not write its outcome over the new chain's phase.
        if (downloadAbort.current !== ctl) {
          return;
        }
        const kind = (error as { kind?: string }).kind;
        if (ctl.signal.aborted || kind === 'cancelled') {
          setPhase({ kind: 'cancelled' });
        } else if (error instanceof StreamCapped) {
          setPhase({
            kind: 'failed',
            errorKind: 'expired-resource',
            message: 'stream capped by provider',
          });
        } else {
          setPhase({
            kind: 'failed',
            errorKind: kind ?? 'audio',
            message: describe(error),
          });
        }
      } finally {
        if (downloadAbort.current === ctl) {
          downloadAbort.current = null;
        }
      }
    },
    [],
  );

  useEffect(() => {
    const subscription = addResolveOutcomeListener((event) => {
      const pending = pendingResolves.current.get(event.requestId);
      if (!pending) {
        return;
      }
      pendingResolves.current.delete(event.requestId);
      if (requestId.current === event.requestId) {
        requestId.current = null;
      }
      const outcome = event.outcome;
      slog(
        `outcome ${event.requestId} type=${outcome.type}` +
          `${outcome.type === 'failed' ? ` kind=${outcome.kind}` : ''} t=${Date.now()}`,
      );
      if (outcome.type === 'resolved') {
        pending.resolve(outcome.resource);
      } else {
        pending.reject(
          Object.assign(new Error(outcome.message), { kind: outcome.kind }),
        );
      }
    });
    return () => {
      subscription.remove();
      statusSub.current?.remove();
      player.current?.remove();
    };
  }, []);

  const onPlay = useCallback(
    async (targetId?: string) => {
      if (phase.kind === 'resolving' || phase.kind === 'loading-plugin') {
        return;
      }
      const vid = targetId ?? videoId;
      try {
        // Detach the previous player first: its status listener would keep
        // writing `playing` over the resolving/failed phases while the new
        // resolve is in flight. The previous download is aborted too —
        // an orphaned loop would keep fetching into the deleted file and
        // clobber downloadAbort.current when it finished.
        statusSub.current?.remove();
        statusSub.current = null;
        player.current?.remove();
        player.current = null;
        downloadAbort.current?.abort();
        downloadAbort.current = null;
        setPhase({ kind: 'loading-plugin' });
        await ensureHost();
        setPhase({ kind: 'resolving' });
        const resource = await resolveOnce(vid);
        setPhase({ kind: 'resolving', note: `downloading — ${resource.client}` });
        await startPlayback(resource, () => resolveOnce(vid));
      } catch (error) {
        const kind = (error as { kind?: string }).kind;
        if (kind === 'cancelled') {
          setPhase({ kind: 'cancelled' });
        } else if (kind) {
          setPhase({
            kind: 'failed',
            errorKind: kind,
            message: describe(error),
          });
        } else {
          setPhase({ kind: 'failed', errorKind: 'runtime', message: describe(error) });
        }
      }
    },
    [phase.kind, videoId, ensureHost, resolveOnce, startPlayback],
  );

  const onCancel = useCallback(() => {
    if (requestId.current) {
      slog(`cancel-sent ${requestId.current} t=${Date.now()}`);
      cancel(requestId.current);
    }
    // A returned resolve leaves no request id — aborting the range
    // loop is what stops an in-flight download.
    downloadAbort.current?.abort();
    if (!requestId.current && player.current?.playing) {
      player.current.pause();
      setPhase({ kind: 'cancelled' });
    }
  }, []);

  const onFuelTrap = useCallback(async () => {
    try {
      setFuelLine('fuel trap: running…');
      await ensureHost();
      const wasmBase64 = await wasmAssetBase64(SPIN_WASM);
      const report = await runSpin(wasmBase64, JSON.stringify(SPIN_MANIFEST));
      const line = `fuel trap: kind=${report.kind} elapsed=${report.elapsedMs}ms fuel=${report.fuelUsed}`;
      slog(line);
      setFuelLine(line);
    } catch (error) {
      setFuelLine(`fuel trap: failed(${describe(error)})`);
    }
  }, [ensureHost]);

  // auqw://play/<videoId> | auqw://spin | auqw://cancel — the Slice-0
  // gate runner's handle on the app (adb am start / simctl openurl).
  // iOS puts a "Open in …?" sheet on every openurl into a running app,
  // so a headless gate run also accepts the same verbs written one per
  // line into <cache>/auqw-cmd (simctl container / adb run-as). Both
  // channels are dev-gate instrumentation — remove before any release
  // build.
  useEffect(() => {
    const runCommand = (verb: string, arg: string | undefined) => {
      slog(`cmd ${verb} ${arg ?? ''} t=${Date.now()}`);
      if (verb === 'play') {
        void onPlay(arg || undefined);
      } else if (verb === 'spin') {
        void onFuelTrap();
      } else {
        onCancel();
      }
    };
    const onUrl = ({ url }: { url: string }) => {
      const match = url.match(/^auqw:\/\/(play|spin|cancel)\/?([^\s/]*)$/);
      if (match?.[1]) {
        runCommand(match[1], match[2]);
      }
    };
    const sub = Linking.addEventListener('url', onUrl);
    void Linking.getInitialURL().then((initial) => {
      if (initial) {
        onUrl({ url: initial });
      }
    });
    const cmdFile = new File(Paths.cache, 'auqw-cmd');
    const poll = setInterval(() => {
      try {
        if (!cmdFile.exists) {
          return;
        }
        const text = cmdFile.textSync();
        cmdFile.delete();
        for (const line of text.split('\n')) {
          const match = line.trim().match(/^(play|spin|cancel)(?:\s+(\S+))?$/);
          if (match?.[1]) {
            runCommand(match[1], match[2]);
          }
        }
      } catch {
        // command channel must never break the gate path
      }
    }, 500);
    return () => {
      sub.remove();
      clearInterval(poll);
    };
  }, [onPlay, onFuelTrap, onCancel]);

  const busy = phase.kind === 'resolving' || phase.kind === 'loading-plugin';

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Auqw — Slice 0</Text>
      <Text style={styles.status} accessibilityLiveRegion="polite">
        {statusText(phase)}
      </Text>
      {fuelLine !== '' && <Text style={styles.fuel}>{fuelLine}</Text>}
      <View style={styles.idRow}>
        {VIDEO_IDS.map((id) => (
          <Pressable
            key={id}
            accessibilityRole="button"
            accessibilityLabel={`Video ${id}`}
            accessibilityState={{ disabled: busy, selected: id === videoId }}
            disabled={busy}
            onPress={() => setVideoId(id)}
            style={({ pressed }) => [
              styles.idButton,
              id === videoId && styles.idButtonSelected,
              (busy || pressed) && styles.buttonDim,
            ]}
          >
            <Text style={[styles.idText, id === videoId && styles.idTextSelected]}>{id}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Play"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void onPlay()}
          style={({ pressed }) => [styles.button, (busy || pressed) && styles.buttonDim]}
        >
          <Text style={styles.buttonText}>Play</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          style={({ pressed }) => [styles.button, pressed && styles.buttonDim]}
        >
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Measure fuel trap"
          onPress={() => void onFuelTrap()}
          style={({ pressed }) => [styles.button, pressed && styles.buttonDim]}
        >
          <Text style={styles.buttonText}>Measure fuel trap</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  status: {
    fontSize: 14,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 12,
  },
  fuel: {
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 12,
    color: '#444',
  },
  idRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  idButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#0a7ea4',
  },
  idButtonSelected: {
    backgroundColor: '#0a7ea4',
  },
  idText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#0a7ea4',
  },
  idTextSelected: {
    color: '#fff',
  },
  buttons: {
    flexDirection: 'column',
    gap: 12,
    alignSelf: 'stretch',
  },
  button: {
    backgroundColor: '#0a7ea4',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDim: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
