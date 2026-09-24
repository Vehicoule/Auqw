import type { ShellError } from '../shared/errors.ts';

/**
 * Wire messages between the main-process supervisor and the utility
 * child. Requests carry a correlation id; responses answer with the same
 * id plus the shared result envelope.
 */
export type UtilityRequest = {
  readonly id: number;
  readonly channel: string;
  readonly args: unknown;
};

export type UtilityResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: ShellError;
    };
