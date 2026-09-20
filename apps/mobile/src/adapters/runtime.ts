import type {
  ClockPort,
  IdPort,
  LogPort,
  Result,
} from '@auqw/application';
import { appError, err, ok } from '@auqw/application';

function isSafeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function cancelledError() {
  return appError('cancelled', 'cancelled');
}

/**
 * Wall-clock/system shell ports. RN-free (Date, setTimeout, console,
 * optional crypto) so the module also runs under plain Node.
 */
export function createClock(): ClockPort {
  return {
    nowMs: () => Date.now(),
    sleep(ms, signal) {
      if (!isSafeNonNegative(ms)) {
        throw new TypeError('ms must be a safe nonnegative integer');
      }
      if (signal.cancelled) {
        return Promise.resolve(err(cancelledError()));
      }
      return new Promise<Result<void>>((resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          resolve(ok(undefined));
        }, ms);
        const unsubscribe = signal.subscribe(() => {
          clearTimeout(timer);
          resolve(err(cancelledError()));
        });
      });
    },
  };
}

/**
 * `crypto.randomUUID` where the runtime provides it (Hermes does not
 * always); otherwise a monotonic counter + time + random composite —
 * uniqueness matters, the shape does not.
 */
export function createIds(): IdPort {
  const uuid =
    typeof globalThis.crypto === 'object' &&
      typeof globalThis.crypto.randomUUID === 'function'
      ? (): string => globalThis.crypto.randomUUID()
      : null;
  let sequence = 0;
  return {
    next(prefix: string): string {
      if (uuid !== null) {
        return `${prefix}-${uuid()}`;
      }
      sequence += 1;
      return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
    },
  };
}

export type LogSink = (entry: {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  atMs: number;
}) => void;

/**
 * Console-backed LogPort; an injectable sink for tests/dev capture.
 * A throwing sink degrades to a typed error — logging never breaks
 * the call path.
 */
export function createLog(sink?: LogSink): LogPort {
  const emit: LogSink =
    sink ??
    ((entry) => {
      const line = `[auqw] ${entry.message}`;
      switch (entry.level) {
        case 'debug':
          console.debug(line);
          break;
        case 'info':
          console.info(line);
          break;
        case 'warn':
          console.warn(line);
          break;
        case 'error':
          console.error(line);
          break;
      }
    });
  return {
    write(entry) {
      try {
        emit(entry);
        return Promise.resolve(ok(undefined));
      } catch {
        return Promise.resolve(
          err(appError('internal', 'log sink failed')),
        );
      }
    },
  };
}
