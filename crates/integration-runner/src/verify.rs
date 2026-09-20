//! Signed-release verification: digests, provenance cross-checks, and
//! the ed25519 signature over the canonical `auqw-release-v1` payload.
//! Mirrors `tooling/sign.mjs verify` in the plugins repo — the payload
//! construction there is the authority; this MUST stay byte-identical.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// PEM armoring for an ed25519 public key is SPKI DER: a fixed 12-byte
/// prefix over the 32-byte key. Verification needs the raw key bytes.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Debug)]
pub struct VerifyFailure(pub String);

impl std::fmt::Display for VerifyFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for VerifyFailure {}

fn bad<T>(msg: impl Into<String>) -> Result<T, VerifyFailure> {
    Err(VerifyFailure(msg.into()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Deserialize)]
struct Provenance {
    plugin: String,
    version: String,
    abi_version: String,
    wasm_sha256: String,
    manifest_sha256: String,
    key_id: String,
}

/// A verified release ready for host loading.
pub struct VerifiedRelease {
    pub plugin: String,
    pub version: String,
    pub wasm: Vec<u8>,
    pub manifest_json: String,
}

/// First 16 hex chars of the sha256 of the signer's SPKI DER public
/// key — the `key_id` convention shared with `sign.mjs`.
pub fn key_id_of_der(der: &[u8]) -> String {
    format!("{:x}", Sha256::digest(der))[..16].to_string()
}

/// Load a PEM public key (ed25519, SPKI) into raw key bytes + DER.
pub fn load_public_key(path: &Path) -> Result<(VerifyingKey, Vec<u8>), VerifyFailure> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| VerifyFailure(format!("pubkey {}: {e}", path.display())))?;
    let body: String = text
        .lines()
        .filter(|l| !l.starts_with("-----") && !l.trim().is_empty())
        .collect();
    let der = B64
        .decode(body.as_bytes())
        .map_err(|e| VerifyFailure(format!("pubkey {}: base64: {e}", path.display())))?;
    if der.len() != ED25519_SPKI_PREFIX.len() + 32 || !der.starts_with(&ED25519_SPKI_PREFIX) {
        return bad(format!(
            "pubkey {}: not an ed25519 SPKI key",
            path.display()
        ));
    }
    let raw: [u8; 32] = der[ED25519_SPKI_PREFIX.len()..]
        .try_into()
        .map_err(|_| VerifyFailure("pubkey: bad length".into()))?;
    let key = VerifyingKey::from_bytes(&raw).map_err(|e| VerifyFailure(format!("pubkey: {e}")))?;
    Ok((key, der))
}

/// Verify a `releases/<id>/<version>/` directory end to end.
/// `expected_key_id` pins the signer; `key` performs the ed25519 check.
pub fn verify_release(
    dir: &Path,
    key: &VerifyingKey,
    expected_key_id: &str,
) -> Result<VerifiedRelease, VerifyFailure> {
    let need = |name: &str| -> Result<Vec<u8>, VerifyFailure> {
        let path = dir.join(name);
        std::fs::read(&path).map_err(|e| VerifyFailure(format!("{}: {e}", path.display())))
    };
    let manifest_buf = need("plugin.manifest.json")?;
    let provenance_buf = need("provenance.json")?;
    let sig_buf = need("signature")?;

    let provenance: Provenance = serde_json::from_slice(&provenance_buf)
        .map_err(|e| VerifyFailure(format!("provenance.json: {e}")))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_buf)
        .map_err(|e| VerifyFailure(format!("plugin.manifest.json: {e}")))?;

    let wasm_name = format!("{}-{}.wasm", provenance.plugin, provenance.version);
    let wasm = need(&wasm_name)?;
    let wasm_count = wasm_files(dir)?.len();
    if wasm_count != 1 {
        return bad(format!(
            "{}: expected exactly one .wasm artifact, found {wasm_count}",
            dir.display()
        ));
    }

    let wasm_sha = sha256_hex(&wasm);
    if wasm_sha != provenance.wasm_sha256 {
        return bad(format!(
            "wasm digest drift: {wasm_sha} != provenance {}",
            provenance.wasm_sha256
        ));
    }
    let pinned = manifest
        .get("artifact")
        .and_then(|a| a.get("digest"))
        .and_then(|d| d.as_str())
        .unwrap_or("(missing)");
    if pinned != wasm_sha {
        return bad(format!(
            "manifest artifact.digest {pinned} != wasm {wasm_sha}"
        ));
    }
    let manifest_sha = sha256_hex(&manifest_buf);
    if manifest_sha != provenance.manifest_sha256 {
        return bad(format!(
            "manifest digest drift: {manifest_sha} != provenance {}",
            provenance.manifest_sha256
        ));
    }
    for (field, expected) in [
        ("id", provenance.plugin.as_str()),
        ("version", provenance.version.as_str()),
        ("abi", provenance.abi_version.as_str()),
    ] {
        let actual = manifest.get(field).and_then(|v| v.as_str()).unwrap_or("");
        if actual != expected {
            return bad(format!(
                "manifest.{field} {actual:?} != provenance {expected:?}"
            ));
        }
    }
    if provenance.key_id != expected_key_id {
        return bad(format!(
            "release signed by key {}; loaded key is {expected_key_id}",
            provenance.key_id
        ));
    }

    let payload = format!(
        "auqw-release-v1\n{}\n{}\n{}\n{}\n{}\n{}\n",
        provenance.plugin,
        provenance.version,
        provenance.abi_version,
        wasm_sha,
        manifest_sha,
        provenance.key_id
    );
    let sig_bytes = B64
        .decode(
            std::str::from_utf8(&sig_buf)
                .map_err(|e| VerifyFailure(format!("signature: utf8: {e}")))?
                .trim(),
        )
        .map_err(|e| VerifyFailure(format!("signature: base64: {e}")))?;
    let signature =
        Signature::from_slice(&sig_bytes).map_err(|e| VerifyFailure(format!("signature: {e}")))?;
    key.verify(payload.as_bytes(), &signature)
        .map_err(|e| VerifyFailure(format!("ed25519 signature does not verify: {e}")))?;

    Ok(VerifiedRelease {
        plugin: provenance.plugin,
        version: provenance.version,
        wasm,
        manifest_json: String::from_utf8_lossy(&manifest_buf).into_owned(),
    })
}

fn wasm_files(dir: &Path) -> Result<Vec<PathBuf>, VerifyFailure> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| VerifyFailure(format!("{}: {e}", dir.display())))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| VerifyFailure(format!("readdir: {e}")))?;
        if entry.path().extension().is_some_and(|ext| ext == "wasm") {
            files.push(entry.path());
        }
    }
    Ok(files)
}
