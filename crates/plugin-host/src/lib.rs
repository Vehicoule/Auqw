//! Wasmi host for Auqw provider plugins (ABI v0).
//!
//! Loads a plugin artifact plus manifest, enforces the v0 sandbox (zero
//! imports, no start section, required exports), and runs the step loop:
//! guest `handle` calls drive `done` / `fail` / `host_request` messages;
//! HTTP is performed by the host under budgets and manifest permissions.

mod attempt;
mod budgets;
mod error;
mod http;
mod invoke;
mod manifest;
mod redact;

pub use attempt::{Attempt, HttpTraceEntry};
pub use budgets::{BudgetDimension, Budgets};
pub use error::{HttpError, HttpErrorKind, InvokeError, LoadError, ManifestError};
pub use http::{HttpClient, HttpRequest, HttpResponse, ReqwestClient};
pub use invoke::{invoke, load, Invocation, LoadedPlugin};
pub use manifest::{ArtifactRef, Manifest};
pub use redact::redact_url;

/// ABI version implemented by this crate.
pub const ABI_VERSION: &str = "0.1.0";
