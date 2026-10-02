import { Linking, Platform } from 'react-native';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as AuqwExpo from 'auqw-expo';
import {
  UPDATE_RELEASES_PAGE,
  appError,
  createSha256,
  createUpdateApplier,
  createUpdateService,
} from '@auqw/application';
import type { UpdateApplyPorts, UpdateTarget } from '@auqw/application';
import type { UpdateShellPort } from '@auqw/app-shell';
import { notify, t } from '@auqw/ui-shared';
import { holdDownloadForeground } from './download-foreground.ts';

// APKs self-update only from this repo's own release downloads — an
// off-repo asset URL is a failed install, not an installer payload.
// (Same allowlist shape as the desktop open gate.)
const RELEASE_DOWNLOAD_PREFIX =
  'https://github.com/Vehicoule/Auqw/releases/download/';

/**
 * The mobile UpdateShellPort: the shared release check over RN
 * `fetch`, and the shared apply pipeline over `File.downloadFileAsync`
 * — byte progress, AbortSignal cancel, SHA256SUMS verification before
 * the APK is handed to the system package installer. The download
 * counts against the dataSync foreground service so a switch to
 * another app doesn't suspend a ~150 MB fetch. When the
 * unknown-sources gate refuses, installApk opens this app's page of
 * that settings surface and returns 'needs-permission', which the
 * apply pipeline parks as its own state on the retained, verified
 * stage — a retry refires installApk on it rather than
 * re-downloading. On every other platform, and on Android when the
 * release ships no APK asset or none built for the device's ABIs,
 * `action` degrades to 'open' and `act()` opens the release page.
 */
