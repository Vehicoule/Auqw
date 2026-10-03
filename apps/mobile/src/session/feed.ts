import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  PLUGIN_RELEASE_TRUST,
  parsePluginPair,
  pluginPublicKey,
  syncPluginFeed,
} from '@auqw/application';
import type { FeedSyncPorts } from '@auqw/application';
import type { AuqwExpoHostModuleLike } from '../adapters/auqw-expo-surface.ts';

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
    const res = await fetch(url);
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

/** Refresh the on-disk plugin set from the signed feed. Failures are
 * non-fatal — last-known-good stays loadable. */
export async function syncPluginCache(): Promise<readonly string[]> {
  try {
    return (
      await syncPluginFeed({
        feedUrl: feedUrl(),
        keyId: PLUGIN_RELEASE_TRUST.keyId,
        publicKey,
        dir: PLUGIN_DIR.uri.replace(/\/+$/, ''),
        ports,
      })
    ).ready;
  } catch {
    return [];
  }
}

export type LoadedFeedPlugin = {
  readonly providerId: string;
  readonly manifestJson: string;
  readonly pluginId: string;
};

/** Sync the feed, then load every verified pair on `host`. */
export async function loadFeedPlugins(
  host: Pick<AuqwExpoHostModuleLike, 'loadPlugin'>,
): Promise<readonly LoadedFeedPlugin[]> {
  await syncPluginCache();
  const loaded: LoadedFeedPlugin[] = [];
  if (!PLUGIN_DIR.exists) {
    return loaded;
  }
  let manifests: File[];
  try {
    manifests = PLUGIN_DIR.list()
      .filter(
        (e): e is File => e instanceof File && e.name.endsWith('.json'),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return loaded;
  }
  for (const pairFile of manifests) {
    try {
      const pair = parsePluginPair(pairFile.textSync(), verifyPairOpts);
      if (pair === null) {
        continue;
      }
      loaded.push({
        providerId: pair.id,
        manifestJson: pair.manifestJson,
        pluginId: await host.loadPlugin(pair.wasmB64, pair.manifestJson),
      });
    } catch {
      // A malformed pair is skipped, not fatal — other pairs still load.
    }
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
