import type { Result } from '../errors.ts';

export interface LogPort {
  write(entry: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    atMs: number;
  }): Promise<Result<void>>;
}
