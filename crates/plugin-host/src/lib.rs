//! Wasmi host for Auqw provider plugins (ABI v0).
//!
//! Loads a plugin artifact plus manifest, enforces the v0 sandbox (zero
//! imports, no start section, required exports), and runs the step loop:
//! guest `handle` calls drive `done` / `fail` / `host_request` messages;
//! host services (HTTP, PO token, KV, log, clock) are delivered through
//! typed step kinds under budgets and manifest permissions.

mod attempt;
mod budgets;
mod error;
mod http;
mod invoke;
mod kv;
mod manifest;
mod redact;
mod services;

pub use attempt::{Attempt, GuestLogEntry, HttpTraceEntry};
pub use budgets::{BudgetDimension, Budgets};
pub use error::{HttpError, HttpErrorKind, InvokeError, KvError, LoadError, ManifestError};
pub use http::{HttpClient, HttpRequest, HttpResponse, ReqwestClient};
pub use invoke::{invoke, load, Invocation, LoadedPlugin};
pub use kv::{FileKeyValueStore, KeyValueStore, MemoryKeyValueStore};
pub use manifest::{ArtifactRef, Manifest};
pub use redact::{redact_text, redact_url};
pub use services::{HostClock, HostServices, SystemClock};

/// ABI version implemented by this crate.
pub const ABI_VERSION: &str = "0.3.0";

/// ABI versions this host loads. `0.1.0` and `0.2.0` message shapes
/// are strict subsets of their successors, so legacy manifests keep
/// working.
pub const SUPPORTED_ABI_VERSIONS: &[&str] = &["0.1.0", "0.2.0", "0.3.0"];
