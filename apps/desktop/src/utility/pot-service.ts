import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { getGlobalDispatcher, Dispatcher } from 'undici';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders, parseLooseJSON } from 'bgutils-js/utils';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { isBoundedString, isRecord } from '../shared/check.ts';
import {
  createProcessMinter,
  HttpError,
  type MinterEngine,
} from './pot-minter-engine.ts';

/**
 * Bundled proof-of-origin-token provider (bgutil `/get_pot`
 * contract). A lazily-bound `node:http` listener on
 * `0.0.0.0:<ephemeral>` answers `POST /get_pot {content_binding}`
 * with `{poToken, contentBinding, expiresAt}` — the exact shape the
 * plugin-host's `pot_token` capability relays to guests verbatim.
 *
 * Minting mirrors bgutil-ytdlp-pot-provider: fetch the YouTube
 * homepage for a self-consistent (ytcfg, ytAtN bgChallenge) pair,
 * evaluate the BotGuard interpreter inside a `node:vm` context in a
 * dedicated minter child process (`pot-minter-engine.ts` — a vm is
 * isolation, not a security boundary, so remote JS never shares the
 * utility's address space), snapshot it, trade the snapshot for an
 * integrity token at GenerateIT, then mint per-binding tokens
 * through WebPoMinter. When GenerateIT declines a token, the
 * websafe fallback token is session-bound and served as-is
 * (verified: one token resolved two different video ids,
 * ttl ~43200s).
 *
 * The bind is intentionally on the wildcard address: a phone that
 * paired over LAN shares this host's public IP, so desktop-minted
 * tokens attest for it too (docs/decisions.md — unauthenticated
 * LAN endpoint tradeoff). Sessions are IP-bound and shared: one
 * integrity session mints every content binding until
 * `estimatedTtlSecs` minus a margin, and a single in-flight
 * promise dedupes concurrent cold starts.
 */

/* ------------------------- request surface ------------------------- */

const MAX_BODY_BYTES = 8 * 1_024;
const MAX_BINDING_CHARS = 512;
/** Token bucket: mints are per-resolve, never hot-path. */
const RATE_LIMIT_PER_SEC = 4;
const RATE_LIMIT_BURST = 8;
/** Bound on distinct rate-limit clients — the aggregate ceiling. */
const MAX_RATE_CLIENTS = 256;
/** Idle client buckets are reclaimed past this age. */
const CLIENT_BUCKET_IDLE_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const VM_RUN_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;
/** Homepage + interpreter responses are ~1-3 MB; cap at 8. */
const MAX_UPSTREAM_CHARS = 8 * 1_024 * 1_024;
/** Re-attempt spacing after a failed session build. */
const FAILURE_COOLDOWN_MS = 15_000;
/** Per-session bound on interpreter-driven fetches + per-response size —
 * remote code gets a budget, not the host's whole network. */
const SANDBOX_FETCH_MAX_CALLS = 32;
const SANDBOX_FETCH_MAX_CHARS = 1_024 * 1_024;
/** Attestation bodies are small; a request past this stops being one. */
const SANDBOX_REQ_MAX_CHARS = 256 * 1_024;
/** Header fields the interpreter may legitimately set on a probe —
 * everything else (auth-ish or tracking headers) is dropped. The CORS
 * machinery fields stay because a cross-origin attestation POST
 * preflights them and google denies the POST without them. Hop-by-hop
 * and framing fields (host, content-length, transfer-encoding,
 * connection) are absent on purpose: undici derives those itself. */
const SANDBOX_HEADER_ALLOW = new Set([
  'accept',
  'accept-language',
  'access-control-request-headers',
  'access-control-request-method',
  'content-type',
  'origin',
  'referer',
  'user-agent',
]);
/** Refresh before GenerateIT's `estimatedTtlSecs` actually ends. */
const SESSION_MARGIN_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 21_600 * 1_000;
const MAX_SESSION_TTL_MS = 86_400 * 1_000;

/** Homepage-fetch UA — pinned Safari, the proven attested shape. */
const HOMEPAGE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 ' +
  'Safari/605.1.15';
const HOMEPAGE = 'https://www.youtube.com';
/** Long-lived public Innertube request key — shared with bgutil. */
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
/**
 * The BotGuard interpreter is remote code evaluated inside the vm
 * context — a poisoned homepage could redirect it to an attacker
 * script. It is only ever declared on Google's own BotGuard origin
 * (www.google.com/js/th/… on the live page); exact hosts only — a
 * broad suffix family would let a subdomain surface executable code
 * the page never vouched for.
 */
const INTERPRETER_HOSTS = ['www.google.com', 'www.youtube.com'];

function isAllowedInterpreterHost(hostname: string): boolean {
  return INTERPRETER_HOSTS.includes(hostname.toLowerCase());
}

export type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
};

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<FetchResponse>;

/** One integrity session: mints per-binding until its TTL horizon. */
export type PotSession = {
  mint(contentBinding: string): Promise<string>;
  readonly expiresAtMs: number;
  /**
   * Reuse horizon — a fresh session serves until this timestamp,
   * then a new build replaces it. Short-lived sessions shrink the
   * refresh margin rather than leaving no cacheable window.
   */
  readonly freshUntilMs?: number;
  /** Releases resources held by the session (in-VM timers). */
  readonly dispose?: () => void;
};

