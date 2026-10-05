import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  PLUGIN_RELEASE_TRUST,
  parsePluginPair,
  pluginPublicKey,
  syncPluginFeed,
  utf8Encode,
} from '@auqw/application';
import type { FeedSyncPorts } from '@auqw/application';
import type { AuqwExpoHostModuleLike } from '../adapters/auqw-expo-surface.ts';
import {
  FEED_CURRENT_FILE,
  parseFeedCurrent,
  serializeFeedCurrent,
} from './feed-current.ts';

/**
 * OTA plugin delivery (decision log, Plugin guests): nothing is
 * bundled — the signed release feed syncs self-describing pair
 * documents into `<Paths.document>/plugins` on this surface, and the
 * host loads the verified `<id>.json` entries it finds there. Every
 * load re-verifies the stored signature + digests, so tampered or
 * forged cache bytes can never execute.
 */

export const PLUGIN_DIR = new Directory(Paths.document, 'plugins');

const publicKey = pluginPublicKey();
const verifyPairOpts = {
  keyId: PLUGIN_RELEASE_TRUST.keyId,
  publicKey,
  verify: (message: Uint8Array, signature: Uint8Array) =>
    ed25519.verify(signature, message, publicKey),
};

const ports: FeedSyncPorts = {
  fetchBytes: async (url) => {
    // Bounded stall: a wedged feed must not hang boot (cached pairs)
    // or the first-launch populate. Per-fetch, not a total budget.
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`plugin feed fetch ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  },
  ed25519Verify: (message, signature) =>
    ed25519.verify(signature, message, publicKey),
  list: async () =>
    PLUGIN_DIR.exists
      ? PLUGIN_DIR.list()
          .filter((e): e is File => e instanceof File)
          .map((e) => e.name)
      : [],
  read: async (path) => {
    const f = new File(path);
    return f.exists ? f.bytes() : null;
  },
  write: async (path, bytes) => {
    const tmp = new File(`${path}.part`);
    if (tmp.exists) {
      tmp.delete();
    }
    tmp.create({ intermediates: true });
    const handle = tmp.open(FileMode.WriteOnly);
    try {
      handle.writeBytes(bytes);
    } finally {
      handle.close();
    }
    tmp.moveSync(new File(path), { overwrite: true });
  },
  remove: async (path) => {
    const f = new File(path);
    if (f.exists) {
      f.delete();
    }
  },
};

function feedUrl(): string {
  // Dev/test feed override — same EXPO_PUBLIC_ convention as the POT
  // provider seam. Expo only inlines dot-property env reads.
  return process.env.EXPO_PUBLIC_PLUGIN_FEED ?? PLUGIN_RELEASE_TRUST.feedUrl;
}

export type PluginCacheSync = {
  readonly ready: readonly string[];
  readonly compatible: readonly string[];
  /** Ids the feed still names — the revocation authority set. */
  readonly current: readonly string[];
};

/** Refresh the on-disk plugin set from the signed feed. Failures are
 * non-fatal — last-known-good stays loadable — and surface as `null`
 * so a caller never gates or revokes on a feed that didn't answer. */
export async function syncPluginCache(): Promise<PluginCacheSync | null> {
  try {
    const dir = PLUGIN_DIR.uri.replace(/\/+$/, '');
    const synced = await syncPluginFeed({
      feedUrl: feedUrl(),
      keyId: PLUGIN_RELEASE_TRUST.keyId,
      publicKey,
      dir,
      ports,
    });
    // Persist the settled authority set — the next boot's cached
    // load gates on it, so an id the feed dropped can't ride the
    // disk while this surface has no unload seam. The sweep exempts
    // this sidecar's name; a failed write just leaves the gate
    // fail-open one more boot.
    try {
      await ports.write(
        `${dir}/${FEED_CURRENT_FILE}`,
        utf8Encode(serializeFeedCurrent(synced.current)),
      );
    } catch {
      // Best-effort — the sync itself already succeeded.
    }
    return synced;
  } catch {
    return null;
  }
}

export type LoadedFeedPlugin = {
  readonly providerId: string;
  readonly manifestJson: string;
  readonly pluginId: string;
};

/** Load every verified pair currently on disk — no network wait. */
async function loadCachedPairs(
  host: Pick<AuqwExpoHostModuleLike, 'loadPlugin'>,
): Promise<LoadedFeedPlugin[]> {
  if (!PLUGIN_DIR.exists) {
    return [];
  }
  let manifests: File[];
  try {
    manifests = PLUGIN_DIR.list()
      .filter(
        (e): e is File =>
          e instanceof File &&
          e.name.endsWith('.json') &&
          e.name !== FEED_CURRENT_FILE,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  // The feed's refresh rides post-ready, so the revocation gate a
  // network-free boot can apply is the last synced `current` set: a
  // pair whose id is absent was already dropped, and a guest this
  // surface registers cannot be unloaded — it must never load at
  // all. A missing or malformed sidecar fails open: a feed that may
  // be unreachable never gates last-known-good.
  let gated: ReadonlySet<string> | null = null;
  try {
    const sidecar = new File(PLUGIN_DIR, FEED_CURRENT_FILE);
    if (sidecar.exists) {
      gated = parseFeedCurrent(sidecar.textSync());
    }
  } catch {
    gated = null;
  }
  // Independent pairs load concurrently — each verifies its own
  // signature and the host registers under a lock. A concurrent feed
  // sync can only swap a pair for another verified one (atomic .part
  // renames), never for unverified bytes.
  const settled = await Promise.all(
    manifests.map(async (pairFile) => {
      try {
        const pair = parsePluginPair(pairFile.textSync(), verifyPairOpts);
        if (pair === null) {
          return null;
        }
        if (gated !== null && !gated.has(pair.id)) {
          // Already dropped at the last known sync — sweep it the
          // way the feed sync would rather than load a revoked
          // guest for the whole session.
          try {
            pairFile.delete();
          } catch {
            // A failed delete retries through the feed sweep.
          }
          return null;
        }
        const pluginId = await host.loadPlugin(
          pair.wasmB64,
          pair.manifestJson,
        );
        return {
          providerId: pair.id,
          manifestJson: pair.manifestJson,
          pluginId,
        };
      } catch {
        // A malformed pair is skipped, not fatal — others still load.
        return null;
      }
    }),
  );
  return settled.filter((p): p is LoadedFeedPlugin => p !== null);
}

/** Load the verified pairs on disk. No network wait — but not
 * gate-free: the last synced `current` set still bars ids the feed
 * already dropped (freshness one boot behind IS the OTA model — a
 * boot-time revocation that only lands one sync late is the price of
 * keeping fetch + verify off the restore path). Only an empty cache
 * (first launch, wiped docs, or every pair corrupt) awaits the live
 * sync here — there is nothing else to load. */
export async function loadFeedPlugins(
  host: Pick<AuqwExpoHostModuleLike, 'loadPlugin'>,
): Promise<readonly LoadedFeedPlugin[]> {
  let loaded = await loadCachedPairs(host);
  if (loaded.length === 0) {
    await syncPluginCache();
    loaded = await loadCachedPairs(host);
  }
  return loaded;
}

/** One verified pair for dev seams that load a plugin by id. */
export async function pluginPairFromCache(
  id: string,
): Promise<{ wasmBase64: string; manifestJson: string } | null> {
  const file = new File(PLUGIN_DIR, `${id}.json`);
  if (!file.exists) {
    return null;
  }
  const pair = parsePluginPair(file.textSync(), verifyPairOpts);
  if (pair === null) {
    return null;
  }
  return { wasmBase64: pair.wasmB64, manifestJson: pair.manifestJson };
}
