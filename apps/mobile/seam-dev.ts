// ── Slice 1.5 seam dev instrumentation ─────────────────────────────
// Driven ONLY by the auqw://seam* deep links dispatched from App.tsx:
//   auqw://seam-file?path=…        gate-0 file leg (same warm player)
//   auqw://seam-audio?path=…       gate-0 expo-audio file:// leg
//   auqw://seam?provider=…&ref=…   prepared path — prepare + attach
//   auqw://seam-prepare?provider=…&ref=…   stream prepare (staged leg)
//   auqw://seam-attach?handle=…    attach last/provided prepared handle
//   auqw://seam-metrics            dump Rust-side phase marks
//   auqw://seam-url?url=…&mime=…   dev seam leg — real prepared session
//                                  for a bare URL (no guest resolve);
//                                  &remint=1 makes the session's re-mint
//                                  re-issue the same URL (cap-invisibility
//                                  gate); &wait=head holds attach until
//                                  headReadyMs (prepared-path gate);
//                                  &pos=… attaches at an offset (seek gate)
//   auqw://seam-release?handle=…   releaseStream on a handle (teardown gate)
//   auqw://seam-stop             player stop (teardown gate)
//   auqw://seam-auth?token=…       session-trust leg — set the OAuth
//                                  access token merged into resolves
//   auqw://seam-auth-start?client_id=…;client_secret=…
//                                  OAuth device flow: prints user_code +
//                                  verification_url for the user to approve
//   auqw://seam-auth-poll          completes the flow → setAuthToken
//   auqw://seam-auth-refresh       refresh-grant → setAuthToken
//   auqw://seam-auth-clear         drop token + stored device state
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
  releaseStream,
  setAuthToken,
  stop,
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

// ── Session-trust (OAuth device flow) ───────────────────────────────
// The app side owns credentials + refresh — the guest only ever sees
// the short-lived access token. Device codes and refresh tokens are
// credentials: kept in module state, never logged.
const OAUTH_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube';
const OAUTH_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

let oauthClient: { id: string; secret: string | null } | null = null;
let deviceFlow: { deviceCode: string; expiresAtMs: number } | null = null;
let oauthRefresh: string | null = null;

