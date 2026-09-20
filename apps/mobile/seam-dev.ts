// ── Slice 1.5 seam dev instrumentation ─────────────────────────────
// Driven ONLY by the auqw://seam-* deep links dispatched from App.tsx:
//   auqw://seam-file?path=…        gate-0 file leg (same warm player)
//   auqw://seam-prepare?provider=…&ref=…   stream prepare
//   auqw://seam-attach?handle=…    attach last/provided prepared handle
//   auqw://seam-metrics            dump Rust-side phase marks
// Self-contained (own logger + listeners) so App.tsx stays a one-block
// diff for the s1 merge. Dev-gate only — no shipped semantics.
import { Asset } from 'expo-asset';
import { File, FileMode, Paths } from 'expo-file-system';
import {
  addPhaseMarkListener,
  addPlaybackStatusListener,
  addPrepareOutcomeListener,
  createHost,
  devAttachFile,
  loadPlugin,
  phaseMarks,
  play,
  prepare,
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
  });
  addPlaybackStatusListener((e) => {
    slog(`status ${e.handle} ${e.state} pos=${e.positionMs}ms t=${Date.now()}`);
  });
  addPhaseMarkListener((e) => {
    slog(`mark ${e.handle} ${e.name} +${e.sinceStartMs}ms t=${e.atMs}`);
  });
}

async function ensureSeam(): Promise<string> {
  if (!hostReady) {
    // Same fuel config as App.tsx's ensureHost.
    await createHost({
      fuelPerEntry: 200_000_000,
      fuelTotal: 2_000_000_000,
      potProviderUrl: POT_PROVIDER_URL,
    });
    hostReady = true;
  }
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
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === key) {
      return decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSeamLink(url: string): Promise<void> {
  const match = url.match(/^auqw:\/\/(seam-file|seam-prepare|seam-attach|seam-metrics)(?:\?([^\s]*))?$/);
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
    } else if (match[1] === 'seam-prepare') {
      const ref = param(query, 'ref');
      if (!ref) {
        return;
      }
      const id = await ensureSeam();
      const provider = param(query, 'provider') ?? id;
      lastRequestId = await prepare(provider, ref, `dev-${Date.now()}`, 0);
      slog(`seam-prepare sent req=${lastRequestId} t=${Date.now()}`);
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
