//! Per-invocation resource budgets. Budgets are cumulative for an
//! invocation and never refilled.

use std::time::Duration;

/// Resource limits applied to a single plugin invocation.
///
/// The fuel defaults are provisional placeholders sized so that a CPU-only
/// guest loop traps well under the 500 ms target on desktop hardware; they
/// are calibrated on-device in Slice 0.
#[derive(Debug, Clone)]
pub struct Budgets {
    /// Fuel granted to each guest entry (`alloc`/`handle` call).
    pub fuel_per_entry: u64,
    /// Total fuel across all guest entries in one invocation.
    pub fuel_total: u64,
    /// Maximum number of `handle` steps per invocation.
    pub max_steps: u32,
    /// Maximum number of HTTP host requests per invocation.
    pub max_http_calls: u32,
    /// Maximum HTTP request + response body bytes, in and out combined.
    pub max_bytes: u64,
    /// Per-request HTTP timeout.
    pub http_timeout: Duration,
    /// Wall-clock deadline for the whole invocation.
    pub deadline: Duration,
    /// Guest linear memory cap.
    pub max_memory_bytes: usize,
    /// Artifact size cap, checked at load.
    pub max_artifact_bytes: usize,
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            fuel_per_entry: 40_000_000,
            fuel_total: 400_000_000,
            max_steps: 1_000,
            max_http_calls: 32,
            max_bytes: 8 * 1024 * 1024,
            http_timeout: Duration::from_secs(10),
            deadline: Duration::from_secs(30),
            max_memory_bytes: 64 * 1024 * 1024,
            max_artifact_bytes: 5 * 1024 * 1024,
        }
    }
}

/// Which budget dimension was exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetDimension {
    /// Guest fuel (per-entry or total).
    Fuel,
    /// Step count.
    Steps,
    /// HTTP call count.
    HttpCalls,
    /// HTTP byte count (in + out).
    Bytes,
    /// Wall-clock deadline.
    Deadline,
}

impl std::fmt::Display for BudgetDimension {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Fuel => "fuel",
            Self::Steps => "steps",
            Self::HttpCalls => "http-calls",
            Self::Bytes => "bytes",
            Self::Deadline => "deadline",
        };
        f.write_str(s)
    }
}