async function oauthPost(url: string, pairs: Record<string, string>): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: Object.entries(pairs)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&'),
  });
  // Device-flow errors answer HTTP 400 with a JSON `error` body —
  // parse before judging so pending/denied/expired surface distinctly
  // instead of collapsing into a bare status. Only an unparseable body
  // falls back to the raw status.
  const body = (await resp.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (body === null) {
    throw new Error(`oauth http ${resp.status}`);
  }
  return body;
}

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
    // Same fuel config as App.tsx's ensureHost; Android runs the
    // decided webm-first prefer hint.
    await createHost({
      fuelPerEntry: 200_000_000,
      fuelTotal: 2_000_000_000,
      potProviderUrl: POT_PROVIDER_URL,
      prefer: ['audio/webm', 'audio/mp4'],
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
  const match = url.match(/^auqw:\/\/(seam-file|seam-audio|seam-prepare|seam-attach|seam-metrics|seam-url|seam-queue|seam-release|seam-stop|seam-auth-start|seam-auth-poll|seam-auth-refresh|seam-auth-clear|seam-auth|seam)(?:\?([^\s]*))?$/);
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
      const remint = param(query, 'remint') === '1';
      const waitHead = param(query, 'wait') === 'head';
      await ensureHost();
      const t0 = Date.now();
      lastHandle = await devPrepareUrl(
        streamUrl,
        mime,
        bytes ? Number(bytes) : undefined,
        remint,
      );
      slog(`seam-url prepared handle=${lastHandle} +${Date.now() - t0}ms remint=${remint}`);
      if (waitHead) {
        // The gate's "prepared" is head-fill complete at attach — wait
        // for the Rust-side headReadyMs mark before playing.
        const deadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < deadline) {
          const marks = await phaseMarks(lastHandle);
          if (marks.headReadyMs) {
            ready = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        slog(`seam-url head-ready=${ready} +${Date.now() - t0}ms`);
      }
      const ta = Date.now();
      await play(lastHandle, `dev-${Date.now()}`, 0, pos ? Number(pos) : undefined);
      slog(`seam-url attach-sent handle=${lastHandle} pos=${pos ?? 0} +${Date.now() - ta}ms total+${Date.now() - t0}ms`);
    } else if (match[1] === 'seam-release') {
      const handle = param(query, 'handle') ?? lastHandle;
      if (!handle) {
        return;
      }
      await releaseStream(handle);
      slog(`seam-release done handle=${handle} t=${Date.now()}`);
    } else if (match[1] === 'seam-stop') {
      await stop();
      slog(`seam-stop done t=${Date.now()}`);
    } else if (match[1] === 'seam-auth') {
      const token = param(query, 'token');
      if (!token) {
        return;
      }
      await ensureHost();
      setAuthToken(token);
      slog(`seam-auth token set t=${Date.now()}`);
    } else if (match[1] === 'seam-auth-start') {
      const id = param(query, 'client_id');
      if (!id) {
        return;
      }
      const body = await oauthPost(OAUTH_DEVICE_CODE_URL, {
        client_id: id,
        scope: OAUTH_SCOPE,
      });
      if (typeof body.error === 'string') {
        slog(`seam-auth-start ${body.error}`);
        return;
      }
      const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 1800;
      // Only commit state on a live flow — a failed start must not
      // orphan a prior session's client/refresh pairing.
      oauthClient = { id, secret: param(query, 'client_secret') };
      deviceFlow = deviceCode
        ? { deviceCode, expiresAtMs: Date.now() + expiresIn * 1000 }
        : null;
      // user_code + verification_url are the user-facing pair — safe to
      // print; device_code itself is a credential and stays unlogged.
      slog(
        `seam-auth-start user_code=${String(body.user_code ?? '?')} url=${String(
          body.verification_url ?? 'https://www.google.com/device',
        )} interval=${String(body.interval ?? 5)}s expires_in=${expiresIn}s`,
      );
    } else if (match[1] === 'seam-auth-poll') {
      if (!oauthClient || !deviceFlow) {
        slog('seam-auth-poll no in-flight flow');
        return;
      }
      if (Date.now() > deviceFlow.expiresAtMs) {
        deviceFlow = null;
        slog('seam-auth-poll device code expired — restart');
        return;
      }
      const pairs: Record<string, string> = {
        client_id: oauthClient.id,
        device_code: deviceFlow.deviceCode,
        grant_type: OAUTH_DEVICE_GRANT,
      };
      if (oauthClient.secret) {
        pairs.client_secret = oauthClient.secret;
      }
      const body = await oauthPost(OAUTH_TOKEN_URL, pairs);
      if (typeof body.error === 'string') {
        // authorization_pending / slow_down leave the flow alive for
        // the next poll; terminal answers (access_denied,
        // expired_token, invalid_grant) retire it.
        if (body.error !== 'authorization_pending' && body.error !== 'slow_down') {
          deviceFlow = null;
        }
        slog(`seam-auth-poll ${body.error}`);
        return;
      }
      const access = typeof body.access_token === 'string' ? body.access_token : '';
      if (!access) {
        slog('seam-auth-poll no access_token in response');
        return;
      }
      await ensureHost();
      setAuthToken(access);
      oauthRefresh = typeof body.refresh_token === 'string' ? body.refresh_token : null;
      deviceFlow = null;
      slog(`seam-auth-poll logged_in refresh=${oauthRefresh != null} t=${Date.now()}`);
    } else if (match[1] === 'seam-auth-refresh') {
      if (!oauthClient || !oauthRefresh) {
        slog('seam-auth-refresh no stored grant');
        return;
      }
      const pairs: Record<string, string> = {
        client_id: oauthClient.id,
        refresh_token: oauthRefresh,
        grant_type: 'refresh_token',
      };
      if (oauthClient.secret) {
        pairs.client_secret = oauthClient.secret;
      }
      const body = await oauthPost(OAUTH_TOKEN_URL, pairs);
      const access = typeof body.access_token === 'string' ? body.access_token : '';
      if (!access) {
        // A dead grant (invalid_grant — revoked or expired) must not
        // be retried forever; drop it so the next poll reports the
        // honest "no stored grant".
        if (body.error === 'invalid_grant') {
          oauthRefresh = null;
        }
        slog(`seam-auth-refresh failed ${String(body.error ?? 'no access_token')}`);
        return;
      }
      await ensureHost();
      setAuthToken(access);
      slog(`seam-auth-refresh renewed t=${Date.now()}`);
    } else if (match[1] === 'seam-auth-clear') {
      if (hostReady) {
        setAuthToken(null);
      }
      oauthClient = null;
      deviceFlow = null;
      oauthRefresh = null;
      slog(`seam-auth-clear done t=${Date.now()}`);
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
