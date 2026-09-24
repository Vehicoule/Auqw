#!/usr/bin/env node
/**
 * Real phone-side client for the auqw LAN sync wire protocol.
 * Speaks the actual protocol end-to-end against the REAL utility process:
 *   hello -> challenge -> HKDF/AES-GCM seal -> {t:'pair',code} -> welcome
 * then open-phase ping/devices/sync, then listens for pushes.
 *
 * Usage: node /tmp/sync-client.mjs <host> <port> <code|resume> <deviceId> [holdSecs]
 */
import {
  createCipheriv, createDecipheriv, diffieHellman,
  generateKeyPairSync, hkdfSync, createHash,
} from 'node:crypto';
import { connect } from 'node:net';

const [host, port, code, deviceId, holdSecs] = process.argv.slice(2);
const HOLD = (parseInt(holdSecs ?? '40', 10) || 40) * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!host || !port || !code || !deviceId) {
  console.error('usage: sync-client.mjs <host> <port> <code|resume> <deviceId> [holdSecs]');
  process.exit(2);
}

const b64 = (k) => k.export({ format: 'der', type: 'spki' }).toString('base64');
const pkcs8 = (k) => k.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const x25519 = (privB64, pubB64) => diffieHellman({
  privateKey: { key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' },
  publicKey: { key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' },
});

const dev = generateKeyPairSync('x25519');       // long-lived device key
const eph = generateKeyPairSync('x25519');       // session ephemeral
const devFp = createHash('sha256')
  .update(Buffer.from(b64(dev.publicKey), 'base64')).digest('hex');

const sock = connect({ host, port: Number(port) });
let buf = Buffer.alloc(0);
let codec = null;         // {sendKey,recvKey,seqS,seqR}
let phase = 'hello';
let timer = null;

const sendFrame = (payload) => {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  sock.write(Buffer.concat([head, payload]));
};

const seal = (obj) => {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64LE(codec.seqS, 4);
  codec.seqS += 1n;
  const c = createCipheriv('aes-256-gcm', codec.sendKey, iv);
  return Buffer.concat([iv, c.update(Buffer.from(JSON.stringify(obj), 'utf8')),
    c.final(), c.getAuthTag()]);
};

const openSealed = (frame) => {
  const iv = frame.subarray(0, 12);
  const tag = frame.subarray(frame.length - 16);
  const ct = frame.subarray(12, frame.length - 16);
  const d = createDecipheriv('aes-256-gcm', codec.recvKey, iv);
  d.setAuthTag(tag);
  codec.seqR += 1n;
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
};

const onFrame = (payload) => {
  if (phase === 'hello') {
    const ch = JSON.parse(payload.toString('utf8'));
    const serverFp = createHash('sha256')
      .update(Buffer.from(ch.spub, 'base64')).digest('hex');
    log('<- CHALLENGE kind=%s registered=%s serverFp=%s',
      ch.kind, ch.registered, serverFp.slice(0, 16) + '...');
    const dh1 = x25519(pkcs8(eph.privateKey), ch.eph);   // e_c x e_s
    const dh2 = x25519(pkcs8(dev.privateKey), ch.eph);   // dev_c x e_s
    const dh3 = x25519(pkcs8(eph.privateKey), ch.spub);  // e_c x S_desk
    const keys = Buffer.from(hkdfSync('sha256',
      Buffer.concat([dh1, dh2, dh3]),
      Buffer.from(ch.salt, 'base64'), 'auqw-sync-v1', 64));
    codec = { sendKey: keys.subarray(0, 32), recvKey: keys.subarray(32, 64), seqS: 0n, seqR: 0n };
    phase = 'open';
    const auth = code === 'resume' ? { t: 'resume' } : { t: 'pair', code };
    log('-> SEALED %s', JSON.stringify(auth));
    sendFrame(seal(auth));
    return;
  }
  let msg;
  try { msg = openSealed(payload); }
  catch (e) { log('<- sealed frame failed to open: %s', e.message); return; }
  log('<- SEALED %s', JSON.stringify(msg));
  if (msg.t === 'welcome') {
    log('   WELCOME device=%s name=%s pairedAt=%s',
      JSON.stringify(msg.device), msg.name, msg.device?.pairedAt);
    sendFrame(seal({ t: 'ping' }));
    sendFrame(seal({ t: 'devices' }));
    sendFrame(seal({ t: 'sync', since: '' }));
    log('-> sent sealed ping + devices + sync{since:""}; holding socket %ds for pushes...',
      HOLD / 1000);
    timer = setTimeout(() => { log('hold elapsed; closing'); sock.end(); }, HOLD);
  }
};

sock.on('connect', () => {
  log('-> connected %s:%s; sending HELLO deviceId=%s devFp=%s',
    host, port, deviceId, devFp.slice(0, 16) + '...');
  sendFrame(Buffer.from(JSON.stringify({
    v: 1, kind: 'hello', deviceId, name: 'DevinTestPhone',
    eph: b64(eph.publicKey), dev: b64(dev.publicKey),
  }), 'utf8'));
});
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const frame = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    onFrame(frame);
  }
});
sock.on('close', () => { log('<- socket CLOSED'); if (timer) clearTimeout(timer); process.exit(0); });
sock.on('error', (e) => log('socket error: %s', e.message));
