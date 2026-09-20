import { run as runPlayer } from './adapters/auqw-expo-player.test.ts';
import { run as runProvider } from './adapters/plugin-provider.test.ts';
import { run as runRuntime } from './adapters/runtime.test.ts';
import { run as runRangeDownload } from './adapters/range-download.test.ts';
import { devRoute } from './dev-routes.ts';

assertEqual(devRoute('auqw://gallery'), 'gallery');
assertEqual(devRoute('auqw://seam-file'), 'seam');
assertEqual(devRoute('auqw://open?tab=home'), 'journey');
assertEqual(devRoute('auqw://open?tab=library&playlist=pl-1'), 'journey');
assertEqual(
  devRoute('auqw://entity?provider=deezer&kind=album&id=a1'),
  'journey',
);
assertEqual(devRoute('https://example.test'), null);

await runPlayer();
await runProvider();
await runRuntime();
await runRangeDownload();
console.log('mobile shell tests passed');

function assertEqual<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
