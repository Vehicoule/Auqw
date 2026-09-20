// ── Slice 1.5 seam dev instrumentation ─────────────────────────────
// Driven ONLY by the auqw://seam* deep links dispatched from App.tsx:
//   auqw://seam-file?path=…        gate-0 file leg (same warm player)
//   auqw://seam-audio?path=…       gate-0 expo-audio file:// leg
//   auqw://seam?provider=…&ref=…   prepared path — prepare + attach
//   auqw://seam-prepare?provider=…&ref=…   stream prepare (staged leg)
//   auqw://seam-attach?handle=…    attach last/provided prepared handle
//   auqw://seam-metrics            dump Rust-side phase marks
//   auqw://seam-url?url=…&mime=…   dev seam leg — real prepared session
//                                  for a bare URL (no guest resolve)
//   auqw://seam-queue?url=…&title=…  projection leg — installs a 2-item
//                                  projection then attaches: exercises the
//                                  CURSOR occurrence bind + MediaMetadata
// Self-contained (own logger + listeners) so App.tsx stays a one-block
// diff for the s1 merge. Dev-gate only — no shipped semantics.
import { Asset } from 'expo-asset';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, FileMode, Paths } from 'expo-file-system';
import {
  addPhaseMarkListener,
  addPlaybackStatusListener,
  addPrepareOutcomeListener,
  createHost,
  devAttachFile,
  devPrepareUrl,
  loadPlugin,
  phaseMarks,
  play,
  prepare,
  setQueueProjection,
  type PrepareOutcomeEvent,
} from 'auqw-expo';

const POT_PROVIDER_URL = process.env.EXPO_PUBLIC_POT_PROVIDER_URL || undefined;
const PLUGIN_WASM = require('./assets/plugins/youtube-music.wasm');
const PLUGIN_MANIFEST = require('./assets/plugins/youtube-music.manifest.json');

