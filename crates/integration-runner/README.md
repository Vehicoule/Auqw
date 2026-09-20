# integration-runner

Headless plugin pipeline — [plugin-system.md §7]. Per signed release:

1. **verify** — wasm + manifest sha256 vs `provenance.json`, manifest
   `artifact.digest` pin, provenance↔manifest id/version/abi agreement,
   `key_id` pin, ed25519 signature over the `auqw-release-v1` canonical
   payload (byte-identical to `tooling/sign.mjs` in auqw-plugins).
2. **load** — the production host's own manifest/artifact validation
   (zero imports, exports, budgets).
3. **journeys** — each declared capability driven through the real step
   loop; the only scripted piece is the network (`HttpClient` serves
   canned upstream responses from the plugins repo's committed
   fixtures).

```sh
cargo run -p auqw-integration-runner -- \
  --pubkey <release-pubkey.pem> \
  --release ../auqw-plugins/releases/<id>/<version> [--release ...] \
  --journeys ../auqw-plugins/tooling/journeys
```

Exit 0 only when every release verifies and every journey passes.
Journeys naming a plugin with no `--release` fail the run — a suite
cannot silently shrink.

## Journey spec (`*.journey.json` — actually `*.json` in the journeys dir)

```json
{
  "name": "itunes catalog.search — mixed results",
  "plugin": "itunes",
  "capability": "catalog.search",
  "request": { "query": "portishead", "limit": 10, "storefront": null },
  "upstreams": [
    {
      "url_contains": "itunes.apple.com/search",
      "status": 200,
      "headers": { "content-type": "application/json" },
      "body_file": "../../plugins/itunes/fixtures/search-mixed.json"
    }
  ],
  "expect": {
    "result": "ok",
    "result_subset": { "tracks": [{ "title": "Roads" }] },
    "max_http_calls": 1
  }
}
```

- `request` is the verbatim capability payload handed to `invoke()`.
- `upstreams`: first `url_contains` match wins; an unmatched outbound
  request fails the guest call and is reported as an uncanned upstream.
- `body_file` resolves relative to the journey file's directory —
  journeys live in `auqw-plugins/tooling/journeys/` so fixture paths
  stay inside that repo's checkouts and worktrees.
- `expect.result`: `"ok"` or an error-kind substring matched against
  the typed `InvokeError` (e.g. `"rate-limit"`).
- `result_subset`: recursive object subset — every expected key must be
  present and equal; arrays subset-match element-wise over the expected
  length.
- `max_http_calls`: caps upstream calls (retry-storm detector).

Determinism: canned upstreams, `NullKv`, `SystemClock`; guests run under
`Budgets::default()`. The runner never reaches the network itself.
