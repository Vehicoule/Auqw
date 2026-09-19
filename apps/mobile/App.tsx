import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
} from 'auqw-plugin-host-expo';

const VIDEO_IDS = ['dQw4w9WgXcQ', 'kJQP7kiw5Fk'] as const;

const PLUGIN_WASM = require('./assets/plugins/youtube-music.wasm');
const SPIN_WASM = require('./assets/plugins/spin.wasm');
const PLUGIN_MANIFEST = require('./assets/plugins/youtube-music.manifest.json');
const SPIN_MANIFEST = require('./assets/plugins/spin.manifest.json');

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

// ANDROID_VR-minted googlevideo URLs honour any `Range: bytes=`
// chunk; IOS-minted URLs are GVS PO-token-capped to a ~1 MiB prefix
// and 403 the rest. The stream is downloaded in 1 MiB chunks into the
// cache and playback starts once the first chunks are on disk
// (m4a is moov-first). A 403 mid-download is reported as
// `expired-resource` rather than played as a truncated file.
const CHUNK = 1_048_576;
const PLAYBACK_MIN_BYTES = 2 * CHUNK;

class StreamCapped extends Error {
  constructor() {
    super('stream capped by provider');
  }
}

async function downloadStream(
  url: string,
  mime: string,
  onEnoughData: (file: File) => void,
): Promise<void> {
  const ext = mime === 'audio/mp4' ? 'm4a' : 'webm';
  const file = new File(Paths.cache, `auqw-slice0.${ext}`);
  if (file.exists) {
    file.delete();
  }
  file.create();
  const handle = file.open(FileMode.Append);
  let start = 0;
  let total = -1;
  let playbackStarted = false;
  try {
    while (total < 0 || start < total) {
      const end = total < 0 ? start + CHUNK - 1 : Math.min(start + CHUNK - 1, total - 1);
      const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (resp.status === 403) {
        throw new StreamCapped();
      }
      if (!resp.ok) {
        throw new Error(`chunk ${start}-${end}: HTTP ${resp.status}`);
      }
      if (total < 0) {
        const contentRange = resp.headers.get('content-range') ?? '';
        total = Number(contentRange.split('/').pop());
        if (!Number.isFinite(total) || total <= 0) {
          throw new Error('stream size probe failed');
        }
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      handle.writeBytes(bytes);
      start += bytes.length;
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

  const ensureHost = useCallback(async () => {
    if (!hostReady.current) {
      await createHost({ fuelPerEntry: 200_000_000, fuelTotal: 2_000_000_000 });
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

  const startPlayback = useCallback(
    async (url: string, client: string, mime: string) => {
      try {
        await setAudioModeAsync({
          shouldPlayInBackground: true,
          interruptionMode: 'doNotMix',
        });
        await downloadStream(url, mime, (file) => {
          statusSub.current?.remove();
          player.current?.remove();
          const next = createAudioPlayer({ uri: file.uri });
          player.current = next;
          next.setActiveForLockScreen(true, {
            title: 'Auqw Slice 0',
            artist: `resolved via ${client}`,
          });
          statusSub.current = next.addListener(
            'playbackStatusUpdate',
            (status: AudioStatus) => {
              setPhase({
                kind: 'playing',
                positionS: Math.floor(status.currentTime),
                durationS: Math.floor(status.duration),
                client,
                mime,
              });
            },
          );
          next.play();
        });
      } catch (error) {
        if (error instanceof StreamCapped) {
          setPhase({
            kind: 'failed',
            errorKind: 'expired-resource',
            message: 'stream capped by provider',
          });
        } else {
          setPhase({ kind: 'failed', errorKind: 'audio', message: describe(error) });
        }
      }
    },
    [],
  );

  useEffect(() => {
    const subscription = addResolveOutcomeListener((event) => {
      if (event.requestId !== requestId.current) {
        return;
      }
      requestId.current = null;
      const outcome = event.outcome;
      if (outcome.type === 'failed') {
        if (outcome.kind === 'cancelled') {
          setPhase({ kind: 'cancelled' });
        } else {
          setPhase({ kind: 'failed', errorKind: outcome.kind, message: outcome.message });
        }
        return;
      }
      if (outcome.resource.prefixLimited) {
        setPhase({ kind: 'resolving', note: `capped — ${outcome.resource.client} rung` });
      }
      void startPlayback(
        outcome.resource.url,
        outcome.resource.client,
        outcome.resource.mime,
      );
    });
    return () => {
      subscription.remove();
      statusSub.current?.remove();
      player.current?.remove();
    };
  }, [startPlayback]);

  const onPlay = useCallback(async () => {
    if (phase.kind === 'resolving' || phase.kind === 'loading-plugin') {
      return;
    }
    try {
      setPhase({ kind: 'loading-plugin' });
      await ensureHost();
      const id = await ensurePlugin();
      setPhase({ kind: 'resolving' });
      requestId.current = await startResolve(id, videoId);
    } catch (error) {
      setPhase({ kind: 'failed', errorKind: 'runtime', message: describe(error) });
    }
  }, [phase.kind, videoId, ensureHost, ensurePlugin]);

  const onCancel = useCallback(() => {
    if (requestId.current) {
      cancel(requestId.current);
    } else if (player.current?.playing) {
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
      setFuelLine(
        `fuel trap: kind=${report.kind} elapsed=${report.elapsedMs}ms fuel=${report.fuelUsed}`,
      );
    } catch (error) {
      setFuelLine(`fuel trap: failed(${describe(error)})`);
    }
  }, [ensureHost]);

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