export type PotServiceDeps = {
  readonly fetchImpl?: FetchLike;
  readonly nowMs?: () => number;
  /**
   * Session-builder seam — production runs the BotGuard flow;
   * tests inject a fake. The promise is memoized until the
   * returned session's expiry margin.
   */
  readonly session?: () => Promise<PotSession>;
  /** Warn-level lifecycle lines only — tokens never cross it. */
  readonly log?: (line: string) => void;
  readonly rateLimitPerSec?: number;
  readonly rateLimitBurst?: number;
  /**
   * Rate-limit client identity — defaults to the socket peer
   * address so one LAN abuser starves only itself; tests inject
   * a deterministic key.
   */
  readonly clientKey?: (req: IncomingMessage) => string;
};

export type PotService = {
  /**
   * Binds the listener once (0.0.0.0:ephemeral) and resolves the
   * bound port, or null when the bind failed — callers degrade to
   * "no provider" instead of throwing. A failed bind stays
   * retryable on the next call.
   */
  bind(): Promise<number | null>;
  /** Bound port once bind() has resolved, else null. */
  port(): number | null;
  /** `http://127.0.0.1:<port>` once bound, else null. */
  loopbackUrl(): string | null;
  close(): Promise<void>;
};

type ChallengeData = {
  program: string;
  globalName: string;
  interpreterUrl: string;
};

type MintResult = {
  poToken: string;
  expiresAtMs: number;
};


/* -------------------------- BotGuard flow -------------------------- */

/**
 * Gates jsdom-originated traffic onto the exact-host allowlist —
 * jsdom routes every network path (subresources, XHR, WebSocket
 * upgrades) through this dispatcher, so the same allowlist that
 * narrows `window.fetch` covers them identically. Lifecycle calls
 * never reach the base dispatcher: it is the shared global and
 * closing it would sever every later host fetch.
 */
class AllowlistDispatcher extends Dispatcher {
  readonly #upstream: Dispatcher;
  readonly #hosts: ReadonlySet<string>;
  #calls = 0;

  constructor(upstream: Dispatcher, hosts: ReadonlySet<string>) {
    super();
    this.#upstream = upstream;
    this.#hosts = hosts;
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const reject = (reason: string): boolean => {
      const error = new TypeError(`pot: sandboxed request ${reason}`);
      // jsdom's own blocked-URL path signals `onResponseError` the
      // same way — a dead request is its one failure shape.
      handler.onResponseError?.(
        null as unknown as Parameters<
          NonNullable<typeof handler.onResponseError>
        >[0],
        error,
      );
      return true;
    };
    const opaque = (options as { opaque?: { url?: string } }).opaque;
    let parsed: URL | null = null;
    try {
      parsed = new URL(
        opaque?.url ?? `${options.origin ?? ''}${options.path}`,
      );
    } catch {
      parsed = null;
    }
    const method = String(options.method ?? 'GET').toUpperCase();
    // Same grant window.fetch gets: https only, exact host, read-mostly
    // verbs — POST stays because the interpreter legitimately ships
    // attestation bodies to google hosts, and OPTIONS because a
    // cross-origin XHR POST preflights before it sends. Everything is
    // bounded by the same per-sandbox call budget.
    if (
      parsed === null ||
      parsed.protocol !== 'https:' ||
      !this.#hosts.has(parsed.hostname.toLowerCase())
    ) {
      return reject('host not allowed');
    }
    if (
      method !== 'GET' &&
      method !== 'HEAD' &&
      method !== 'POST' &&
      method !== 'OPTIONS'
    ) {
      return reject('method not allowed');
    }
    if (this.#calls >= SANDBOX_FETCH_MAX_CALLS) {
      return reject('budget exhausted');
    }
    this.#calls += 1;
    // Request headers carry the same allowlist window.fetch enforces;
    // undici accepts several header shapes, normalize them all.
    const filtered: Record<string, string | string[]> = {};
    const addHeader = (name: string, value: unknown): void => {
      const key = name.toLowerCase();
      const vals = Array.isArray(value) ? value : [value];
      const clean = vals.filter(
        (v): v is string => typeof v === 'string' && v.length <= 512,
      );
      if (SANDBOX_HEADER_ALLOW.has(key) && clean.length > 0) {
        filtered[key] = Array.isArray(value) ? clean : (clean[0] ?? '');
      }
    };
    const raw = options.headers;
    if (Array.isArray(raw)) {
      // undici's array form is flat name/value pairs, not "name: value"
      // lines — walk it two at a time.
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i];
        if (typeof name === 'string') {
          addHeader(name, raw[i + 1]);
        }
      }
    } else if (raw !== null && raw !== undefined) {
      for (const [name, value] of Object.entries(raw)) {
        addHeader(name, value);
      }
    }
    // Both bodies bound mid-transfer: an oversized upload stops being
    // an attestation payload, an oversized download stops being a page.
    let ctl: Dispatcher.DispatchController | null = null;
    let dead = false;
    const oversize = (what: string): void => {
      if (dead) return;
      dead = true;
      ctl?.abort(new TypeError(`pot: sandboxed ${what} oversized`));
    };
    let sent = 0;
    let seen = 0;
    const bounded: Dispatcher.DispatchHandler = {
      onRequestStart: (c, ctx) => {
        ctl = c;
        handler.onRequestStart?.(c, ctx);
      },
      onRequestUpgrade: (c, s, h, sk) =>
        handler.onRequestUpgrade?.(c, s, h, sk),
      onResponseStart: (c, s, h, m) =>
        handler.onResponseStart?.(c, s, h, m),
      onResponseData: (c, chunk) => {
        seen += chunk.byteLength;
        if (seen > SANDBOX_FETCH_MAX_CHARS) {
          oversize('response');
          return;
        }
        handler.onResponseData?.(c, chunk);
      },
      onResponseEnd: (c, t) => {
        if (!dead) handler.onResponseEnd?.(c, t);
      },
      onResponseError: (c, e) => handler.onResponseError?.(c, e),
      onResponseStarted: () => handler.onResponseStarted?.(),
      onBodySent: (chunk) => {
        sent += chunk.byteLength;
        if (sent > SANDBOX_REQ_MAX_CHARS) {
          oversize('request');
          return;
        }
        handler.onBodySent?.(chunk);
      },
      onRequestSent: () => {
        if (!dead) handler.onRequestSent?.();
      },
    };
    return this.#upstream.dispatch({ ...options, headers: filtered }, bounded);
  }

  close(callback?: () => void): Promise<void> {
    callback?.();
    return Promise.resolve();
  }

  destroy(
    err?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> {
    (typeof err === 'function' ? err : callback)?.();
    return Promise.resolve();
  }
}

