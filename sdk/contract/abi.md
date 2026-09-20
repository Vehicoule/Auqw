# Plugin ABI v0

Version: `0.2.0`; the host also loads `0.1.0` manifests (the `0.1.0`
message set is a strict subset). Defines how the host runs a provider
plugin guest. Machine-readable message shapes:
[messages.schema.json](messages.schema.json);
manifest shape: [manifest.schema.json](manifest.schema.json);
capability payload/result shapes:
[capabilities.schema.json](capabilities.schema.json).

## Execution model

- One **fresh** Wasmi instance per invocation; instances are never reused
  across invocations.
- Guest state persists in its linear memory between **steps** of the same
  invocation. The host re-enters `handle` once per step.
- All messages are **UTF-8 JSON**.

## Module requirements

Required guest exports (checked at load, hard rejection if absent or
mis-typed):

| Export | Signature | Meaning |
| --- | --- | --- |
| `memory` | `memory` | Guest linear memory |
| `alloc` | `(len: u32) -> u32` | Returns a pointer to a guest-owned buffer of `len` bytes that the host writes the next step message into before calling `handle` |
| `handle` | `(ptr: u32, len: u32) -> u64` | Consumes the step message at `ptr`/`len`; returns `(ptr << 32) \| len` of a guest-owned response buffer valid until the next `handle`/`alloc` call |

Rejection rules (v0):

- A `start` section is a hard rejection.
- **Any** import is a hard rejection. Host services are requested via
  typed `host_request` step kinds, never imports.

## Host → guest step messages (`handle` input)

- `{"type":"invoke","request_id":"<string>","capability":"playback.resolve","payload":{"source_ref":"<video_id>"}}` — always the first step.
- `{"type":"http_response","id":<u32>,"status":<u16>,"headers":[["name","value"],...],"body":"<base64>"}` — answer to a `host_request` with the same `id`.
- `{"type":"host_error","id":<u32>,"error":{"kind":"<ErrorKind>","message":"<string>"}}` — the host-side attempt at request `id` failed (denied destination or permission, no provider configured, kv limit hit, timeout, transport error).
- `{"type":"kv_response","id":<u32>,"value":"<base64 or null>"}` — answer to `kv_get`; `null` when the key is absent.
- `{"type":"host_ok","id":<u32>}` — ack of a `kv_set` or `log` request.
- `{"type":"now_response","id":<u32>,"now_ms":<u64>}` — answer to `now_ms`; host wall-clock epoch milliseconds.

## Guest → host step messages (`handle` output)

- `{"type":"host_request","id":<u32>,"kind":"http_request","payload":{"method":"GET|POST","url":"<https url>","headers":[["name","value"],...],"body":"<base64 or null>"}}`
- `{"type":"host_request","id":<u32>,"kind":"pot_token","payload":{"content_binding":"<string>"}}` — asks the host to mint a PO token bound to `content_binding` against its configured provider (`POST {provider}/get_pot`, bgutil contract). Requires the `pot-provider` permission. Answered with the provider's `http_response` verbatim, or `host_error` `permission-denied` (permission not declared) / `unsupported` (no provider configured). The guest never learns the provider URL.
- `{"type":"host_request","id":<u32>,"kind":"kv_get","payload":{"key":"<string>"}}` — reads this plugin's KV namespace. Requires the `kv` permission. Answered `kv_response` (base64 value, or `null` when absent), or `host_error` `permission-denied`.
- `{"type":"host_request","id":<u32>,"kind":"kv_set","payload":{"key":"<string>","value":"<base64 or null>"}}` — stages a write into this plugin's KV namespace; `null` deletes. Requires the `kv` permission. Answered `host_ok`, or `host_error` `permission-denied` / `invalid-response` (a size cap would be exceeded; nothing is staged).
- `{"type":"host_request","id":<u32>,"kind":"log","payload":{"level":"debug|info|warn|error","message":"<string>"}}` — appends a redacted entry to the invocation's diagnostics. No permission needed. Answered `host_ok`.
- `{"type":"host_request","id":<u32>,"kind":"now_ms","payload":{}}` — host wall-clock epoch milliseconds. No permission needed. Answered `now_response`.

KV semantics: writes are staged per invocation with read-your-writes
visibility. On a valid `done`, the staged patch applies atomically
against the current committed namespace — disjoint writes staged by
concurrent invocations both survive; last committer wins only for the
same key. `fail`, cancellation, deadline, trap, or malformed output
discards the staged changes; a delivered `host_error` does not — the
guest may recover and still finish `done`. Keys are nonempty and ≤128
UTF-8 bytes; decoded values ≤64 KiB; a plugin's committed namespace
totals ≤256 KiB — the store re-enforces all three at commit time. The
store is namespaced per plugin id; no cross-plugin reads.
- `{"type":"done","result":<capability result>}` — `result` is required
  (a missing key is `invalid-message`; an explicit `null` is valid).
  For `playback.resolve`:
  `{"url":"<string>","mime":"<string>","bitrate_kbps":<u32|null>,"expires_at_ms":<u64|null>,"content_length":<u64|null, optional>,"client":"<ladder rung name>"}`
  (`content_length` is the full byte length of the stream when the
  provider reports it, so hosts can range-download and verify
  completion.) When a result carries `url`, the host validates it
  before returning it: https scheme plus a `network:` destination the
  manifest permits — a violation ends the invocation `invalid-message`.
