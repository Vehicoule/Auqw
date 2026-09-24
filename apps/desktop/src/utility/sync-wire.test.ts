import { assert, assertEqual } from '@auqw/application/testing';
import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { attachWirePump, type WirePump } from './sync-wire.ts';

function once(emitter: { once(e: string, l: () => void): unknown }, ev: string) {
  return new Promise<void>((resolve) => emitter.once(ev, resolve));
}

/** A connected 127.0.0.1 socket pair; close() tears both ends down. */
async function socketPair(): Promise<{
  a: Socket;
  b: Socket;
  close: () => Promise<void>;
}> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const b = createConnection({ host: '127.0.0.1', port });
  const a = await new Promise<Socket>((resolve) => {
    server.once('connection', resolve);
  });
  await once(b, 'connect');
  return {
    a,
    b,
    async close() {
      a.destroy();
      b.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

export async function run(): Promise<void> {
  // Round trip: a frame lands whole even when written in pieces.
  {
    const { a, b, close } = await socketPair();
    const got: string[] = [];
    attachWirePump({
      socket: a,
      maxPayload: 1024,
      onFrame: (f) => got.push(f.toString('utf8')),
      onClose: () => undefined,
    });
    const payload = Buffer.from('{"t":"ping"}', 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(payload.length, 0);
    const whole = Buffer.concat([head, payload]);
    b.write(whole.subarray(0, 3));
    b.write(whole.subarray(3));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEqual(got.length, 1, 'fragmented frame reassembles');
    assertEqual(got[0], '{"t":"ping"}');
    await close();
  }

  // Several frames in one chunk each land.
  {
    const { a, b, close } = await socketPair();
    const got: string[] = [];
    const pump = attachWirePump({
      socket: a,
      maxPayload: 1024,
      onFrame: (f) => got.push(f.toString('utf8')),
      onClose: () => undefined,
    });
    pump.send(Buffer.from('one'));
    const two = attachWirePump({
      socket: b,
      maxPayload: 1024,
      onFrame: (f) => got.push(`b:${f.toString('utf8')}`),
      onClose: () => undefined,
    });
    two.send(Buffer.from('two'));
    two.send(Buffer.from('three'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert(got.includes('b:one'), 'reply frame lands');
    assert(got.includes('two') && got.includes('three'), 'batched frames land');
    await close();
  }

  // A declared length past the cap destroys the connection — no hang,
  // no allocation of the promised body.
  {
    const { a, b, close } = await socketPair();
    const reason = await new Promise<string>((resolve) => {
      attachWirePump({
        socket: a,
        maxPayload: 64,
        onFrame: () => undefined,
        onClose: resolve,
      });
      const head = Buffer.alloc(4);
      head.writeUInt32LE(1_000_000, 0);
      b.write(head);
      b.write(Buffer.alloc(256, 0x41));
    });
    assertEqual(reason, 'oversize', 'oversize head drops the peer');
    await close();
  }

  // Zero-length frames are malformed, not delivered.
  {
    const { a, b, close } = await socketPair();
    const reason = await new Promise<string>((resolve) => {
      attachWirePump({
        socket: a,
        maxPayload: 1024,
        onFrame: () => assert(false, 'empty frame must not deliver'),
        onClose: resolve,
      });
      b.write(Buffer.alloc(4));
    });
    assertEqual(reason, 'oversize', 'zero-length head drops the peer');
    await close();
  }

  // upgrade() widens the cap — a frame over the old bound lands after it.
  {
    const { a, b, close } = await socketPair();
    const got: number[] = [];
    const pump = attachWirePump({
      socket: a,
      maxPayload: 64,
      onFrame: (f) => got.push(f.length),
      onClose: () => undefined,
    });
    pump.upgrade(4096);
    const payload = Buffer.alloc(512, 0x42);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(payload.length, 0);
    b.write(Buffer.concat([head, payload]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEqual(got.length, 1, 'upgraded cap admits the frame');
    assertEqual(got[0], 512);
    await close();
  }

  // Peer close and local close both settle the pump once.
  {
    const { a, b, close } = await socketPair();
    const closes: string[] = [];
    const pump: WirePump = attachWirePump({
      socket: a,
      maxPayload: 1024,
      onFrame: () => undefined,
      onClose: (r) => closes.push(r),
    });
    b.destroy();
    await new Promise((resolve) => setTimeout(resolve, 25));
    pump.close();
    assert(closes.length === 1 && closes[0] === 'peer', 'close settles once');
    assert(pump.closed, 'pump reports closed');
    await close();
  }
}
