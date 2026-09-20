import { run as runPlayer } from './adapters/auqw-expo-player.test.ts';
import { run as runProvider } from './adapters/plugin-provider.test.ts';
import { run as runRuntime } from './adapters/runtime.test.ts';
import { run as runRangeDownload } from './adapters/range-download.test.ts';

await runPlayer();
await runProvider();
await runRuntime();
await runRangeDownload();
console.log('mobile shell tests passed');