export function createExpoUpdate(currentVersion: string): UpdateShellPort {
  const target: UpdateTarget =
    Platform.OS === 'android'
      ? { os: 'android', supportedAbis: AuqwExpo.supportedAbis() }
      : { os: 'other' };
  // The seam probe answers capability, not grant — the unknown-
  // sources switch is per-user and only checked at install time.
  const canInstall =
    Platform.OS === 'android' && AuqwExpo.hasApkInstaller();
  const android = Platform.OS === 'android';

  const applier = canInstall
    ? createUpdateApplier({
        stagePath: (artifact) => {
          const directory = new Directory(Paths.cache, 'auqw-update');
          if (!directory.exists) {
            directory.create({ intermediates: true, idempotent: true });
          }
          // Each release's APK has a fresh name — without the sweep
          // every update leaves last release's artifact behind in app
          // storage. Best-effort: a stubborn stale file never blocks.
          for (const entry of directory.list()) {
            if (entry.name !== artifact.name) {
              try {
                entry.delete();
              } catch {
                // stale-cache cleanup is housekeeping, not the apply's job
              }
            }
          }
          return new File(directory, artifact.name).uri;
        },
        fetchText: async (url, signal) => {
          // The sums file rides the same disk-bound transport as the
          // APK: the global fetch materializes response bodies in
          // memory with no cap, but a downloaded file is byte-counted
          // on disk BEFORE anything reads it — over-cap is
          // invalid-response, never a memory hit.
          const directory = new Directory(Paths.cache, 'auqw-update');
          if (!directory.exists) {
            directory.create({ intermediates: true, idempotent: true });
          }
          const sums = new File(directory, 'SHA256SUMS-fetch');
          try {
            await File.downloadFileAsync(url, sums, {
              idempotent: true,
              signal: signal as AbortSignal,
            });
          } catch (thrown) {
            if (signal.aborted) {
              throw appError('cancelled', 'checksums fetch aborted');
            }
            throw appError(
              'transient',
              `checksums fetch: ${thrown instanceof Error ? thrown.message : 'failed'}`,
            );
          }
          if (!sums.exists || sums.size > 1024 * 1024) {
            throw appError('invalid-response', 'checksums body over 1 MiB');
          }
          const body = await sums.text();
          try {
            sums.delete();
          } catch {
            // the staging sweep owns cleanup; a stubborn file is harmless
          }
          return body;
        },
        download: async (url, path, onProgress, signal) => {
          if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
            throw appError(
              'invalid-response',
              'artifact is not a repo release asset',
            );
          }
          const destination = new File(path);
          // idempotent: a retry of the SAME release (e.g. granted
          // unknown-sources after 'needs-permission') overwrites its
          // own prior APK.
          if (destination.exists) {
            destination.delete();
          }
          // The dataSync foreground service keeps the fetch alive
          // through backgrounding — the APK outlives a user switching
          // apps mid-download. The hold is a REF through
          // download-foreground: the service counts every download,
          // so releasing must never zero a live media transfer.
          const releaseForeground = holdDownloadForeground((count) => {
            try {
              // Rejection propagates so the aggregate marks the edge
              // undelivered and retries it on the next report.
              return Promise.resolve(
                AuqwExpo.downloadsActiveChanged(count),
              );
            } catch {
              // the seam is Android-only; anywhere else this is a no-op
              return Promise.resolve();
            }
          });
          try {
            await File.downloadFileAsync(url, destination, {
              idempotent: true,
              signal: signal as AbortSignal,
              onProgress: (progress) =>
                onProgress(
                  progress.bytesWritten,
                  progress.totalBytes > 0 ? progress.totalBytes : null,
                ),
            });
          } finally {
            releaseForeground();
          }
        },
        sha256Hex: (path) => {
          const handle = new File(path).open(FileMode.ReadOnly);
          const hasher = createSha256();
          try {
            // Chunked like the transfer digest — a whole-APK JS
            // allocation can OOM a memory-constrained phone.
            for (;;) {
              const chunk = handle.readBytes(1024 * 1024);
              if (chunk.length === 0) {
                break;
              }
              hasher.update(chunk);
            }
          } finally {
            try {
              handle.close();
            } catch {
              // a failed close changes nothing about the digest
            }
          }
          return Promise.resolve(hasher.digest());
        },
        apply: async (path) => {
          const result = await AuqwExpo.installApk(path);
          if (result.status === 'needs-permission') {
            throw appError(
              'permission-denied',
              'unknown-sources install blocked',
            );
          }
          return 'installed';
        },
        remove: (path) => {
          try {
            new File(path).delete();
          } catch {
            // best-effort — the stagePath sweep also catches strays
          }
          return Promise.resolve();
        },
      } satisfies UpdateApplyPorts)
    : undefined;

  const releasesUrl = process.env.EXPO_PUBLIC_UPDATE_RELEASES_URL;
  const service = createUpdateService({
    currentVersion,
    target,
    fetchJson: async (url) => {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.github+json' },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    // Dev seam (same convention as EXPO_PUBLIC_POT_PROVIDER_URL):
    // point the check at a local/staging releases payload — e.g. a
    // fixture feed over `adb reverse` for deterministic update legs.
    ...(releasesUrl !== undefined && releasesUrl !== ''
      ? { releasesUrl }
      : {}),
    ...(applier !== undefined ? { applier } : {}),
  });

  if (android) {
    // Post-install receipt: a marker one release behind the running
    // build proves the APK install actually landed (the OS sheet is
    // fire-and-forget) — toast it, then stamp the marker forward.
    // Cache survives updates; a cleared cache just re-stamps.
    const marker = new File(Paths.cache, 'auqw-version');
    try {
      const seen = marker.exists ? marker.textSync().trim() : null;
      if (seen !== null && seen !== currentVersion) {
        notify(t('toast.updated', { version: currentVersion }));
      }
      marker.write(currentVersion);
    } catch {
      // a lost marker is one missed toast, not a failed boot
    }
  }

  return {
    snapshot: () => service.snapshot(),
    subscribe: (listener) => service.subscribe(listener),
    check: (kind) => {
      void service.check(kind);
    },
    // Read live, not at construction — a release that ships no APK,
    // or one it can't prove with checksums, advertises 'open': an
    // unverifiable artifact never installs.
    get action(): 'open' | 'install' {
      const status = service.snapshot().status;
      return canInstall &&
        status.state === 'available' &&
        status.artifact !== null &&
        status.checksums !== null
        ? 'install'
        : 'open';
    },
    act() {
      const snapshot = service.snapshot();
      const applyState = snapshot.apply.state;
      // 'applied' means the OS sheet owned the outcome — which may
      // never have landed (cancelled sheet, failed install);
      // 'needs-permission' means the unknown-sources gate refused it.
      // Both keep the verified APK staged, so the affordance refires
      // the handoff instead of dead-ending the offer — but only while
      // the checked release IS the staged one: a newer release starts
      // its own pipeline rather than re-prompting the old APK.
      if (applyState === 'applied' || applyState === 'needs-permission') {
        const status = snapshot.status;
        if (
          status.state === 'available' &&
          status.version !== snapshot.apply.version
        ) {
          // The newer release may itself be un-installable on this
          // build (no APK asset or no checksums) — the open-page
          // fallback owns that affordance, same as the normal path.
          if (
            canInstall &&
            status.artifact !== null &&
            status.checksums !== null
          ) {
            service.apply();
          } else {
            void Linking.openURL(status.url).catch(() => undefined);
          }
          return;
        }
        service.reapply();
        return;
      }
      // A live apply ignores the affordance — cancel is the card's
      // own verb; 'ready-to-restart' has no relaunch leg here.
      if (applyState !== 'idle' && applyState !== 'failed') {
        return;
      }
      const status = snapshot.status;
      if (
        status.state !== 'available' ||
        status.artifact === null ||
        status.checksums === null ||
        !canInstall
      ) {
        const url =
          status.state === 'available' ? status.url : UPDATE_RELEASES_PAGE;
        void Linking.openURL(url).catch(() => undefined);
        return;
      }
      // 'idle' starts the pipeline; 'failed' retries it.
      service.apply();
    },
    cancel() {
      service.cancelApply();
    },
  };
}
