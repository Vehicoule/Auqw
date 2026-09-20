//! Per-invocation accounting returned alongside every result or failure.

use std::time::Duration;

/// Accounting for one invocation, returned with both success and failure.
#[derive(Debug, Clone)]
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
