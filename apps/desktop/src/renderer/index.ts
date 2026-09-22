import type { PlaybackIdentity, PlayerEvent } from '@auqw/application';
import { createWebPlayerPort } from './web-player.ts';

function field(term: string, value: string): void {
  const list = document.getElementById('status');
  if (list === null) {
    return;
  }
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.append(dt, dd);
}

function logEvent(text: string): void {
  const list = document.getElementById('events');
  if (list === null) {
    return;
  }
  const li = document.createElement('li');
  li.textContent = `${new Date().toISOString().slice(11, 19)} ${text}`;
  list.prepend(li);
}

function describe(thrown: unknown): string {
  if (
    typeof thrown === 'object' &&
    thrown !== null &&
    'kind' in thrown &&
    'message' in thrown &&
    typeof (thrown as { message: unknown }).message === 'string'
  ) {
    const err = thrown as { kind: unknown; message: string };
    return `${String(err.kind)} — ${err.message}`;
  }
  return 'unknown error';
}

function mimeFor(url: string): string {
  const lower = url.split('?')[0]?.toLowerCase() ?? '';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.opus')) return 'audio/ogg; codecs=opus';
  if (lower.endsWith('.webm')) return 'audio/webm';
  return 'audio/mp4';
}

const identity: PlaybackIdentity = {
  attemptId: `boot-${Math.floor(Math.random() * 1e9)}`,
  queueRev: 0,
};