/**
 * A real DOM for the BotGuard VM — the interpreter walks document,
 * navigator and window APIs that stubs cannot satisfy, and a fake
 * environment never earns an integrity token from GenerateIT, so the
 * sandbox is a jsdom page (the same posture upstream bgutil takes).
 * `getInternalVMContext()` hands back the page's own global object:
 * the interpreter sees a browser realm — and only a browser realm —
 * while the page lives inside the dedicated minter child, so remote
 * code still runs nowhere near the utility's address space.
 */
function botGuardSandbox(
  ytcfg: unknown,
  fetchImpl: FetchLike,
  allowedFetchHost: string,
): { ctx: vm.Context; dispose(): void } {
  // The remote code's whole network surface is the two origins this
  // flow already provably uses — the interpreter's own host and the
  // homepage it rode in on — exact hosts, nothing wider.
  const sandboxFetchHosts = new Set([
    allowedFetchHost.toLowerCase(),
    new URL(HOMEPAGE).hostname,
  ]);
  const dom = new JSDOM('', {
    url: HOMEPAGE,
    referrer: HOMEPAGE,
    runScripts: 'outside-only',
    resources: {
      userAgent: HOMEPAGE_UA,
      dispatcher: new AllowlistDispatcher(
        getGlobalDispatcher(),
        sandboxFetchHosts,
      ),
    },
  });
  const win = dom.window;
  // The interpreter's network surface is capped to exact hosts (its
  // own origin + the homepage), read-only methods, no caller body,
  // allowlisted headers only, https only, no redirect following (a
  // 30x could still escape the list), and bounded per session in
  // both call count and response size.
  // The response handed to the interpreter is a FACADE — the upstream
  // Response is never mutated (its .body is a getter-only slot on a
  // real Response, so assigning it would throw; pipeThrough on the
  // original would lock the stream the bound readers need). Every
  // body read — text/json/arrayBuffer/blob and a direct .body stream
  // — counts bytes through the one shared reader and budget.
  type FullResponse = FetchResponse & {
    text: () => Promise<string>;
    json?: () => Promise<unknown>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    blob?: () => Promise<Blob>;
    clone?: () => FetchResponse;
    headers?: { get(name: string): string | null };
    body?: ReadableStream | null;
  };
  const boundedResponse = (resp: FetchResponse): FetchResponse => {
    const full = resp as FullResponse;
    const oversized = (): TypeError =>
      new TypeError('pot: sandboxed fetch response oversized');
    let seen = 0;
    let reader: ReadableStreamDefaultReader<unknown> | null = null;
    const takeReader = (): ReadableStreamDefaultReader<unknown> | null => {
      const src = full.body;
      if (reader === null && src !== null && src !== undefined) {
        reader = src.getReader();
      }
      return reader;
    };
    const readBounded = async (): Promise<Uint8Array> => {
      const r = takeReader();
      if (r === null) {
        // Bodyless or literal response — bound the string it gives.
        const text = await resp.text();
        if (text.length > SANDBOX_FETCH_MAX_CHARS) {
          throw oversized();
        }
        return new TextEncoder().encode(text);
      }
      const parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await r.read();
        if (done) {
          break;
        }
        const bytes =
          value instanceof Uint8Array
            ? value
            : new Uint8Array(value as ArrayBuffer);
        seen += bytes.byteLength;
        if (seen > SANDBOX_FETCH_MAX_CHARS) {
          void r.cancel();
          throw oversized();
        }
        parts.push(bytes);
      }
      const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    };
    const textBounded = async (): Promise<string> =>
      new TextDecoder().decode(await readBounded());
    const mime =
      typeof full.headers?.get === 'function'
        ? (full.headers.get('content-type') ?? '')
        : '';
    // highWaterMark 0 — a default-depth stream would pull EAGERLY at
    // construction, locking the upstream reader and pre-reading a
    // chunk into its own queue before the interpreter reads anything.
    const bodyStream = new ReadableStream(
      {
        async pull(controller): Promise<void> {
          const r = takeReader();
          if (r === null) {
            controller.close();
            return;
          }
          const { done, value } = await r.read();
          if (done) {
            controller.close();
            return;
          }
          seen +=
            value instanceof Uint8Array || value instanceof ArrayBuffer
              ? value.byteLength
              : 0;
          if (seen > SANDBOX_FETCH_MAX_CHARS) {
            void r.cancel();
            controller.error(oversized());
            return;
          }
          controller.enqueue(value);
        },
        cancel(reason): Promise<void> {
          const r = takeReader();
          return r === null ? Promise.resolve() : r.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const facade = {
      ok: full.ok,
      status: full.status,
      text: textBounded,
      json: async (): Promise<unknown> => JSON.parse(await textBounded()),
      arrayBuffer: async (): Promise<ArrayBuffer> =>
        (await readBounded()).buffer as ArrayBuffer,
      blob: async (): Promise<Blob> =>
        new Blob([(await readBounded()).buffer as ArrayBuffer], {
          type: mime,
        }),
      get body() {
        return (full.body ?? null) === null ? null : bodyStream;
      },
    } as FetchResponse & Record<string, unknown>;
    // Everything else delegates — methods bind to the upstream
    // response so headers/url/type/bodyUsed behave normally.
    for (const prop of [
      'statusText',
      'headers',
      'url',
      'redirected',
      'type',
      'bodyUsed',
    ]) {
      Object.defineProperty(facade, prop, {
        enumerable: true,
        get: () => {
          const value: unknown = Reflect.get(full, prop);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(resp)
            : value;
        },
      });
    }
    if (typeof full.clone === 'function') {
      const cloneUpstream = full.clone.bind(resp);
      facade['clone'] = () => boundedResponse(cloneUpstream());
    }
    return facade;
  };
  let sandboxFetches = 0;
  const sandboxFetch = (
    input: unknown,
    init?: unknown,
  ): Promise<FetchResponse> => {
    let parsed: URL;
    try {
      parsed = new URL(String(input), HOMEPAGE);
    } catch {
      return Promise.reject(
        new TypeError('pot: sandboxed fetch url unparsable'),
      );
    }
    if (
      parsed.protocol !== 'https:' ||
      !sandboxFetchHosts.has(parsed.hostname.toLowerCase())
    ) {
      return Promise.reject(
        new TypeError('pot: sandboxed fetch host not allowed'),
      );
    }
    const initMethod = (init as RequestInit | undefined)?.method;
    const method =
      typeof initMethod === 'string' ? initMethod.toUpperCase() : 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      return Promise.reject(
        new TypeError('pot: sandboxed fetch method not allowed'),
      );
    }
    if (sandboxFetches >= SANDBOX_FETCH_MAX_CALLS) {
      return Promise.reject(
        new TypeError('pot: sandboxed fetch budget exhausted'),
      );
    }
    sandboxFetches += 1;
    // Caller-chosen method/body/headers are all dropped: read-only
    // fetches carrying no payload keep the grant as narrow as the
    // mechanism needs.
    const headers: Record<string, string> = {};
    const initHeaders = (init as RequestInit | undefined)?.headers;
    if (isRecord(initHeaders)) {
      for (const [name, value] of Object.entries(initHeaders)) {
        if (
          SANDBOX_HEADER_ALLOW.has(name.toLowerCase()) &&
          typeof value === 'string' &&
          value.length <= 512
        ) {
          headers[name.toLowerCase()] = value;
        }
      }
    }
    return fetchImpl(parsed.href, {
      method,
      headers,
      redirect: 'error',
      // Same deadline discipline as the host legs — an in-context
      // fetch must not outlive the mint it's serving.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).then(boundedResponse);
  };
  // `window.fetch` gets the narrowed grant, not the ambient one —
  // same read-only, exact-host, byte- and call-capped surface the
  // dispatcher enforces on jsdom's own traffic.
  win['fetch'] = sandboxFetch;
  // Gaps in jsdom's web surface the interpreter may legitimately
  // probe. The timing aliases land on the page's OWN timers so they
  // die with `window.close()`; `Worker` is an inert shell — remote
  // code sees the API, nothing ever runs.
  const winSetTimeout = win['setTimeout'] as (
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => number;
  const winClearTimeout = win['clearTimeout'] as (id: number) => void;
  win['structuredClone'] = globalThis.structuredClone;
  win['ReadableStream'] = ReadableStream;
  win['Request'] = Request;
  win['Response'] = Response;
  win['BroadcastChannel'] = BroadcastChannel;
  win['requestAnimationFrame'] = (cb: (now: number) => void) =>
    winSetTimeout(() => cb(Date.now()), 16);
  win['cancelAnimationFrame'] = (id: number) => winClearTimeout(id);
  win['setImmediate'] = (
    cb: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => winSetTimeout(cb, 0, ...args);
  win['clearImmediate'] = (id: number) => winClearTimeout(id);
  win['matchMedia'] = () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
  win['Worker'] = class {
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(): void {}
    terminate(): void {}
  };
  // The homepage's ytcfg — BotGuard reads yt.config_.EVENT_ID.
  win['yt'] = ytcfg ?? { config_: {} };
  return {
    ctx: dom.getInternalVMContext(),
    dispose(): void {
      (dom.window['close'] as () => void)();
    },
  };
}

/**
 * Bounded text fetch. `leg` names the failure without echoing the
 * URL — the interpreter is a trusted-resource URL (attestation
 * material) and stays out of logs.
 */
async function fetchTextCapped(
  fetchImpl: FetchLike,
  url: string,
  leg: string,
  init: RequestInit | undefined,
  maxChars: number,
): Promise<string> {
  const resp = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new HttpError(
      503,
      'unavailable',
      `pot: ${leg} answered ${resp.status}`,
    );
  }
  return boundedText(resp, maxChars, leg);
}

type StreamedResponse = FetchResponse & {
  body?: ReadableStream<Uint8Array> | null;
};

/**
 * Body read bounded WHILE it streams — `resp.text()` would buffer the
 * whole upstream body before the cap could reject it, and these
 * callers run inside the dedicated minter child where an oversized
 * homepage/interpreter response is the child's memory ceiling.
 * Injected test responses carry no `.body`; those bound the string
 * they hand back instead.
 */
async function boundedText(
  resp: FetchResponse,
  maxChars: number,
  leg: string,
): Promise<string> {
  const body = (resp as StreamedResponse).body;
  if (body === null || body === undefined) {
    const text = await resp.text();
    if (text.length > maxChars) {
      throw new HttpError(
        503,
        'unavailable',
        `pot: ${leg} response oversized`,
      );
    }
    return text;
  }
  const oversized = (): HttpError =>
    new HttpError(503, 'unavailable', `pot: ${leg} response oversized`);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      seen += value.byteLength;
      if (seen > maxChars) {
        void reader.cancel();
        throw oversized();
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/**
 * The (ytcfg, ytAtN) pair must come from the SAME homepage response —
 * a challenge detached from its page config mints rejected tokens.
 */
async function challengeFromHomepage(
  fetchImpl: FetchLike,
): Promise<{ challenge: ChallengeData; ytcfg: unknown }> {
  const html = await fetchTextCapped(
    fetchImpl,
    HOMEPAGE,
    'homepage',
    {
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.7',
        'user-agent': HOMEPAGE_UA,
      },
    },
    MAX_UPSTREAM_CHARS,
  );
  const cfgMatch = html.match(/ytcfg\.set\(({.+?})\);/s);
  let ytcfg: unknown;
  if (cfgMatch !== null && cfgMatch[1] !== undefined) {
    try {
      ytcfg = { config_: JSON.parse(cfgMatch[1]) };
    } catch {
      ytcfg = undefined;
    }
  }
  const attMatch = html.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (attMatch === null || attMatch[1] === undefined) {
    throw new HttpError(
      503,
      'unavailable',
      'pot: no ytAtN challenge on homepage',
    );
  }
  const attData: unknown = parseLooseJSON(attMatch[1]);
  const bg = isRecord(attData) ? attData['R'] : undefined;
  const challenge = isRecord(bg) ? bg['bgChallenge'] : undefined;
  if (!isRecord(challenge)) {
    throw new HttpError(
      503,
      'unavailable',
      'pot: ytAtN payload lacks bgChallenge',
    );
  }
  const interp = challenge['interpreterUrl'];
  const interpUrl = isRecord(interp)
    ? interp['privateDoNotAccessOrElseTrustedResourceUrlWrappedValue']
    : undefined;
  const program = challenge['program'];
  const globalName = challenge['globalName'];
  if (
    !isBoundedString(program, 1_048_576) ||
    !isBoundedString(globalName, 256) ||
    typeof interpUrl !== 'string' ||
    interpUrl.length === 0 ||
    interpUrl.length > 2_048
  ) {
    throw new HttpError(
      503,
      'unavailable',
      'pot: bgChallenge missing program/globalName/interpreter',
    );
  }
  // Protocol-relative `//host/path` on the live page — normalize to
  // https and fail closed on a non-Google destination before the
  // fetch ever fires.
  let interpreter: URL;
  try {
    interpreter = new URL(interpUrl, HOMEPAGE);
  } catch {
    throw new HttpError(
      503,
      'unavailable',
      'pot: bgChallenge interpreter URL unparsable',
    );
  }
  if (
    interpreter.protocol !== 'https:' ||
    !isAllowedInterpreterHost(interpreter.hostname)
  ) {
    throw new HttpError(
      503,
      'unavailable',
      'pot: bgChallenge interpreter host not allowed',
    );
  }
  return {
    challenge: {
      program,
      globalName,
      interpreterUrl: interpreter.href,
    },
    ytcfg,
  };
}

/**
 * BotGuard session build: homepage → interpreter → vm → GenerateIT.
 * Exported for the minter child entry (`pot-minter-child.ts`) — it
 * is the whole reason the child exists: this remote-JS flow runs in
 * a dedicated process, never in the utility's address space.
 */
export async function buildBotGuardSession(
  fetchImpl: FetchLike,
  nowMs: () => number,
): Promise<PotSession> {
  const { challenge, ytcfg } = await challengeFromHomepage(fetchImpl);
  const interpreterJs = await fetchTextCapped(
    fetchImpl,
    challenge.interpreterUrl,
    'interpreter',
    // Fail closed on redirects — the host allowlist covers the URL
    // the page declared, not wherever a 30x might land.
    { redirect: 'error' },
    MAX_UPSTREAM_CHARS,
  );
  const sandbox = botGuardSandbox(
    ytcfg,
    fetchImpl,
    new URL(challenge.interpreterUrl).hostname,
  );
  // `ctx` is the jsdom page's contextified global — ready to run in.
  try {
    return await mintSession(
      challenge,
      interpreterJs,
      sandbox,
      fetchImpl,
      nowMs,
    );
  } catch (thrown) {
    // A failed build would otherwise orphan the vm context's timers.
    sandbox.dispose();
    throw thrown;
  }
}

async function mintSession(
  challenge: ChallengeData,
  interpreterJs: string,
  sandbox: { ctx: vm.Context; dispose(): void },
  fetchImpl: FetchLike,
  nowMs: () => number,
): Promise<PotSession> {
  const ctx = sandbox.ctx;
  vm.runInContext(interpreterJs, ctx, { timeout: VM_RUN_TIMEOUT_MS });
  const client = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: ctx,
  });
  const webPoSignalOutput: WebPoSignalOutput = [];
  const snapshot = await client.snapshot(
    { webPoSignalOutput },
    SNAPSHOT_TIMEOUT_MS,
  );
  const itText = await fetchTextCapped(
    fetchImpl,
    buildURL('GenerateIT', true),
    'GenerateIT',
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, snapshot]),
      // Same rule: a redirect would re-post the snapshot to a
      // destination the challenge never vouched for.
      redirect: 'error',
    },
    65_536,
  );
  const itJson: unknown = JSON.parse(itText);
  if (!Array.isArray(itJson)) {
    throw new HttpError(
      503,
      'unavailable',
      'pot: GenerateIT returned a non-array',
    );
  }
  const [integrityToken, estimatedTtlSecs, , websafeFallbackToken] =
    itJson as [unknown, unknown, unknown, unknown];
  const ttlMs =
    typeof estimatedTtlSecs === 'number' &&
    Number.isFinite(estimatedTtlSecs) &&
    estimatedTtlSecs > 0
      ? Math.min(estimatedTtlSecs * 1_000, MAX_SESSION_TTL_MS)
      : DEFAULT_SESSION_TTL_MS;
  const expiresAtMs = nowMs() + ttlMs;
  // Margin is proportional to the TTL — a fixed 60s margin would
  // leave sessions of a minute or less with no cacheable window.
  const freshUntilMs = expiresAtMs - Math.min(SESSION_MARGIN_MS, ttlMs / 4);
  if (typeof integrityToken === 'string' && integrityToken.length > 0) {
    // The snapshot's getMinter is a vm-realm function, and the
    // mintCallback it returns is too — `instanceof Function` inside
    // WebPoMinter is host-realm, so both legs get a host-realm
    // async wrapper before the mint.
    const rawGetMinter = webPoSignalOutput[0];
    const signalOut: WebPoSignalOutput =
      typeof rawGetMinter === 'function'
        ? [
            async (key: Uint8Array) => {
              const cb = await rawGetMinter(key);
              if (typeof cb !== 'function') {
                throw new HttpError(
                  503,
                  'unavailable',
                  'pot: minter callback missing',
                );
              }
              // `cb` is realm code returning a realm Uint8Array —
              // copy across the boundary: WebPoMinter checks
              // `instanceof Uint8Array` against the host realm. `from`
              // takes any array-like, realm slots included.
              return async (binding: Uint8Array) =>
                Uint8Array.from(
                  (await cb(binding)) as ArrayLike<number>,
                );
            },
          ]
        : webPoSignalOutput;
    const minter = await WebPoMinter.create(
      {
        integrityToken,
        estimatedTtlSecs:
          typeof estimatedTtlSecs === 'number' ? estimatedTtlSecs : 0,
        mintRefreshThreshold: 0,
        websafeFallbackToken:
          typeof websafeFallbackToken === 'string'
            ? websafeFallbackToken
            : '',
      },
      signalOut,
    );
    return {
      mint: (contentBinding) =>
        minter.mintAsWebsafeString(contentBinding),
      expiresAtMs,
      freshUntilMs,
      dispose: () => sandbox.dispose(),
    };
  }
  // No integrity token — the websafe fallback is session-bound.
  if (
    typeof websafeFallbackToken === 'string' &&
    websafeFallbackToken.length > 0
  ) {
    const token = websafeFallbackToken;
    return {
      mint: async () => token,
      expiresAtMs,
      freshUntilMs,
      dispose: () => sandbox.dispose(),
    };
  }
  throw new HttpError(
    503,
    'unavailable',
    'pot: GenerateIT returned neither token form',
  );
}

