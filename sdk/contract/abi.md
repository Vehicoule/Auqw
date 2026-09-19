# Plugin ABI v0

Version: `0.1.0`. Defines how the host runs a provider plugin guest.
Machine-readable message shapes: [messages.schema.json](messages.schema.json);
manifest shape: [manifest.schema.json](manifest.schema.json).

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
- **Any** import is a hard rejection. The allowlist is `auqw.*`, but v0
  defines no host imports: host services are requested via steps, not
  imports.

## Host → guest step messages (`handle` input)

- `{"type":"invoke","request_id":"<string>","capability":"playback.resolve","payload":{"source_ref":"<video_id>"}}` — always the first step.
- `{"type":"http_response","id":<u32>,"status":<u16>,"headers":[["name","value"],...],"body":"<base64>"}` — answer to a `host_request` with the same `id`.
- `{"type":"host_error","id":<u32>,"error":{"kind":"<ErrorKind>","message":"<string>"}}` — the host-side attempt at request `id` failed (denied destination or permission, no provider configured, timeout, transport error).

## Guest → host step messages (`handle` output)

- `{"type":"host_request","id":<u32>,"kind":"http_request","payload":{"method":"GET|POST","url":"<https url>","headers":[["name","value"],...],"body":"<base64 or null>"}}`
- `{"type":"host_request","id":<u32>,"kind":"pot_token","payload":{"content_binding":"<string>"}}` — asks the host to mint a PO token bound to `content_binding` against its configured provider (`POST {provider}/get_pot`, bgutil contract). Requires the `pot-provider` permission. Answered with the provider's `http_response` verbatim, or `host_error` `permission-denied` (permission not declared) / `unsupported` (no provider configured). The guest never learns the provider URL.
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
  "abi": "0.1.0",
  "capabilities": ["playback.resolve"],
  "permissions": ["network:www.youtube.com", "network:*.googlevideo.com", "pot-provider"],
  "artifact": { "path": "dist/youtube-music.wasm", "digest": "sha256:<hex>" }
}
```

Permission grammar: `network:<host>` exact match; `network:*.<domain>`
matches any single- or multi-level subdomain of `<domain>` (not the apex).
Only `https` destinations are allowed. `pot-provider` grants `pot_token`
host requests; the destination is host-configured, never guest-supplied,
so the `https`-only rule for guest `http_request` destinations is
unaffected. Redirects are never followed by the host HTTP client: a 3xx
reaches the guest as `http_response`, and a guest that wants the target
re-requests it through `host_request` (the allowlist applies again).

## Limits and failure behavior

- Artifact size ≤ 5 MiB; guest linear memory ≤ 64 MiB, tables ≤ 64 Ki
  elements, and one memory/instance per invocation (host-enforced).
- Guest response messages ≤ 1 MiB.
- Budgets (fuel per entry and total, max steps, max HTTP calls, byte
  in+out, per-request timeout, wall-clock deadline) are cumulative per
  invocation and never refilled. Exhaustion → `budget-exceeded`.
- Cancellation is checked before every guest entry and every host request;
  after cancellation the guest is never re-entered.
- A guest trap → `guest-trap`; malformed/out-of-contract bytes →
  `invalid-message`. Panics must never cross the ABI.
