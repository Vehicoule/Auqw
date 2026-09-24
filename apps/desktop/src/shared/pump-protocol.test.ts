import { assert } from '@auqw/application/testing';
import {
  isPumpClientMessage,
  isPumpServerMessage,
} from './pump-protocol.ts';

export function run(): void {
  // client → pump
  assert(isPumpClientMessage({ kind: 'grant', bytes: 1 }), 'grant min');
  assert(
    isPumpClientMessage({ kind: 'grant', bytes: 16 * 1024 * 1024 }),
    'grant at the frame cap',
  );
  assert(
    !isPumpClientMessage({ kind: 'grant', bytes: 16 * 1024 * 1024 + 1 }),
    'grant over the cap rejected',
  );
  assert(
    !isPumpClientMessage({ kind: 'grant', bytes: 0 }),
    'zero-byte grant rejected',
  );
  assert(
    !isPumpClientMessage({ kind: 'grant', bytes: -5 }),
    'negative grant rejected',
  );
  assert(
    !isPumpClientMessage({ kind: 'grant', bytes: 1.5 }),
    'fractional grant rejected',
  );
  assert(
    isPumpClientMessage({ kind: 'seek', position: 0, epoch: 3 }),
    'seek shape',
  );
  assert(
    !isPumpClientMessage({ kind: 'seek', position: -1, epoch: 0 }),
    'negative seek position rejected',
  );
  assert(
    !isPumpClientMessage({ kind: 'seek', position: 4 }),
    'seek without epoch rejected',
  );
  assert(
    isPumpClientMessage({ kind: 'close' }),
    'close shape',
  );
  assert(
    !isPumpClientMessage({ kind: 'close', extra: 1 }),
    'close with extras rejected',
  );
  assert(
    !isPumpClientMessage({ kind: 'data', position: 0, epoch: 0, bytes: [] }),
    'client data kind rejected',
  );
  assert(!isPumpClientMessage('grant'), 'non-record rejected');
  assert(!isPumpClientMessage(null), 'null rejected');
  assert(!isPumpClientMessage({}), 'empty record rejected');

  // pump → client
  assert(
    isPumpServerMessage({ kind: 'ready', remaining: 42, epoch: 0 }),
    'ready with remaining',
  );
  assert(
    isPumpServerMessage({ kind: 'ready', remaining: null, epoch: 0 }),
    'ready with unknown total',
  );
  assert(
    !isPumpServerMessage({ kind: 'ready', remaining: -1, epoch: 0 }),
    'negative remaining rejected',
  );
  const chunk = new Uint8Array(64);
  assert(
    isPumpServerMessage({
      kind: 'data',
      position: 0,
      epoch: 1,
      bytes: chunk,
    }),
    'data shape',
  );
  assert(
    !isPumpServerMessage({
      kind: 'data',
      position: 0,
      epoch: 1,
      bytes: new Uint8Array(2 * 1024 * 1024 + 1),
    }),
    'data over the 2MiB frame cap rejected',
  );
  assert(
    isPumpServerMessage({
      kind: 'data',
      position: 0,
      epoch: 1,
      bytes: new Uint8Array(0),
    }),
    'empty data frame accepted (eof signals separately)',
  );
  assert(
    !isPumpServerMessage({
      kind: 'data',
      position: 0,
      epoch: 1,
      bytes: 'not bytes',
    }),
    'non-Uint8Array bytes rejected',
  );
  assert(isPumpServerMessage({ kind: 'eof', epoch: 7 }), 'eof shape');
  assert(
    !isPumpServerMessage({ kind: 'eof' }),
    'eof without epoch rejected',
  );
  assert(
    isPumpServerMessage({
      kind: 'error',
      epoch: 0,
      code: 'closed',
      message: 'pump port closed',
    }),
    'error shape',
  );
  assert(
    !isPumpServerMessage({
      kind: 'error',
      epoch: 0,
      code: 'x'.repeat(65),
      message: 'm',
    }),
    'overlong code rejected',
  );
  assert(
    !isPumpServerMessage({ kind: 'ready', remaining: 0, epoch: -1 }),
    'negative epoch rejected everywhere',
  );
}
