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
    /// ABI version the artifact was built against (`0.1.0`).
    pub abi: String,
    /// Capabilities the plugin declares.
    pub capabilities: Vec<String>,
    /// `network:` permissions; see the ABI contract for the grammar.
    #[serde(default)]
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

    /// Structural validation beyond the JSON shape.
    fn validate(&self) -> Result<(), ManifestError> {
        if self.id.is_empty() {
            return Err(ManifestError::InvalidField("id must not be empty".into()));
        }
        if self.capabilities.is_empty() {
            return Err(ManifestError::InvalidField(
                "capabilities must not be empty".into(),
            ));
        }
        for p in &self.permissions {
            if p == "pot-provider" {
                continue;
            }
            let rest = p
                .strip_prefix("network:")
                .ok_or_else(|| ManifestError::InvalidField(format!("bad permission {p:?}")))?;
            if rest.is_empty()
                || rest.contains('/')
                || rest == "*"
                || rest.starts_with("*.") && rest.len() <= 2
            {
                return Err(ManifestError::InvalidField(format!(
                    "bad network permission {p:?}"
                )));
            }
        }
        if !self.artifact.digest.starts_with("sha256:") {
            return Err(ManifestError::InvalidField(
                "artifact.digest must be sha256:<hex>".into(),
            ));
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