/* ------------------------------- service --------------------------- */

export function createPotService(opts: PotServiceDeps): PotService {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now;
  const log = opts.log ?? ((): void => undefined);
  // The default mint path runs the BotGuard flow in a dedicated
  // child process — remote interpreter code never shares this
  // utility's address space (node:vm is an isolation boundary, not
  // a security one). The in-process path stays as the test/dev
  // seam: any injected fetchImpl or session selects it, so no unit
  // test spawns a child.
  const engine: MinterEngine | null =
    opts.session === undefined && opts.fetchImpl === undefined
      ? createProcessMinter({ log })
      : null;
  const sessionFactory: () => Promise<PotSession> =
    opts.session ??
    (engine !== null
      ? () => engine.buildSession()
      : () => buildBotGuardSession(fetchImpl, nowMs));
  const ratePerSec = opts.rateLimitPerSec ?? RATE_LIMIT_PER_SEC;
  const rateBurst = opts.rateLimitBurst ?? RATE_LIMIT_BURST;

  let server: Server | null = null;
  let binding: Promise<number | null> | null = null;
  let boundPort: number | null = null;
  let closing = false;

  let session: PotSession | null = null;
  let sessionPending: Promise<PotSession> | null = null;
  let lastFailureAt = 0;
  // Disposal waits out in-flight mints — sessions share one
  // interpreter context, so tearing one down while another request
  // still mints through it clears the vm timers that mint parks on
  // and wedges the shared child until the op timeout.
  const inflightMints = new Map<PotSession, number>();
  const deferredDispose = new Set<PotSession>();
  const disposeWhenIdle = (dead: PotSession): void => {
    if ((inflightMints.get(dead) ?? 0) > 0) {
      deferredDispose.add(dead);
      return;
    }
    dead.dispose?.();
  };
  const settleMint = (done: PotSession): void => {
    const left = (inflightMints.get(done) ?? 1) - 1;
    if (left > 0) {
      inflightMints.set(done, left);
      return;
    }
    inflightMints.delete(done);
    if (deferredDispose.delete(done)) {
      done.dispose?.();
    }
  };
  const clientKey =
    opts.clientKey ??
    ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  // Per-source token buckets — a shared global bucket would let any
  // unpaired LAN client drain the quota and 429 real playback.
  const clientBuckets = new Map<
    string,
    { tokens: number; refillAt: number }
  >();

  function ensureSession(): Promise<PotSession> {
    if (
      session !== null &&
      nowMs() <
        (session.freshUntilMs ?? session.expiresAtMs - SESSION_MARGIN_MS)
    ) {
      return Promise.resolve(session);
    }
    // The stale session can never serve again — release it up front.
    // Waiting for the replacement's success (or for close) would keep
    // an expired session's interpreter timers firing through every
    // failed refresh.
    const stale = session;
    session = null;
    if (stale !== null) {
      disposeWhenIdle(stale);
    }
    // An in-flight rebuild coalesces every concurrent caller —
    // the cooldown check only gates NEW builds.
    if (sessionPending !== null) {
      return sessionPending;
    }
    if (
      lastFailureAt !== 0 &&
      nowMs() - lastFailureAt < FAILURE_COOLDOWN_MS
    ) {
      return Promise.reject(
        new HttpError(
          503,
          'unavailable',
          'pot: session build cooling down',
        ),
      );
    }
    sessionPending = (async () => {
      try {
        const built = await sessionFactory();
        if (closing) {
          // The service shut down mid-build — drop the fresh session
          // rather than install timers the close already missed.
          built.dispose?.();
          throw new HttpError(503, 'unavailable', 'pot: service closed');
        }
        session = built;
        lastFailureAt = 0;
        return built;
      } catch (thrown) {
        lastFailureAt = nowMs();
        // Only our own error messages reach the log — a raw upstream
        // exception can carry request details or token material.
        log(
          thrown instanceof HttpError
            ? `pot: session build failed (${thrown.message})`
            : 'pot: session build failed',
        );
        throw thrown instanceof HttpError
          ? thrown
          : new HttpError(
              503,
              'unavailable',
              'pot: session build failed',
            );
      } finally {
        sessionPending = null;
      }
    })();
    return sessionPending;
  }

  const dropSession = (dead: PotSession): void => {
    if (session === dead) {
      session = null;
      disposeWhenIdle(dead);
    }
  };

  async function mint(contentBinding: string): Promise<MintResult> {
    const active = await ensureSession();
    inflightMints.set(active, (inflightMints.get(active) ?? 0) + 1);
    try {
      let poToken: string;
      try {
        poToken = await active.mint(contentBinding);
      } catch (thrown) {
        // A dead mint usually means the integrity session went stale —
        // drop it so the next request rebuilds rather than retrying a
        // corpse. The thrown value stays taxonomy-shaped.
        dropSession(active);
        throw thrown instanceof HttpError
          ? thrown
          : new HttpError(503, 'unavailable', 'pot: mint failed');
      }
      if (typeof poToken !== 'string' || poToken.length === 0) {
        // An empty mint is as dead as a thrown one — evict it, or every
        // later request replays the same bad session until expiry.
        dropSession(active);
        throw new HttpError(503, 'unavailable', 'pot: empty mint');
      }
      return { poToken, expiresAtMs: active.expiresAtMs };
    } finally {
      settleMint(active);
    }
  }

  function admit(clientId: string): boolean {
    const now = nowMs();
    let bucket = clientBuckets.get(clientId);
    if (bucket === undefined) {
      if (clientBuckets.size >= MAX_RATE_CLIENTS) {
        for (const [key, entry] of clientBuckets) {
          if (now - entry.refillAt > CLIENT_BUCKET_IDLE_MS) {
            clientBuckets.delete(key);
          }
        }
        if (clientBuckets.size >= MAX_RATE_CLIENTS) {
          return false;
        }
      }
      bucket = { tokens: rateBurst, refillAt: now };
      clientBuckets.set(clientId, bucket);
    }
    const elapsed = Math.max(0, now - bucket.refillAt);
    bucket.refillAt = now;
    bucket.tokens = Math.min(
      rateBurst,
      bucket.tokens + (elapsed / 1_000) * ratePerSec,
    );
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  function reply(
    res: ServerResponse,
    status: number,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    const out = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(out),
      ...extraHeaders,
    });
    res.end(out);
  }

  function fail(res: ServerResponse, thrown: unknown): void {
    if (thrown instanceof HttpError) {
      reply(res, thrown.status, {
        error: thrown.kind,
        message: thrown.message,
      });
      return;
    }
    reply(res, 500, {
      error: 'internal',
      message: 'pot: unexpected failure',
    });
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (req.method === 'GET' && path === '/ping') {
      reply(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || path !== '/get_pot') {
      reply(res, 404, { error: 'not-found' });
      return;
    }
    if (!admit(clientKey(req))) {
      reply(res, 429, { error: 'rate-limit' });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      if (bytes > MAX_BODY_BYTES) {
        // Unread body bytes would corrupt the next pipelined
        // request — answer, then close the connection for real.
        // Destroy only after the 413 actually flushes; an immediate
        // destroy races the queued response and resets instead.
        // (req.socket detaches before 'finish' — capture it now.)
        const sock = req.socket;
        res.once('finish', () => sock.destroy());
        reply(
          res,
          413,
          { error: 'invalid-request' },
          { connection: 'close' },
        );
        return;
      }
      chunks.push(buf);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      reply(res, 400, {
        error: 'invalid-request',
        message: 'pot: body is not JSON',
      });
      return;
    }
    const binding = isRecord(parsed)
      ? parsed['content_binding']
      : undefined;
    if (!isBoundedString(binding, MAX_BINDING_CHARS)) {
      reply(res, 400, {
        error: 'invalid-request',
        message: 'pot: content_binding must be a bounded string',
      });
      return;
    }
    const { poToken, expiresAtMs } = await mint(binding);
    reply(res, 200, {
      poToken,
      contentBinding: binding,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  return {
    bind(): Promise<number | null> {
      if (closing) {
        return Promise.resolve(null);
      }
      if (binding !== null) {
        return binding;
      }
      const srv = createServer((req, res) => {
        handle(req, res).catch((thrown) => {
          if (res.headersSent) {
            res.end();
          } else {
            fail(res, thrown);
          }
        });
      });
      binding = new Promise<number | null>((resolve) => {
        srv.once('error', (thrown) => {
          log(
            `pot: bind failed (${
              thrown instanceof Error ? thrown.message : 'unknown'
            })`,
          );
          binding = null; // a failed bind stays retryable
          resolve(null);
        });
        srv.listen({ host: '0.0.0.0', port: 0 }, () => {
          // close() can land while listen is still pending — don't
          // resurrect a listener into post-shutdown state.
          if (closing) {
            srv.close();
            resolve(null);
            return;
          }
          const address = srv.address();
          boundPort =
            address !== null && typeof address === 'object'
              ? address.port
              : null;
          server = srv;
          resolve(boundPort);
        });
      });
      return binding;
    },
    port() {
      return boundPort;
    },
    loopbackUrl() {
      return boundPort === null
        ? null
        : `http://127.0.0.1:${boundPort}`;
    },
    async close() {
      closing = true;
      if (session !== null) {
        disposeWhenIdle(session);
      }
      session = null;
      const srv = server;
      server = null;
      boundPort = null;
      // The minter child dies with the service — its sessions' vm
      // timers are inside it, and 'disconnect' unloads them there.
      await engine?.close();
      if (srv === null) {
        return;
      }
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
    },
  };
}
