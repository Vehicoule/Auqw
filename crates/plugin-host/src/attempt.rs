//! Per-invocation accounting returned alongside every result or failure.

use std::time::Duration;

/// Accounting for one invocation, returned with both success and failure.
#[derive(Clone)]
pub struct Attempt {
    /// Host-generated request id for the invocation.
    pub request_id: String,
    /// Number of `handle` steps executed.
    pub steps: u32,
    /// Number of HTTP requests performed on the guest's behalf.
    pub http_calls: u32,
    /// HTTP request + response body bytes moved.
    pub bytes: u64,
    /// Fuel consumed across all guest entries.
    pub fuel_used: u64,
    /// Wall-clock elapsed time.
    pub elapsed: Duration,
    /// One entry per HTTP request, with the URL's query string stripped.
    pub http_trace: Vec<HttpTraceEntry>,
    /// Guest `log` entries, newest last; messages are already redacted.
    pub guest_log: Vec<GuestLogEntry>,
    /// Token material the host handed the guest this invocation
    /// (`access_token` in the invoke payload, strings from a pot
    /// provider response). Masked out of every guest-controlled surface
    /// — logs, `fail` messages, error text — per the no-token-in-logs
    /// invariant.
    pub(crate) secrets: Vec<String>,
}

/// `secrets` holds token material — keep it out of `Debug` output so a
/// `{:?}` of an invocation's accounting can't leak it.
impl std::fmt::Debug for Attempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Attempt")
            .field("request_id", &self.request_id)
            .field("steps", &self.steps)
            .field("http_calls", &self.http_calls)
            .field("bytes", &self.bytes)
            .field("fuel_used", &self.fuel_used)
            .field("elapsed", &self.elapsed)
            .field("http_trace", &self.http_trace)
            .field("guest_log", &self.guest_log)
            .finish_non_exhaustive()
    }
}

/// One HTTP request performed for the guest.
#[derive(Debug, Clone)]
pub struct HttpTraceEntry {
    /// HTTP method (`GET` or `POST`).
    pub method: String,
    /// URL with query string and fragment removed.
    pub url: String,
    /// Response status, if a response was received.
    pub status: Option<u16>,
    /// Response body bytes received.
    pub bytes: u64,
    /// Round-trip time.
    pub elapsed: Duration,
}

/// A guest `log` host-request entry stored on the attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestLogEntry {
    /// `debug` | `info` | `warn` | `error`.
    pub level: String,
    /// Message text with embedded URLs stripped of query and fragment.
    pub message: String,
}
