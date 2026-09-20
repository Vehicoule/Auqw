//! Plugin manifest parsing and network-permission matching.

use serde::Deserialize;

use crate::error::ManifestError;

/// A parsed and structurally validated `manifest.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// Plugin identifier, e.g. `youtube-music`.
    pub id: String,
    /// Plugin semver version.
    pub version: String,
    /// ABI version the artifact was built against (`0.1.0` or `0.2.0`).
    pub abi: String,
    /// Capabilities the plugin declares.
    pub capabilities: Vec<String>,
    /// `network:` / `pot-provider` / `kv` permissions; see the ABI
    /// contract for the grammar. Required by the schema — an explicit
    /// empty array.
    pub permissions: Vec<String>,
    /// Artifact reference (path + pinned digest).
    pub artifact: ArtifactRef,
}

/// The plugin artifact reference inside a manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    /// Path to the `.wasm` artifact relative to the manifest.
    pub path: String,
    /// `sha256:<hex>` digest of the artifact bytes.
    pub digest: String,
}

impl Manifest {
    /// Parse and validate a manifest from its JSON text.
    ///
    /// # Errors
    /// Returns [`ManifestError`] for malformed JSON or missing/invalid
    /// required fields.
    pub fn from_json(text: &str) -> Result<Self, ManifestError> {
        let manifest: Manifest =
            serde_json::from_str(text).map_err(|e| ManifestError::InvalidJson(e.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Structural validation beyond the JSON shape. Mirrors
    /// `sdk/contract/manifest.schema.json` — the schema is the contract;
    /// this validator must not accept what it rejects.
    fn validate(&self) -> Result<(), ManifestError> {
        let bad = |m: &str| ManifestError::InvalidField(m.to_string());
        // ^[a-z0-9][a-z0-9-]*$
        let mut chars = self.id.chars();
        match chars.next() {
            Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
            _ => return Err(bad("id must match [a-z0-9][a-z0-9-]*")),
        }
        if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(bad("id must match [a-z0-9][a-z0-9-]*"));
        }
        // ^[0-9]+\.[0-9]+\.[0-9]+$
        let version_ok = self.version.split('.').collect::<Vec<_>>().len() == 3
            && self
                .version
                .split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        if !version_ok {
            return Err(bad("version must be semver x.y.z"));
        }
        if self.capabilities.is_empty() {
            return Err(ManifestError::InvalidField(
                "capabilities must not be empty".into(),
            ));
        }
        // The schema enumerates the capabilities the host serves;
        // `0.1.0` manifests may only declare `playback.resolve`.
        const CAPS_0_1: &[&str] = &["playback.resolve"];
        const CAPS_0_2: &[&str] = &[
            "catalog.search",
            "catalog.metadata",
            "catalog.artwork",
            "playback.resolve",
            "playback.candidates",
        ];
        let allowed = match self.abi.as_str() {
            "0.1.0" => CAPS_0_1,
            "0.2.0" => CAPS_0_2,
            _ => return Err(bad("abi must be \"0.1.0\" or \"0.2.0\"")),
        };
        if self
            .capabilities
            .iter()
            .any(|c| !allowed.contains(&c.as_str()))
        {
            return Err(bad("capabilities outside the set this ABI serves"));
        }
        for p in &self.permissions {
            if p == "pot-provider" {
                continue;
            }
            if p == "kv" {
                // `kv` is a 0.2 permission — a 0.1 manifest is a strict
                // immutable subset and cannot grow permissions.
                if self.abi == "0.1.0" {
                    return Err(bad("permission \"kv\" requires abi \"0.2.0\""));
                }
                continue;
            }
            let rest = p
                .strip_prefix("network:")
                .ok_or_else(|| ManifestError::InvalidField(format!("bad permission {p:?}")))?;
            // ^(\*\.)?[a-z0-9.-]+$ — and a wildcard needs a real domain.
            let body = rest.strip_prefix("*.").unwrap_or(rest);
            if body.is_empty()
                || !body
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
            {
                return Err(ManifestError::InvalidField(format!(
                    "bad network permission {p:?}"
                )));
            }
        }
        if self.artifact.path.is_empty() {
            return Err(bad("artifact.path must not be empty"));
        }
        // ^sha256:[0-9a-f]{64}$
        let digest_ok = self
            .artifact
            .digest
            .strip_prefix("sha256:")
            .is_some_and(|h| {
                h.len() == 64
                    && h.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            });
        if !digest_ok {
            return Err(bad("artifact.digest must be sha256:<64 lowercase hex>"));
        }
        Ok(())
    }

    /// Whether `url` is a permitted destination: `https` scheme and a host
    /// covered by some `network:` permission.
    #[must_use]
    pub fn allows_destination(&self, url: &str) -> bool {
        let Some(host) = https_host(url) else {
            return false;
        };
        let host = host.to_ascii_lowercase();
        self.permissions.iter().any(|p| host_allowed(p, &host))
    }

    /// Whether the manifest declares the `pot-provider` permission,
    /// allowing `pot_token` host requests against the host-configured
    /// provider endpoint.
    #[must_use]
    pub fn allows_pot_provider(&self) -> bool {
        self.permissions.iter().any(|p| p == "pot-provider")
    }

    /// Whether the manifest declares the `kv` permission, allowing
    /// `kv_get`/`kv_set` host requests against this plugin's namespace.
    #[must_use]
    pub fn allows_kv(&self) -> bool {
        self.permissions.iter().any(|p| p == "kv")
    }
}

/// Extract the lowercase host of an `https://` URL, stripping any port.
/// Returns `None` for other schemes or unparseable input.
fn https_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') || authority.contains('[') {
        return None;
    }
    let host = authority.split(':').next()?;
    if host.is_empty() {
        return None;
    }
    Some(host)
}

/// Match one `network:` permission against a request host.
fn host_allowed(permission: &str, host: &str) -> bool {
    let Some(pattern) = permission.strip_prefix("network:") else {
        return false;
    };
    match pattern.strip_prefix("*.") {
        Some(domain) => {
            // Any single- or multi-level subdomain of `domain`, not the apex.
            host.len() > domain.len()
                && host.ends_with(domain)
                && host.as_bytes()[host.len() - domain.len() - 1] == b'.'
        }
        None => host == pattern,
    }
}
