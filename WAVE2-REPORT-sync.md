# Wave-2 report: unify the sync protocol — one noise-v1 over injected primitives

Branch: `devin/w2-sync-protocol`. The two drifted `noise-v1`
implementations are replaced by one shared suite in
`@auqw/application` parameterized by `NoisePrimitives`; each platform
keeps only a thin primitive adapter. Wire format is unchanged.

## What moved where

### Created

| File | Role |
| --- | --- |
| `packages/application/src/sync/noise.ts` (543 LoC) | The whole protocol: raw↔DER key helpers (`noiseSpkiB64`/`noisePkcs8B64`/`noiseRawPublic`/`noiseRawPrivate`), `fingerprintOf` (SHA-256 hex of SPKI DER), `isUsableIdentity`, `createIdentity`, `isClientHello` (strict shipped bounds), `clientCrypto`, `responderCrypto`, and `createNoiseCodec` — `iv‖ct‖tag16` frames, `4×0‖u64le(seq)` nonces. `createNoiseSuite` binds a `NoisePrimitives` into the lot. |
| `packages/application/src/sync/custody.ts` (277 LoC) | One custody union `SyncPeerRecord = SyncPeer(role:'responder') \| SyncCallerPeer(role:'caller')`, strict guards for writes, loose readers for legacy rows (`readSyncPeerRecord`, `readSyncPeer`, `readSyncCallerPeer`). |
| `packages/application/src/testing/noise-test-peer.ts` (62 LoC) | Test-only scripted peer — drives the real `clientCrypto` path against a responder transcript. |
| `packages/application/src/sync/custody.test.ts`, `packages/application/src/sync/noise.test.ts` | Legacy-shape load tests + fake-primitive coverage of transcript order, codec sequence checks, and error kinds. |
| `apps/desktop/src/utility/noise-node.ts` (144 LoC) | Desktop adapter: `nodeNoisePrimitives()` on `node:crypto` (`generateKeyPairSync`/`diffieHellman` on DER-wrapped X25519 keys, `hkdfSync`, `createCipheriv`, `randomBytes`); exports `nodeNoise` suite. |
| `apps/desktop/src/utility/noise-node.test.ts` | Desktop coverage: identity/hello guards, codec round-trip + tag rejection, cross-backend interop, golden vectors. |

### Deleted

| File | Disposition |
| --- | --- |
| `apps/desktop/src/utility/sync-crypto.ts` (534 LoC) | All logic subsumed by `sync/noise.ts` + `noise-node.ts`. `createTestPeer` removed from production entirely; tests use `createNoiseTestPeer` (a thin local shim keeps ~30 call sites readable in `sync-server.test.ts`). |
| `apps/desktop/src/utility/sync-crypto.test.ts` (165 LoC) | Coverage re-expressed on the shared suite in `noise-node.test.ts`. |
| `apps/desktop/src/utility/sync-wire.ts` (165 LoC) | `attachWirePump` deleted; its semantics live in the shared `attachSyncPump`. `net.Socket` satisfies the `SyncSocket` seam structurally, so no bytes adapter was needed. |

### Rewired

- `apps/desktop/src/utility/sync-server.ts` — responder crypto defaults
  to `nodeNoise.responderCrypto(identity)`; hello checks via
  `nodeNoise.isClientHello`; pump seam defaults to `attachSyncPump`.
- `apps/desktop/src/utility/sync-dialer.ts` — `nodeNoise.clientCrypto`
  for hello/handshake; custody writes emit `role:'caller'` rows.
- `apps/desktop/src/utility/sync-engine.ts` — `createUtilitySyncEngine`
  now composes the shared `createSyncEnginePort` (which gained the
  byte-refit loop) + `localChanges`; ~90 LoC of duplicated adapter
  removed.
- `apps/desktop/src/main/sync-keys.ts` — every read path normalizes
  through `readSyncCallerPeer` so untagged stored rows load and re-write
  tagged.
- `apps/mobile/src/adapters/noble-sync-crypto.ts` — 421 → 118 LoC thin
  adapter: `nobleNoisePrimitives()` over `@noble/curves` x25519,
  `@noble/hashes` hkdf/sha256, `@noble/ciphers` gcm (same primitive
  choices it already shipped; no WebCrypto change). Export surface
  preserved (`createNobleIdentity`, `createNobleSyncCrypto`,
  `createNobleSyncResponder`, `nobleFingerprintOf`, base64 helpers).
- `apps/mobile/src/adapters/secure-sync-keys.ts` — reads normalize via
  `readSyncPeer`; all merge/write paths emit tagged records.
- `apps/mobile/src/adapters/sync-peer-registry.ts` — host rows write
  `role:'caller'`, dial-book rows `role:'responder'`.
