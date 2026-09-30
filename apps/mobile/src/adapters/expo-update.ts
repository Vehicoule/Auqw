import { Linking, Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as AuqwExpo from 'auqw-expo';
import {
  UPDATE_RELEASES_PAGE,
  appError,
  appErrorKind,
  createUpdateService,
  err,
  ok,
} from '@auqw/application';
import type {
  AppError,
  Result,
  UpdateArtifact,
  UpdateTarget,
} from '@auqw/application';
import type { UpdateShellPort } from '@auqw/app-shell';
import { reportResult } from '@auqw/ui-shared';

/**
 * The mobile UpdateShellPort: the shared release check over RN
 * `fetch`, and an install affordance that on Android actually
 * installs — the APK is fetched into `Paths.cache/auqw-update/` (the
 * FileProvider's only exported root — see the auqw-expo manifest) and
 * handed to the system package installer. When the unknown-sources
 * gate refuses, the module opens this app's page of that settings
 * surface and returns 'needs-permission', which lands as a toast —
 * never a claimed install. On every other platform, and on Android
 * when the release ships no APK asset, `action` degrades to 'open'
 * and `act()` opens the release page instead.
 */
export function createExpoUpdate(currentVersion: string): UpdateShellPort {
  const target: UpdateTarget =
    Platform.OS === 'android' ? { os: 'android' } : { os: 'other' };
  const service = createUpdateService({
    currentVersion,
    target,
    fetchJson: async (url) => {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.github+json' },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  });
  // The seam probe answers capability, not grant — the unknown-
  // sources switch is per-user and only checked at act() time.
  const canInstall =
    Platform.OS === 'android' && AuqwExpo.hasApkInstaller();
  let installing = false;

  function installError(thrown: unknown): AppError {
    if (
      thrown !== null &&
      typeof thrown === 'object' &&
      'kind' in thrown &&
      typeof (thrown as { kind: unknown }).kind === 'string'
    ) {
      const kind = appErrorKind((thrown as { kind: string }).kind);
      if (kind !== 'internal') {
        return appError(kind, 'update install failed');
      }
    }
    return appError('transient', 'update install failed');
  }

  async function install(artifact: UpdateArtifact): Promise<Result<void>> {
    const directory = new Directory(Paths.cache, 'auqw-update');
    if (!directory.exists) {
      directory.create({ intermediates: true, idempotent: true });
    }
    const destination = new File(directory, artifact.name);
    if (destination.exists) {
      destination.delete();
    }
    const file = await File.downloadFileAsync(artifact.url, destination);
    const result = await AuqwExpo.installApk(file.uri);
    return result.status === 'needs-permission'
      ? err(appError('permission-denied', 'unknown-sources install blocked'))
      : ok(undefined);
  }

  return {
    snapshot: () => service.snapshot(),
    subscribe: (listener) => service.subscribe(listener),
    check: (kind) => {
      void service.check(kind);
    },
    action: canInstall ? 'install' : 'open',
    act() {
      const status = service.snapshot().status;
      const url = status.state === 'available' ? status.url : UPDATE_RELEASES_PAGE;
      if (status.state !== 'available' || status.artifact === null || !canInstall) {
        void Linking.openURL(url).catch(() => undefined);
        return;
      }
      if (installing) {
        return;
      }
      installing = true;
      void install(status.artifact)
        .then((result) => reportResult('update.action.install', result))
        .catch((thrown: unknown) =>
          reportResult('update.action.install', err(installError(thrown))),
        )
        .finally(() => {
          installing = false;
        });
    },
  };
}
