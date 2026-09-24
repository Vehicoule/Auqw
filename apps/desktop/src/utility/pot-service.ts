import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import vm from 'node:vm';
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
 * Browser-ish globals for the BotGuard VM — the minimal set the
 * interpreter probes. Nothing here touches the utility's own
 * globals; host capabilities (fetch/crypto/performance/encoders)
 * are injected explicitly, everything else is inert stubs.
 */
function botGuardSandbox(
  ytcfg: unknown,
  fetchImpl: FetchLike,
  allowedFetchHost: string,
): { globals: Record<string, unknown>; dispose(): void } {
  const noOp = (): undefined => undefined;
  const elementStub = (): Record<string, unknown> => ({
    getContext: () => null,
    style: {},
    appendChild: noOp,
    removeChild: noOp,
    setAttribute: noOp,
    remove: noOp,
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noOp,
    removeEventListener: noOp,
  });
  // Timers the interpreter schedules land on the host loop — track
  // the handles so a dropped session can't leave callbacks firing.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const trackTimeout = (
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const handle = setTimeout(
      (...inner: unknown[]) => {
        timers.delete(handle);
        cb(...inner);
      },
      ms,
      ...args,
    );
    timers.add(handle);
    return handle;
  };
  const untrack = (handle: ReturnType<typeof setTimeout>): void => {
    timers.delete(handle);
    clearTimeout(handle);
  };
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
  // Header fields the interpreter may legitimately set on a probe —
  // everything else (auth-ish or tracking headers) is dropped.
  const SANDBOX_HEADER_ALLOW = new Set([
    'accept',
    'accept-language',
    'content-type',
  ]);
  // The remote code's whole network surface is the two origins this
  // flow already provably uses — the interpreter's own host and the
  // homepage it rode in on — exact hosts, nothing wider.
  const sandboxFetchHosts = new Set([
    allowedFetchHost.toLowerCase(),
    new URL(HOMEPAGE).hostname,
  ]);
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
  const sandbox: Record<string, unknown> = {
    navigator: {
      userAgent: HOMEPAGE_UA,
      platform: 'Linux x86_64',
      languages: ['en-US', 'en'],
      language: 'en-US',
      webdriver: false,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      plugins: [],
      mimeTypes: [],
      cookieEnabled: true,
      maxTouchPoints: 0,
      vendor: 'Google Inc.',
      appName: 'Netscape',
      appVersion: HOMEPAGE_UA.slice('Mozilla/'.length),
      product: 'Gecko',
      productSub: '20030107',
      onLine: true,
    },
    document: {
      documentElement: elementStub(),
      head: elementStub(),
      body: elementStub(),
      cookie: '',
      readyState: 'complete',
      createElement: elementStub,
      createTextNode: (text: string) => ({ nodeValue: text }),
      getElementsByTagName: () => [],
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noOp,
      removeEventListener: noOp,
    },
    location: new URL(HOMEPAGE),
    origin: HOMEPAGE,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
    },
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    devicePixelRatio: 1,
    addEventListener: noOp,
    removeEventListener: noOp,
    dispatchEvent: () => true,
    requestAnimationFrame: (cb: () => void) => trackTimeout(cb, 0),
    cancelAnimationFrame: untrack,
    localStorage: new Map<string, string>(),
    sessionStorage: new Map<string, string>(),
    history: { length: 1, pushState: noOp, replaceState: noOp },
    Image: class Image {},
    XMLHttpRequest: class XMLHttpRequest {},
    // The homepage's ytcfg — BotGuard reads yt.config_.EVENT_ID.
    yt: ytcfg ?? { config_: {} },
  };
  // Host-realm capabilities the interpreter legitimately uses —
  // timers, encoders, crypto, fetch. Passed deliberately, not ambient.
  const hostGlobals: Record<string, unknown> = {
    fetch: sandboxFetch,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    TextEncoder,
    TextDecoder,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    setTimeout: trackTimeout,
    clearTimeout: untrack,
    setInterval: (
      cb: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const handle = setInterval(cb, ms, ...args);
      timers.add(handle);
      return handle;
    },
    clearInterval: untrack,
    queueMicrotask,
    console,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
    structuredClone: globalThis.structuredClone,
    DOMException,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    DataView,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Proxy,
    Reflect,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    escape,
    unescape,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  };
  Object.assign(sandbox, hostGlobals);
  sandbox['window'] = sandbox;
  sandbox['self'] = sandbox;
  sandbox['top'] = sandbox;
  sandbox['parent'] = sandbox;
  sandbox['frames'] = sandbox;
  sandbox['globalThis'] = sandbox;
  return {
    globals: sandbox,
    dispose(): void {
      for (const handle of timers) {
        clearTimeout(handle);
      }
      timers.clear();
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
  sandbox: { globals: Record<string, unknown>; dispose(): void },
  fetchImpl: FetchLike,
  nowMs: () => number,
): Promise<PotSession> {
  const ctx = vm.createContext(sandbox.globals);
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
              return async (binding: Uint8Array) => cb(binding);
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
    stale?.dispose?.();
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
      dead.dispose?.();
    }
  };

  async function mint(contentBinding: string): Promise<MintResult> {
    const active = await ensureSession();
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
      session?.dispose?.();
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
