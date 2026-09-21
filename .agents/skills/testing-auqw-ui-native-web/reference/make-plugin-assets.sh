#!/usr/bin/env bash
# Generates placeholder plugin wasm + manifest assets in
# apps/mobile/assets/plugins/ so the static require() calls resolve.
# Manifests carry the real ABI shape (id/name/abi/capabilities/
# permissions/artifact per sdk/contract/abi.md) — the fake host ignores
# content, but keeping the contract fields means manifestCapabilities()
# filtering exercises the real code path.
set -euo pipefail
mkdir -p "$(dirname "$0")/../../../../apps/mobile/assets/plugins"
cd "$(dirname "$0")/../../../../apps/mobile/assets/plugins"

mk() {
  local id="$1"; shift
  # 8-byte wasm magic + version; content is never executed.
  printf '\x00asm\x01\x00\x00\x00' > "$id.wasm"
  cat > "$id.manifest.json" <<EOF
{
  "id": "$id",
  "name": "$id (harness stub)",
  "abi": "0.3.0",
  "capabilities": $(echo "$@" | tr ' ' '\n' | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/;s/$/]/'),
  "permissions": [],
  "artifact": { "path": "$id.wasm", "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
}
EOF
}

mk itunes catalog.search catalog.metadata catalog.entity catalog.artwork
mk youtube-music catalog.search catalog.metadata catalog.entity playback.resolve playback.candidates
mk deezer catalog.search catalog.metadata catalog.entity
mk lyrics-lrclib lyrics.plain lyrics.synced
