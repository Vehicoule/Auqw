//! `auqw-stream` — the shared Rust streaming seam: a sparse byte store,
//! a pump carrying the Slice-0 wire rules, and a session registry with
//! a blocking-read bridge for foreign threads.
//!
//! The seam is the transport side of `PlayerPort`. `prepare` registers
//! a resolved [`PreparedSource`] and starts a bounded head fill; `attach`
//! releases the full pump (read-ahead window); `read` serves bytes at
//! any offset — fetch-through on holes — and `release`/`cancel` end the
//! session. Cap death (`403`/`416`) re-mints through [`Remint`] and
//! resumes inside the seam; the player never sees the `403`.
//!
//! # Invariants
//!
//! - **Signed URLs never leave Rust.** `PreparedSource.url` is never
//!   logged, persisted (the sidecar omits it), or embedded in
//!   [`StreamError`] messages — errors carry kinds, offsets, and
//!   statuses.
//! - **`read`/`stream_read` is a foreign-thread bridge.** It parks the
//!   calling thread on a [`std::sync::Condvar`]. Calling it from a
//!   tokio runtime worker parks that worker and is a bug — JNI/DataSource
//!   threads only.
//! - **Every terminal transition wakes parked readers** into the typed
//!   error that ended the session: cancel, release, supersede, evict,
//!   expiry, pump failure.
//! - **Range requests always** — full-file GETs throttle.
//! - **Mime is pinned**: a re-mint that returns a different container
//!   is terminal `InvalidResponse`, never a silent swap.

mod error;
mod fetch;
mod marks;
mod pump;
mod registry;
mod session;
mod store;
#[cfg(test)]
mod testkit;

pub use error::StreamError;
pub use fetch::{Fetch, FetchResponse, ReqwestFetch};
pub use marks::PhaseMarks;
pub use registry::{PrepareInfo, StreamRegistry, SweepReport};

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// Tuning knobs for one [`StreamRegistry`].
///
/// The defaults carry the slice's policy: a ~3 MiB speculative head
/// fill, a 4 MiB attached read-ahead window, a named 15 s read deadline
/// (resolve budget + mint + head fetch), and a bounded re-mint budget
/// for cap-death recovery.
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// Directory holding `{handle}.bin` data files and `{handle}.json`
    /// extent sidecars. Created if missing; swept at startup.
    pub cache_dir: PathBuf,
    /// Speculative fill bound for unattached sessions (~3 MiB).
    pub head_bytes: u64,
    /// Attached fill window ahead of the read frontier.
    pub read_ahead: u64,
    /// Max bytes per range request.
    pub chunk_bytes: u64,
    /// No-progress bound inside one request (headers wait or a body
    /// stall) — aborts the chunk fetch into `Transient`.
    pub stall: Duration,
    /// Total re-mints one session may perform (`403`/`416` recovery).
    pub mint_budget: u32,
    /// Consecutive re-mints allowed to produce no new bytes before the
    /// session aborts `StreamsCapped`.
    pub max_zero_progress_mints: u32,
    /// Total bound on one blocking `read` call — the named deadline of
    /// the seam (resolve + mint + head-fetch budget).
    pub read_deadline: Duration,
    /// Bound on one re-mint (`playback.resolve`) — a hung resolve ends
    /// the attempt `Transient` instead of zombieing the session.
    pub mint_deadline: Duration,
    /// Bound on one whole range request (headers + body). `stall`
    /// bounds progress gaps inside the request; this caps the total so
    /// a dribbling body cannot outlive it.
    pub request_deadline: Duration,
    /// How long a prepared session may sit before `attach` fails it
    /// `Expired` and the reaper evicts it.
    pub prepare_ttl: Duration,
    /// How often the reaper scans for abandoned (unattached past TTL)
    /// sessions.
    pub reap_interval: Duration,
    /// `attach` refuses URLs expiring within this margin (~60 s).
    pub expiry_margin: Duration,
}

impl StreamConfig {
    /// A config for `cache_dir` with the slice defaults.
    #[must_use]
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            head_bytes: 3 * 1024 * 1024,
            read_ahead: 4 * 1024 * 1024,
            chunk_bytes: 256 * 1024,
            stall: Duration::from_secs(10),
            mint_budget: 4,
            max_zero_progress_mints: 2,
            read_deadline: Duration::from_secs(15),
            mint_deadline: Duration::from_secs(20),
            request_deadline: Duration::from_secs(60),
            prepare_ttl: Duration::from_secs(120),
            reap_interval: Duration::from_secs(15),
            expiry_margin: Duration::from_secs(60),
        }
    }
}

/// A resolved stream source handed to [`StreamRegistry::prepare`].
///
/// `url` is signed: it must never be logged, returned in errors, or
/// written to disk — the sidecar persists only the non-secret fields.
#[derive(Clone)]
pub struct PreparedSource {
    /// Signed stream URL (secret — see invariant).
    pub url: String,
    /// MIME type, e.g. `audio/mp4`; pinned across re-mints.
    pub mime: String,
    /// Format itag when the provider reported one.
    pub itag: Option<u32>,
    /// Bitrate hint in kbps.
    pub bitrate_kbps: Option<u32>,
    /// Reported length in bytes — a hint until the wire answers
    /// `Content-Range`.
    pub content_length: Option<u64>,
    /// URL expiry, epoch ms; `attach` enforces the configured margin.
    pub expires_at_ms: Option<u64>,
    /// Provider source reference (not a secret) — carried for sidecar
    /// metadata and diagnostics.
    pub source_ref: String,
}

// `Debug` prints every field but `url` — one `{:?}` anywhere must not
// leak the signed URL into logs, the same reason `Fetch` errors are
// `without_url()`.
impl std::fmt::Debug for PreparedSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedSource")
            .field("url", &"<redacted>")
            .field("mime", &self.mime)
            .field("itag", &self.itag)
            .field("bitrate_kbps", &self.bitrate_kbps)
            .field("content_length", &self.content_length)
            .field("expires_at_ms", &self.expires_at_ms)
            .field("source_ref", &self.source_ref)
            .finish()
    }
}

/// Re-resolves a session's `source_ref` after cap death (`403`/`416`).
///
/// The host supplies this via `invoke` (a fresh `playback.resolve`
/// invocation per call). The pump pins the prepared mime on the result.
pub trait Remint: Send + Sync {
    /// Produce a fresh [`PreparedSource`] for the same `source_ref`, or
    /// the typed failure the resolve ended in.
    fn remint(
        &self,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<PreparedSource, StreamError>> + Send>>;
}

/// Ensure the futures and trait objects the crate threads through are
/// `Send` — the pump runs on a multi-thread runtime.
#[allow(dead_code)]
fn _assert_send<T: Send>(_: &T) {
    // compile-time only
}

#[allow(dead_code)]
fn _assertions(reg: &StreamRegistry, rem: &Arc<dyn Remint>) {
    _assert_send(reg);
    _assert_send(rem);
}
