import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  PLUGIN_RELEASE_TRUST,
  pluginPublicKey,
  syncPluginFeed,
} from '@auqw/application';
import type { FeedSyncPorts } from '@auqw/application';
import type { AuqwExpoHostModuleLike } from '../adapters/auqw-expo-surface.ts';

/**
 * OTA plugin delivery (decision log, Plugin guests): nothing is
 * bundled — the signed release feed syncs into
 * `<Paths.document>/plugins` on this surface, and the host loads the
 * verified `<id>.wasm` + `<id>.manifest.json` pairs it finds there.
 */

export const PLUGIN_DIR = new Directory(Paths.document, 'plugins');

const ports: FeedSyncPorts = {
  fetchBytes: async (url) => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`plugin feed fetch ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  },
  ed25519Verify: (message, signature, publicKey) =>
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
  // provider seam.
  return process.env['EXPO_PUBLIC_PLUGIN_FEED'] ?? PLUGIN_RELEASE_TRUST.feedUrl;
}

/** Refresh the on-disk plugin set from the signed feed. Failures are
 * non-fatal — last-known-good stays loadable. */
export async function syncPluginCache(): Promise<readonly string[]> {
  try {
    return await syncPluginFeed({
      feedUrl: feedUrl(),
      keyId: PLUGIN_RELEASE_TRUST.keyId,
      publicKey: pluginPublicKey(),
      dir: PLUGIN_DIR.uri.replace(/\/+$/, ''),
      ports,
    });
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
  const manifests = PLUGIN_DIR.list()
    .filter(
      (e): e is File =>
        e instanceof File && e.name.endsWith('.manifest.json'),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const manifestFile of manifests) {
    const stem = manifestFile.name.slice(0, -'.manifest.json'.length);
    const wasm = new File(PLUGIN_DIR, `${stem}.wasm`);
    if (!wasm.exists) {
      continue;
    }
    const manifestJson = manifestFile.textSync();
    try {
      loaded.push({
        providerId: stem,
        manifestJson,
        pluginId: await host.loadPlugin(await wasm.base64(), manifestJson),
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
  const manifest = new File(PLUGIN_DIR, `${id}.manifest.json`);
  const wasm = new File(PLUGIN_DIR, `${id}.wasm`);
  if (!manifest.exists || !wasm.exists) {
    return null;
  }
  return { wasmBase64: await wasm.base64(), manifestJson: manifest.textSync() };
}
