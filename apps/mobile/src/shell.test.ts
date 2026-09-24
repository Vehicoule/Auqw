import { run as runPlayer } from './adapters/auqw-expo-player.test.ts';
import { run as runProvider } from './adapters/plugin-provider.test.ts';
import { run as runRuntime } from './adapters/runtime.test.ts';
import { run as runRangeDownload } from './adapters/range-download.test.ts';
import { run as runConnectivity } from './adapters/expo-connectivity.test.ts';
import { run as runExpoSync } from './adapters/expo-sync.test.ts';
import { run as runPotProvider } from './adapters/pot-provider.test.ts';
import { runSyncEmit } from './session/sync-emit.test.ts';
import { devRoute } from './dev-routes.ts';

assertEqual(devRoute('auqw://gallery'), 'gallery');
assertEqual(devRoute('auqw://seam-file'), 'seam');
assertEqual(devRoute('auqw://open?tab=home'), 'journey');
assertEqual(devRoute('auqw://open?tab=settings'), 'journey');
assertEqual(devRoute('auqw://open?tab=library&playlist=pl-1'), 'journey');
assertEqual(
  devRoute('auqw://entity?provider=deezer&kind=album&id=a1'),
  'journey',
);
assertEqual(devRoute('auqw://lyrics'), 'journey');
assertEqual(
  devRoute('auqw://radio?provider=deezer&id=dz-t-1'),
  'journey',
);
assertEqual(devRoute('auqw://corrections'), 'journey');
assertEqual(devRoute('auqw://transfer'), 'journey');
assertEqual(
  devRoute('auqw://transfer?import=/tmp/lib.json'),
  'journey',
);
assertEqual(
  devRoute('auqw://provider?catalog=deezer&lyrics=auto'),
  'journey',
);
assertEqual(devRoute('auqw://stop-radio'), 'journey');
assertEqual(devRoute('https://example.test'), null);

await runPlayer();
await runProvider();
await runRuntime();
await runRangeDownload();
await runConnectivity();
await runExpoSync();
runPotProvider();
await runSyncEmit();
console.log('mobile shell tests passed');

function assertEqual<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