let logHandle: ReturnType<File['open']> | null = null;
function slog(line: string): void {
  console.log(`[s1.5] ${line}`);
  if (!__DEV__) {
    return;
  }
  try {
    if (!logHandle) {
      const f = new File(Paths.cache, 'auqw-seam.log');
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

let armed = false;
let hostReady = false;
let pluginId: string | null = null;
let lastHandle: string | null = null;
let lastRequestId: string | null = null;
let audioLeg: AudioPlayer | null = null;
// Single pending outcome for the one-shot `seam` leg — the harness is
// sequential, so one slot suffices.
let pendingPrepare: ((e: PrepareOutcomeEvent) => void) | null = null;

function arm(): void {
  if (armed) {
    return;
  }
  armed = true;
  addPrepareOutcomeListener((e) => {
    if (e.outcome.type === 'prepared') {
      lastHandle = e.outcome.stream.handle;
      slog(`prepared req=${e.requestId} handle=${lastHandle} mime=${e.outcome.stream.mime} t=${Date.now()}`);
    } else {
      slog(`prepare-failed req=${e.requestId} kind=${e.outcome.kind} t=${Date.now()}`);
    }
    pendingPrepare?.(e);
    pendingPrepare = null;
  });
  addPlaybackStatusListener((e) => {
    slog(`status ${e.handle} ${e.state} pos=${e.positionMs}ms t=${Date.now()}`);
  });
  addPhaseMarkListener((e) => {
    slog(`mark ${e.handle} ${e.name} +${e.sinceStartMs}ms t=${e.atMs}`);
  });
}

async function ensureHost(): Promise<void> {
  if (!hostReady) {
    // Same fuel config as App.tsx's ensureHost.
    await createHost({
      fuelPerEntry: 200_000_000,
      fuelTotal: 2_000_000_000,
      potProviderUrl: POT_PROVIDER_URL,
    });
    hostReady = true;
  }
}

async function ensureSeam(): Promise<string> {
  await ensureHost();
  if (!pluginId) {
    const asset = Asset.fromModule(PLUGIN_WASM);
    await asset.downloadAsync();
    if (!asset.localUri) {
      throw new Error('wasm asset has no localUri');
    }
    pluginId = await loadPlugin(
      await new File(asset.localUri).base64(),
      JSON.stringify(PLUGIN_MANIFEST),
    );
  }
  return pluginId;
}

function param(query: string, key: string): string | null {
  // `am start -d` on Android truncates the intent URI at the first
  // literal `&` — dev links may use `;` as the separator instead.
  for (const pair of query.split(/[&;]/)) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === key) {
      return decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return null;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // Expo coded errors carry the taxonomy kind as `code` — surface it
    // so leg logs show the kind that crossed the boundary, not just text.
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

export async function runSeamLink(url: string): Promise<void> {
  const match = url.match(/^auqw:\/\/(seam-file|seam-audio|seam-prepare|seam-attach|seam-metrics|seam-url|seam-queue|seam)(?:\?([^\s]*))?$/);
  if (!match?.[1]) {
    return;
  }
  const query = match[2] ?? '';
  arm();
  try {
    if (match[1] === 'seam-file') {
      const path = param(query, 'path');
      if (!path) {
        return;
      }
      lastHandle = await devAttachFile(path);
      slog(`seam-file attached handle=${lastHandle} t=${Date.now()}`);
    } else if (match[1] === 'seam-audio') {
      // The spec's comparison leg: expo-audio on the same file — its
      // own player stack, so the number isolates our Media3 floor.
      const path = param(query, 'path');
      if (!path) {
        return;
      }
      const uri = path.startsWith('file://') ? path : `file://${path}`;
      const t0 = Date.now();
      audioLeg?.remove();
      audioLeg = createAudioPlayer({ uri });
      const player = audioLeg;
      const sub = player.addListener('playbackStatusUpdate', (status) => {
        if (status.playing) {
          slog(`seam-audio playing +${Date.now() - t0}ms`);
          sub.remove();
        } else if (status.error) {
          slog(`seam-audio error ${status.error}`);
          sub.remove();
        }
      });
      player.play();
      slog(`seam-audio sent uri=${uri} t=${t0}`);
    } else if (match[1] === 'seam') {
      // The prepared-path leg the slice names `seam`: prepare, then
      // attach the produced handle — attach→rendered-first-frame is
      // the ≤200 ms metric the gates measure.
      const ref = param(query, 'ref');
      if (!ref) {
        return;
      }
      const id = await ensureSeam();
      const provider = param(query, 'provider') ?? id;
      const outcomeP = new Promise<PrepareOutcomeEvent>((resolve) => {
        pendingPrepare = resolve;
      });
      lastRequestId = await prepare(provider, ref, `dev-${Date.now()}`, 0);
      const e = await outcomeP;
      if (e.outcome.type !== 'prepared') {
        slog(`seam prepare failed kind=${e.outcome.kind}`);
        return;
      }
      lastHandle = e.outcome.stream.handle;
      await play(lastHandle, `dev-${Date.now()}`, 0);
      slog(`seam prepared+attached handle=${lastHandle} t=${Date.now()}`);
    } else if (match[1] === 'seam-prepare') {
      const ref = param(query, 'ref');
      if (!ref) {
        return;
      }
      const id = await ensureSeam();
      const provider = param(query, 'provider') ?? id;
      lastRequestId = await prepare(provider, ref, `dev-${Date.now()}`, 0);
      slog(`seam-prepare sent req=${lastRequestId} t=${Date.now()}`);
    } else if (match[1] === 'seam-url') {
      // Dev E2E leg: real prepared session for a bare URL — sparse
      // store, pump, fetch-through, DataSource, Media3 all exercised;
      // only the guest resolve is skipped.
      const streamUrl = param(query, 'url');
      if (!streamUrl) {
        return;
      }
      const mime = param(query, 'mime') ?? 'audio/mp4';
      const bytes = param(query, 'bytes');
      const pos = param(query, 'pos');
      await ensureHost();
      const t0 = Date.now();
      lastHandle = await devPrepareUrl(
        streamUrl,
        mime,
        bytes ? Number(bytes) : undefined,
      );
      slog(`seam-url prepared handle=${lastHandle} +${Date.now() - t0}ms`);
      const ta = Date.now();
      await play(lastHandle, `dev-${Date.now()}`, 0, pos ? Number(pos) : undefined);
      slog(`seam-url attach-sent handle=${lastHandle} pos=${pos ?? 0} +${Date.now() - ta}ms total+${Date.now() - t0}ms`);
    } else if (match[1] === 'seam-queue') {
      // Projection leg: install a 2-item identified revision whose
      // cursor carries title/artist, then attach a prepared dev URL —
      // the CURSOR bind resolves the cursor item so the attach stamps
      // MediaMetadata onto the MediaItem (the lock-screen source).
      const streamUrl = param(query, 'url');
      if (!streamUrl) {
        return;
      }
      const mime = param(query, 'mime') ?? 'audio/mp4';
      const bytes = param(query, 'bytes');
      const title = param(query, 'title') ?? 'dev title';
      const artist = param(query, 'artist');
      await ensureHost();
      lastHandle = await devPrepareUrl(
        streamUrl,
        mime,
        bytes ? Number(bytes) : undefined,
      );
      slog(`seam-queue prepared handle=${lastHandle} t=${Date.now()}`);
      await setQueueProjection({
        projectionId: `dev-proj-${Date.now()}`,
        queueRev: 1,
        currentOccurrenceId: 'occ-a',
        positionMs: 0,
        mode: 'playing',
        items: [
          {
            occurrenceId: 'occ-a',
            provider: null,
            sourceRef: null,
            title,
            artist,
            artworkUrl: null,
          },
          {
            occurrenceId: 'occ-b',
            provider: null,
            sourceRef: null,
            title: 'dev next',
            artist: null,
            artworkUrl: null,
          },
        ],
      });
      await play(lastHandle, `dev-${Date.now()}`, 1);
      slog(`seam-queue attached handle=${lastHandle} t=${Date.now()}`);
    } else if (match[1] === 'seam-attach') {
      const handle = param(query, 'handle') ?? lastHandle;
      if (!handle) {
        return;
      }
      await play(handle, `dev-${Date.now()}`, 0);
      slog(`seam-attach sent handle=${handle} t=${Date.now()}`);
    } else {
      if (!lastHandle) {
        return;
      }
      const marks = await phaseMarks(lastHandle);
      slog(`marks ${lastHandle} ${JSON.stringify(marks)}`);
    }
  } catch (error) {
    slog(`seam ${match[1]} failed: ${describe(error)}`);
  }
}