- `packages/application/src/sync/engine-port.ts` — now owns the
  `MAX_SYNC_DOC_BYTES` refit (halve the entry page until the serialized
  doc fits) and keeps the desktop's `invalid-response` cursor kind.
- `packages/application/src/sync/sync-host.ts`,
  `ports/sync-transport.ts`, `sync-client.ts`, ui-shared fixtures —
  `SyncPeer` moved to custody.ts, `SyncHostPeer`/`SyncDeviceRecord`
  become `SyncCallerPeer` aliases, literals carry `role`.

## Wire-format proof

Fixed scripted transcript (deterministic prims) → identical bytes under
both backends, asserted in `noise-node.test.ts`:

```text
C2S (pair payload, 44 bytes ct‖tag):
0000000000000000000000009f78999f58327c2e1db52b61cb744198
b8196cffb3fe4525e78d4f3e8032730c6ee2b4f438318d7d9b6bffed

S2C (ack, 28 bytes ct‖tag):
0000000000000000000000006173db32b8b4028ed306aa83ea857d09
6227b47a6de85621c407c17ec46aa0
```

Cross-direction opens verified: noble responder ↔ node client and node
responder ↔ noble client each open the other's sealed frames; tampered
tag fails decrypt on both. `phone-sync-e2e.test.ts` runs the real
responder/dialer over loopback TCP unchanged. Unchanged invariants:
hello/challenge JSON shapes, 3×DH ordering `dh(e,e)‖dh(devC,eS)‖dh(eC,S_desk)`,
HKDF info `'auqw-sync-v1'`, `kC2S‖kS2C` split, `4×0‖u64le` nonces,
u32le length prefix, 16 KiB handshake cap, 1 MiB doc cap.

## Divergence found between the old impls

One real behavioral divergence: on `open()`, the **noble** codec
validated only the low 8 bytes of the frame nonce (the sequence); the
**desktop** codec compared all 12 bytes, rejecting any nonzero prefix.
Desktop is canonical (it also originated the format), so the shared
codec does the full 12-byte compare — a peer emitting nonzero prefix
bytes would now fail on mobile exactly as it already did on desktop.
Everything else (transcript order, info string, JSON shapes, caps,
fp↔pub binding, salt-nonzero check) matched bit-for-bit.

Secondary (non-wire) divergence: mobile's `isSyncPeerRecord` reader was
looser than desktop's `isSyncDeviceRecord` (unbounded strings, plain
`typeof number` timestamps, `''`-valued optionals, extra keys). The
unified readers adopt the looser shipped bounds on reads so no stored
row on a fielded device orphans, while writes emit the strict tagged
shape.

## Custody migration

- `SyncPeerRecord` union with `role` discriminator; writes emit tagged
  rows on both platforms.
- Legacy untagged rows load by shape sniff: `id`/`pub` → caller
  (registry) row; `endpoints`/`peerCursor` → responder (dial-book) row.
- `custody.test.ts` loads both legacy shapes verbatim plus tagged rows;
  `main/sync-keys.test.ts` writes untagged fixtures to disk and asserts
  they read back normalized.
- Desktop keeps the `fp === fingerprintOf(pub)` binding on caller rows.
- New writes go through the strict guards (`isSyncCallerPeer`/
  `isSyncPeer`), which enforce `hasKeys` exact-key membership — tagged
  rows reject extras.

## Engine port

`createSyncEnginePort` is the single adapter; it now performs the
byte-refit the desktop bespoke version carried (start at a 10k-entry
page, halve until `JSON.stringify` fits `MAX_SYNC_DOC_BYTES`, error
`invalid-response` if a single entry exceeds the wire bound). `more`
stays honest — the engine evaluates it against the applied limit.
Malformed `since` cursors keep the shipped `invalid-response` kind (the
wire echoes it to the peer).

## Diffstat

```text
28 files changed, 362 insertions(+), 1555 deletions(-)
  sync-crypto.ts −534 · sync-wire.ts −165 · sync-crypto.test.ts −165
  noble-sync-crypto.ts 427→118 (thin adapter)
```

plus new shared modules: `noise.ts` +543, `custody.ts` +277,
`noise-node.ts` +144, `noise-test-peer.ts` +62, tests ~+550.

## Evidence

- `pnpm install --frozen-lockfile` — clean.
- `pnpm -C packages/application typecheck && test` — pass.
- `pnpm -C apps/desktop typecheck && test` — pass (`desktop shell tests
  passed`, includes golden-vector + phone-sync-e2e legs).
- `pnpm -C apps/mobile typecheck && test` — pass (`mobile shell tests
  passed`, includes `noble-sync-responder` interop).
- `pnpm -C packages/ui-shared typecheck && test` — pass.
- Node `v24.19.0` on PATH for all gates.