- `{"type":"fail","error":{"kind":"<ErrorKind>","message":"<string>"}}` —
  `kind` must be one of the guest-visible kinds below; anything else
  ends the invocation `invalid-message`. `message` is guest-controlled
  text and reaches callers only in URL-redacted form.

## Capability payloads and results

Canonical wire types live in
[capabilities.schema.json](capabilities.schema.json) — the schema is
the contract; the table is orientation only.

| Capability | Payload | Result |
| --- | --- | --- |
| `catalog.search` | `catalogSearchPayload` | `catalogSearchResult` |
| `catalog.metadata` | `catalogMetadataPayload` | `catalogMetadataResult` |
| `catalog.artwork` | `catalogArtworkPayload` | `catalogArtworkResult` |
| `playback.candidates` | `playbackCandidatesPayload` | `playbackCandidatesResult` |
| `playback.resolve` | `playbackResolvePayload` | `playbackResolveResult` |

Shared types: `sourceRef` (`{provider, kind:"track", id}`),
`artworkRef`, `trackMetadata`, `recordingQuery`. Plugins return raw
provider metadata as `trackMetadata` — deriving version labels
("(Live)", "(Remastered)", …) and candidate scoring is the
application's job, not the plugin's. `playback.resolve` also accepts a
bare string `source_ref`, the ABI 0.1/`startResolve` compatibility
shape.

## ErrorKind

Guest-visible taxonomy (kebab-case): `no-result`, `not-applicable`,
`unsupported`, `auth-required`, `auth-expired`, `rate-limit`, `transient`,
`expired-resource`, `permission-denied`, `invalid-response`, `timeout`,
`cancelled`.

Host-only kinds (produced by the host itself, never sent to the guest):
`budget-exceeded`, `guest-trap`, `invalid-message`, `artifact-rejected`.
A guest that receives off-contract bytes from the host — unparseable
step input, a response id that matches no outstanding request — fails
`invalid-response`; the host-only kinds are not a guest vocabulary.

## Manifest v0

`plugins/<id>/manifest.json`:

```json
{
  "id": "youtube-music",
  "version": "0.1.0",
  "abi": "0.2.0",
  "capabilities": ["playback.resolve"],
  "permissions": ["network:www.youtube.com", "network:*.googlevideo.com", "pot-provider", "kv"],
  "artifact": { "path": "dist/youtube-music.wasm", "digest": "sha256:<hex>" }
}
```

`abi` is `0.1.0` or `0.2.0` — any other value is rejected.
`0.1.0` is a strict immutable subset: it may declare only
`playback.resolve` and may not declare the `kv` permission, and a
guest running under a `0.1.0` manifest that emits the 0.2-only
`host_request` kinds (`kv_get`, `kv_set`, `log`, `now_ms`) fails
`invalid-message`. `0.2.0` accepts `catalog.search`,
`catalog.metadata`, `catalog.artwork`, `playback.resolve`, and
`playback.candidates`.

Permission grammar: `network:<host>` exact match; `network:*.<domain>`
matches any single- or multi-level subdomain of `<domain>` (not the apex).
Only `https` destinations are allowed. `pot-provider` grants `pot_token`
host requests; the destination is host-configured, never guest-supplied,
so the `https`-only rule for guest `http_request` destinations is
unaffected. `kv` grants `kv_get`/`kv_set` host requests against the
plugin's own namespace; `log` and `now_ms` need no permission. Redirects are never followed by the host HTTP client: a 3xx
reaches the guest as `http_response`, and a guest that wants the target
re-requests it through `host_request` (the allowlist applies again).

## Limits and failure behavior

- Artifact size ≤ 5 MiB; guest linear memory ≤ 64 MiB, tables ≤ 64 Ki
  elements, and one memory/instance per invocation (host-enforced).
- Guest response messages ≤ 1 MiB.
- KV keys ≤128 UTF-8 bytes, decoded values ≤64 KiB, committed
  namespace ≤256 KiB; log entries ≤128 per invocation and each message
  ≤4096 UTF-8 bytes.
- `kv_get`/`kv_set`/`log`/`now_ms` consume step count but not the HTTP
  call or byte counters.
- Budgets (fuel per entry and total, max steps, max HTTP calls, byte
  in+out, per-request timeout, wall-clock deadline) are cumulative per
  invocation and never refilled. Exhaustion → `budget-exceeded`.
- Cancellation is checked before every guest entry and every host request;
  after cancellation the guest is never re-entered.
- A guest trap → `guest-trap`; malformed/out-of-contract bytes →
  `invalid-message`. Panics must never cross the ABI.