async function boot(): Promise<void> {
  const list = document.getElementById('status');
  if (list !== null) {
    list.replaceChildren();
  }
  try {
    const meta = await window.auqw.app.meta();
    field('version', meta.version);
    field('platform', meta.platform);
    field('userData', meta.userDataPath);
  } catch (thrown) {
    field('app:meta', describe(thrown));
  }
  try {
    const pong = await window.auqw.utility.ping('hello from renderer');
    field('utility:ping', `${pong.reply} (${pong.echo})`);
  } catch (thrown) {
    field('utility:ping', describe(thrown));
  }
  try {
    const snapshot = await window.auqw.net.snapshot();
    field('net', snapshot.online ? 'online' : 'offline');
  } catch (thrown) {
    field('net:snapshot', describe(thrown));
  }
  window.auqw.net.subscribe((event) => {
    field('net transition', event.online ? 'online' : 'offline');
  });

  const audio = new Audio();
  const player = createWebPlayerPort({
    stream: window.auqw.stream,
    audio,
    mediaSession:
      'mediaSession' in navigator
        ? (navigator.mediaSession as {
            playbackState: string;
            setActionHandler(
              action: 'play' | 'pause' | 'nexttrack' | 'previoustrack',
              handler: (() => void) | null,
            ): void;
          })
        : null,
  });

  let preparedHandle: string | null = null;
  let state: string = 'idle';
  /** Page-level attempt ownership: a click sequence mints a fresh
   * attemptId + request/generation id; only the live one's outcome may
   * write `preparedHandle`, and stale handles get released. */
  let liveIdentity: PlaybackIdentity = identity;
  let livePrepareId: string | null = null;
  let prepSeq = 0;
  /** Prepared outcomes arriving before their requestId registers (an
   * adapter may emit synchronously) — replayed on registration, or
   * released when the owning generation ends. */
  const earlyPrepares = new Map<string, PlayerEvent>();

  function applyPrepareOutcome(event: PlayerEvent): void {
    if (event.type !== 'prepare') {
      return;
    }
    if (event.outcome.type === 'prepared' && event.outcome.stream !== undefined) {
      preparedHandle = event.outcome.stream.handle;
      state = 'prepared';
      logEvent(`prepared ${event.outcome.stream.handle} (${event.outcome.stream.mime})`);
    } else if (event.outcome.type !== 'prepared') {
      state = 'failed';
      logEvent(`prepare failed — ${event.outcome.error.kind}: ${event.outcome.error.message}`);
    }
  }

  /** Superseded/orphaned buffered outcomes — release their handles. */
  function drainEarlyPrepares(): void {
    for (const event of earlyPrepares.values()) {
      if (event.type === 'prepare' && event.outcome.type === 'prepared') {
        void player.release({
          handle: event.outcome.stream.handle,
          identity: liveIdentity,
        });
      }
    }
    earlyPrepares.clear();
  }

  function renderState(): void {
    const el = document.getElementById('player-state');
    if (el !== null) {
      el.textContent = `${state} · ${Math.round(audio.currentTime * 1000)}ms${
        Number.isFinite(audio.duration)
          ? ` / ${Math.round(audio.duration * 1000)}ms`
          : ''
      }`;
    }
  }

  player.subscribe((event: PlayerEvent) => {
    if (event.type === 'prepare') {
      // A superseded request's outcome is ignored — its handle would
      // otherwise clobber the newer selection.
      if (event.requestId !== livePrepareId) {
        // Early (id not yet registered) or superseded — buffer prepared
        // outcomes for replay on registration; drainEarlyPrepares
        // releases whatever stays unmatched.
        if (event.outcome.type === 'prepared') {
          earlyPrepares.set(event.requestId, event);
        }
        return;
      }
      applyPrepareOutcome(event);
    } else if (event.type === 'status') {
      state = event.state;
      if (event.state === 'failed') {
        logEvent(
          `status failed — ${event.error?.kind ?? '?'}: ${event.error?.message ?? '?'}`,
        );
      }
    } else if (event.type === 'queue-transition') {
      logEvent(`queue ${event.reason}: ${event.fromOccurrenceId} → ${event.toOccurrenceId}`);
    } else if (event.type === 'phase') {
      logEvent(`phase ${event.name} +${event.sinceStartMs}ms`);
    }
    renderState();
  });

  try {
    const host = await window.auqw.host.plugins();
    field(
      'host:plugins',
      `${host.bindings}${host.plugins.length > 0 ? ` — ${host.plugins.join(', ')}` : ''}${host.bindingsError !== undefined ? ` — ${host.bindingsError}` : ''}`,
    );
    const select = document.getElementById('provider');
    if (select instanceof HTMLSelectElement) {
      select.replaceChildren();
      for (const id of host.plugins) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        select.append(option);
      }
    }
  } catch (thrown) {
    field('host:plugins', describe(thrown));
  }

  const prepareButton = document.getElementById('prepare');
  const playButton = document.getElementById('play');
  const pauseButton = document.getElementById('pause');
  const stopButton = document.getElementById('stop');
  const sourceInput = document.getElementById('source');
  const providerSelect = document.getElementById('provider');
  const devGate = document.getElementById('dev-gate');

  prepareButton?.addEventListener('click', () => {
    const ref =
      sourceInput instanceof HTMLInputElement ? sourceInput.value.trim() : '';
    if (ref === '') {
      return;
    }
    void (async () => {
      state = 'preparing';
      renderState();
      const gen = ++prepSeq;
      livePrepareId = null;
      // A re-prepare must release the stream it replaces — otherwise
      // its pump stays owned and playing audio keeps running.
      const replacedHandle = preparedHandle;
      preparedHandle = null;
      if (replacedHandle !== null) {
        void player.release({ handle: replacedHandle, identity: liveIdentity });
      }
      drainEarlyPrepares();
      if (devGate instanceof HTMLInputElement && devGate.checked) {
        try {
          const stream = await window.auqw.stream.devPrepare({
            url: ref,
            mime: mimeFor(ref),
          });
          if (gen !== prepSeq) {
            void player.release({
              handle: stream.handle,
              identity: liveIdentity,
            });
            return;
          }
          liveIdentity = { ...liveIdentity, attemptId: `boot-${gen}` };
          livePrepareId = `dev-${gen}`;
          preparedHandle = stream.handle;
          state = 'prepared';
          logEvent(`dev-prepared ${stream.handle} (${stream.mime})`);
        } catch (thrown) {
          if (gen === prepSeq) {
            state = 'failed';
            logEvent(`dev-prepare failed — ${describe(thrown)}`);
          }
        }
        renderState();
        return;
      }
      const provider =
        providerSelect instanceof HTMLSelectElement
          ? providerSelect.value
          : '';
      if (provider === '') {
        state = 'failed';
        logEvent('prepare failed — no plugins loaded');
        renderState();
        return;
      }
      const attemptIdentity: PlaybackIdentity = {
        ...identity,
        attemptId: `boot-${gen}`,
      };
      const res = await player.prepare({
        provider,
        sourceRef: ref,
        identity: attemptIdentity,
      });
      if (gen !== prepSeq) {
        return;
      }
      if (res.ok) {
        livePrepareId = res.value;
        liveIdentity = attemptIdentity;
        // An already-emitted outcome for this request was buffered —
        // replay it now that the id is registered.
        const early = earlyPrepares.get(res.value);
        if (early !== undefined) {
          earlyPrepares.delete(res.value);
          applyPrepareOutcome(early);
          renderState();
        }
      } else {
        state = 'failed';
        logEvent(`prepare failed — ${res.error.kind}: ${res.error.message}`);
        renderState();
      }
    })();
  });

  playButton?.addEventListener('click', () => {
    if (preparedHandle === null) {
      return;
    }
    void player
      .play({ handle: preparedHandle, identity: liveIdentity })
      .then((res) => {
        if (!res.ok) {
          state = 'failed';
          logEvent(`play failed — ${res.error.kind}: ${res.error.message}`);
          renderState();
        }
      });
  });
  pauseButton?.addEventListener('click', () => {
    void player.pause(liveIdentity);
  });
  stopButton?.addEventListener('click', () => {
    // Bumping the generation invalidates any in-flight prepare — a
    // late outcome can't restore a handle after Stop ran.
    const gen = ++prepSeq;
    livePrepareId = null;
    const handle = preparedHandle;
    preparedHandle = null;
    drainEarlyPrepares();
    void (async () => {
      await player.stop(liveIdentity);
      // Stop only detaches the element — the stream session still owns
      // the handle; release it so the pump + partial cache are reaped.
      if (handle !== null) {
        await player.release({ handle, identity: liveIdentity });
      }
      // A newer prepare may have landed while we awaited — its state
      // belongs to the new generation, not to this stop.
      if (gen !== prepSeq) {
        return;
      }
      state = 'idle';
      renderState();
    })();
  });
  setInterval(renderState, 500);
}

void boot();
