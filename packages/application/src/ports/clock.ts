import type { CancellationSignal } from '../cancellation.ts';
import type { Result } from '../errors.ts';

export interface ClockPort {
  nowMs(): number;
  sleep(ms: number, signal: CancellationSignal): Promise<Result<void>>;
}
