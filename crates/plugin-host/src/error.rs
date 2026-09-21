//! Typed errors for artifact loading and invocation.

use thiserror::Error;

use crate::budgets::BudgetDimension;

/// Errors produced while parsing `manifest.json`.
#[derive(Debug, Error)]
pub enum ManifestError {
    /// The manifest is not valid JSON for the manifest shape.
    #[error("invalid manifest JSON: {0}")]
    InvalidJson(String),
    /// A required field is missing or violates the grammar.
    #[error("invalid manifest field: {0}")]
    InvalidField(String),
}

/// Errors produced when loading a plugin artifact.
#[derive(Debug, Error)]
pub enum LoadError {
    /// The manifest could not be parsed or validated.
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    /// The artifact is larger than `Budgets::max_artifact_bytes`.
    #[error("artifact too large: {actual} bytes (max {max})")]
    ArtifactTooLarge {
        /// Configured maximum.
        max: usize,
        /// Actual artifact size.
        actual: usize,
    },
    /// The manifest pins a different ABI version than this host implements.
    #[error("ABI mismatch: manifest pins {manifest}, host implements {host}")]
    AbiMismatch {
        /// ABI version in the manifest.
        manifest: String,
        /// ABI version implemented by the host.
        host: &'static str,
    },
    /// The artifact's sha256 does not match `manifest.artifact.digest`.
    #[error("artifact digest mismatch: expected {expected}, got {actual}")]
    DigestMismatch {
        /// Digest pinned in the manifest.
        expected: String,
        /// Computed digest.
        actual: String,
    },
    /// The module declares imports; ABI v0 allows none.
    #[error("module declares {count} import(s); ABI v0 allows none")]
    ImportsDeclared {
        /// Number of declared imports.
        count: usize,
    },
    /// The module contains a start section.
    #[error("module has a start section")]
    StartSection,
    /// A required export is missing or has the wrong signature.
    #[error("export {name} is missing or has the wrong signature")]
    BadExport {
        /// Export name.
        name: &'static str,
    },
    /// The module's declared memories/tables exceed what the store
    /// limits permit — it could never instantiate.
    #[error("module exceeds host limits: {0}")]
    ExceedsLimits(String),
    /// The artifact is not a valid WebAssembly module.
    #[error("invalid wasm module: {0}")]
    Malformed(String),
}

/// The `fail.error.kind` vocabulary a guest may emit — mirrors the
/// `errorKind` enum in `messages.schema.json`. The host-only kinds
/// (`budget-exceeded`, `guest-trap`, `invalid-message`,
/// `artifact-rejected`) are produced by the host itself and must never
/// appear in a guest `fail`.
pub(crate) const GUEST_FAIL_KINDS: &[&str] = &[
    "no-result",
    "not-applicable",
    "unsupported",
    "auth-required",
    "auth-expired",
    "rate-limit",
    "transient",
    "expired-resource",
    "permission-denied",
    "invalid-response",
    "timeout",
    "cancelled",
];

/// Classification of an [`HttpClient`] failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpErrorKind {
    /// The request exceeded its per-call timeout.
    Timeout,
    /// Transport or upstream failure; retrying may help.
    Transient,
    /// The invocation was cancelled while the request was in flight.
    Cancelled,
    /// The response body exceeded the remaining byte budget.
    BodyTooLarge,
    /// The request could not be constructed (invalid method/headers/URL).
    InvalidRequest,
}

impl HttpErrorKind {
    /// The ABI error kind sent back to the guest as `host_error`, if the
    /// invocation continues. `Cancelled` and `BodyTooLarge` end the
    /// invocation instead.
    pub fn guest_kind(self) -> Option<&'static str> {
        match self {
            Self::Timeout => Some("timeout"),
            Self::Transient => Some("transient"),
            Self::InvalidRequest => Some("invalid-response"),
            Self::Cancelled | Self::BodyTooLarge => None,
        }
    }
}

/// A failure from an [`crate::HttpClient`] implementation.
#[derive(Debug, Error)]
#[error("{kind:?}: {message}")]
pub struct HttpError {
    /// Failure classification.
    pub kind: HttpErrorKind,
    /// Human-readable detail; must not contain secrets or signed URLs.
    pub message: String,
    /// Response body bytes received before the failure. A mid-stream
    /// error does not refund the transfer that already happened — the
    /// invocation's byte budget still owns them.
    pub bytes_received: u64,
}

/// A failure of the KV backend. No raw `std::io::Error` detail crosses
/// the public boundary.
#[derive(Debug, Error)]
pub enum KvError {
    /// Storage I/O failed (read, write, sync, or rename).
    #[error("kv io: {0}")]
    Io(String),
    /// The on-disk store is malformed or violates the size caps. It is
    /// never silently reset.
    #[error("kv store corrupt: {0}")]
    Corrupt(String),
    /// A commit would push the namespace past its size caps; nothing
    /// was written.
    #[error("kv limit: {0}")]
    TooLarge(String),
}

/// Errors produced while running an invocation.
#[derive(Debug, Error)]
pub enum InvokeError {
    /// The capability is not declared by the plugin manifest.
    #[error("capability not declared by manifest: {0}")]
    CapabilityNotDeclared(String),
    /// The invocation was cancelled; the guest was not re-entered.
    #[error("cancelled")]
    Cancelled,
    /// A cumulative budget was exhausted.
    #[error("budget exceeded: {dimension}")]
    BudgetExceeded {
        /// Which budget ran out.
        dimension: BudgetDimension,
    },
    /// The guest trapped during `alloc`, `handle`, or instantiation.
    #[error("guest trap: {0}")]
    GuestTrap(String),
    /// The guest produced bytes that violate the ABI contract.
    #[error("invalid guest message: {0}")]
    InvalidMessage(String),
    /// A host-side service (the KV store) failed mid-invocation.
    #[error("host service: {0}")]
    HostService(String),
    /// The guest completed with a `fail` message.
    #[error("guest failure ({kind}): {message}")]
    GuestFail {
        /// ABI error kind reported by the guest.
        kind: String,
        /// Guest-provided detail.
        message: String,
    },
}

impl InvokeError {
    /// The ABI error-kind string for this error.
    #[must_use]
    pub fn kind(&self) -> &str {
        match self {
            Self::CapabilityNotDeclared(_) => "not-applicable",
            Self::Cancelled => "cancelled",
            Self::BudgetExceeded { .. } => "budget-exceeded",
            Self::GuestTrap(_) => "guest-trap",
            Self::InvalidMessage(_) => "invalid-message",
            Self::HostService(_) => "transient",
            Self::GuestFail { kind, .. } => kind.as_str(),
        }
    }
}
