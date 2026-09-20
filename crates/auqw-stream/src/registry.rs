//! The session registry: prepares, attaches, reads, and lifecycle —
//! plus the startup sweep that settles crash leftovers honestly.
//!
//! Supersede policy: at most one *unattached* session lives at a time;
//! a new `prepare` terminates any unattached prepared/preparing
//! session (`Superseded`) and evicts its partial file. Attached
//! sessions are exempt — playing audio is never preempted by prefetch.
//!
//! Sweep policy (v1): leftover session files are always evicted, not
//! resumed — handles are per-process, so no caller could address a
//! restored session anyway. The sweep still parses each sidecar so a
//! corrupt map is distinguished from a clean partial in the report;
//! both are dropped honestly, never trusted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::runtime::Handle;

use crate::error::{lock, StreamError};
use crate::fetch::{Fetch, ReqwestFetch};
use crate::marks::PhaseMarks;
use crate::pump::pump_loop;
use crate::session::SessionInner;
use crate::store::Sidecar;
use crate::{PreparedSource, Remint, StreamConfig};

/// What [`StreamRegistry::prepare`] returns: the opaque handle plus the
/// stream metadata the player port needs (never the signed URL).
#[derive(Debug, Clone)]
pub struct PrepareInfo {
    /// Opaque session handle — `prepared → attached → released`.
    pub handle: String,
    /// MIME type of the prepared stream.
    pub mime: String,
    /// Format itag when reported.
    pub itag: Option<u32>,
    /// Bitrate hint in kbps.
    pub bitrate_kbps: Option<u32>,
    /// Reported length in bytes, when known.
    pub content_length: Option<u64>,
    /// URL expiry, epoch ms.
    pub expires_at_ms: Option<u64>,
}

/// How the startup sweep settled leftover session files.
#[derive(Debug, Clone, Copy, Default)]
pub struct SweepReport {
    /// Leftovers that parsed cleanly (or orphans) and were evicted.
    pub evicted: usize,
    /// Files dropped because the sidecar was corrupt — never trusted,
    /// never silently kept.
    pub corrupt: usize,
}

/// Owns the session map, the cache dir, the byte transport, and the
/// runtime handle pump tasks spawn on.
pub struct StreamRegistry {
    config: StreamConfig,
    fetch: Arc<dyn Fetch>,
    runtime: Handle,
    sessions: Mutex<HashMap<String, Arc<SessionInner>>>,
    counter: AtomicU64,
    sweep: SweepReport,
}

impl StreamRegistry {
    /// A registry over `ReqwestFetch` (production transport).
    ///
    /// Creates `cache_dir` if needed and runs the startup sweep.
    ///
    /// # Errors
    /// [`StreamError::Internal`] when the dir cannot be created, swept,
    /// or the TLS backend cannot start.
    pub fn new(config: StreamConfig, runtime: Handle) -> Result<Self, StreamError> {
        Self::with_fetch(config, runtime, Arc::new(ReqwestFetch::new()?))
    }

    /// A registry over an injected [`Fetch`] — tests use fakes; the
    /// seam never opens sockets below this boundary.
    ///
    /// # Errors
    /// [`StreamError::Internal`] when `cache_dir` cannot be created or
    /// swept.
    pub fn with_fetch(
        config: StreamConfig,
        runtime: Handle,
        fetch: Arc<dyn Fetch>,
    ) -> Result<Self, StreamError> {
        std::fs::create_dir_all(&config.cache_dir).map_err(|e| StreamError::Internal {
            message: format!("cache dir: {e}"),
        })?;
        let sweep = sweep_dir(&config.cache_dir);
        Ok(Self {
            config,
            fetch,
            runtime,
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            sweep,
        })
    }

    /// The startup sweep's report.
    #[must_use]
    pub fn sweep_report(&self) -> SweepReport {
        self.sweep
    }

    /// Number of leftover files the sweep settled (evicted + corrupt).
    #[must_use]
    pub fn swept(&self) -> usize {
        self.sweep.evicted + self.sweep.corrupt
    }

    /// Register `source` as a session and spawn its bounded head fill.
    /// Supersedes any *unattached* live session and garbage-collects
    /// terminal handles. The returned [`PrepareInfo`] never carries
    /// the signed URL.
    ///
    /// # Errors
    /// [`StreamError::InvalidResponse`] for an empty `url`;
    /// [`StreamError::Internal`] on cache I/O or lock poisoning.
    pub fn prepare(
        &self,
        source: PreparedSource,
        remint: Arc<dyn Remint>,
    ) -> Result<PrepareInfo, StreamError> {
        self.prepare_timed(source, remint, None)
    }

    /// [`Self::prepare`] plus the resolve's elapsed time, recorded in
    /// the session's [`PhaseMarks::resolve_ms`] for the port's
    /// intent→prepared join.
    ///
    /// # Errors
    /// As [`Self::prepare`].
    pub fn prepare_timed(
        &self,
        source: PreparedSource,
        remint: Arc<dyn Remint>,
        resolve_elapsed: Option<Duration>,
    ) -> Result<PrepareInfo, StreamError> {
        if source.url.is_empty() {
            return Err(StreamError::InvalidResponse {
                message: "prepare source has no url".into(),
            });
        }
        self.supersede_unattached()?;
        let handle = format!("st-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let session =
            SessionInner::new(handle.clone(), source.clone(), remint, self.config.clone())?;
        if let Some(d) = resolve_elapsed {
            if let Ok(mut sh) = lock(&session.shared) {
                sh.marks.resolve_ms = Some(u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
            }
        }
        let task = self
            .runtime
            .spawn(pump_loop(Arc::clone(&session), Arc::clone(&self.fetch)));
        if let Ok(mut t) = session.task.lock() {
            *t = Some(task);
        }
        lock(&self.sessions)?.insert(handle.clone(), session);
        Ok(PrepareInfo {
            handle,
            mime: source.mime,
            itag: source.itag,
            bitrate_kbps: source.bitrate_kbps,
            content_length: source.content_length,
            expires_at_ms: source.expires_at_ms,
        })
    }

    /// Attach a consumer at `position`; releases the head-fill bound
    /// into the read-ahead pump and exempts the session from supersede.
    /// Returns `content_length − position` when the total is known.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle;
    /// [`StreamError::Expired`] when the URL is inside the expiry
    /// margin or the prepare TTL has passed; the session's terminal
    /// error if it already ended.
    pub fn attach(&self, handle: &str, position: u64) -> Result<Option<u64>, StreamError> {
        self.session(handle)?.attach(position)
    }

    /// Blocking read — **foreign (JNI/DataSource) threads only**;
    /// parking a runtime worker is a bug. Empty `Vec` = EOF. Bounded by
    /// `StreamConfig::read_deadline`; every terminal transition wakes
    /// into its typed error.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle; the session's
    /// terminal error; [`StreamError::Transient`] on deadline.
    pub fn read(&self, handle: &str, position: u64, max_len: u64) -> Result<Vec<u8>, StreamError> {
        self.session(handle)?.read(position, max_len)
    }

    /// DataSource close: detaches the consumer; the session stays live
    /// for re-attach and becomes supersedable again.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle.
    pub fn close(&self, handle: &str) -> Result<(), StreamError> {
        self.session(handle)?.close();
        Ok(())
    }

    /// Terminal release: readers unwind `Released`, in-flight work is
    /// aborted, and the partial file is evicted. Idempotent — unknown
    /// or already-ended handles are a no-op.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn release(&self, handle: &str) -> Result<(), StreamError> {
        if let Some(s) = self.lookup(handle)? {
            s.terminate(StreamError::Released);
        }
        Ok(())
    }

    /// Cooperative cancel: the session ends `Cancelled` — parked
    /// readers unwind into it and the partial file is evicted. (Cancel
    /// is terminal for the session, attached or not; a playing consumer
    /// should use `close`/`release`.) No-op on unknown handles.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn cancel(&self, handle: &str) -> Result<(), StreamError> {
        if let Some(s) = self.lookup(handle)? {
            s.terminate(StreamError::Cancelled);
        }
        Ok(())
    }

    /// The session's lifecycle marks — returned even after terminal
    /// states (they are diagnostics, not capabilities).
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle.
    pub fn phase_marks(&self, handle: &str) -> Result<PhaseMarks, StreamError> {
        Ok(lock(&self.session(handle)?.shared)?.marks.clone())
    }

    /// Look up a live-or-terminal session by handle.
    fn session(&self, handle: &str) -> Result<Arc<SessionInner>, StreamError> {
        self.lookup(handle)?.ok_or(StreamError::NotFound)
    }

    fn lookup(&self, handle: &str) -> Result<Option<Arc<SessionInner>>, StreamError> {
        Ok(lock(&self.sessions)?.get(handle).cloned())
    }

    /// Terminate every unattached non-terminal session with
    /// `Superseded` and drop terminal handles from the map.
    fn supersede_unattached(&self) -> Result<(), StreamError> {
        let doomed: Vec<Arc<SessionInner>> = {
            let mut sessions = lock(&self.sessions)?;
            let doomed = sessions
                .values()
                .filter(|s| !s.is_attached() && !s.is_terminal())
                .cloned()
                .collect();
            sessions.retain(|_, s| !s.is_terminal());
            doomed
        };
        for s in doomed {
            s.terminate(StreamError::Superseded);
        }
        Ok(())
    }
}

/// Settle `cache_dir` leftovers: evict every `{stem}.bin`/`.json`/`.tmp`
/// pair; a corrupt sidecar is counted separately and still dropped.
fn sweep_dir(dir: &std::path::Path) -> SweepReport {
    let mut report = SweepReport::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return report;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".json.tmp") {
            // An interrupted sidecar write — settled as a clean leftover.
            settle(&mut report, dir, stem, false);
        } else if let Some(stem) = name.strip_suffix(".json") {
            let corrupt = Sidecar::load(&entry.path()).is_err();
            settle(&mut report, dir, stem, corrupt);
        } else if let Some(stem) = name.strip_suffix(".bin") {
            if !dir.join(format!("{stem}.json")).exists() {
                // Orphaned data file — evicted as a clean leftover.
                settle(&mut report, dir, stem, false);
            }
        }
    }
    report
}

/// Remove one stem's three files and account it in the report.
fn settle(report: &mut SweepReport, dir: &std::path::Path, stem: &str, corrupt: bool) {
    let mut removed = false;
    for suffix in [".bin", ".json", ".json.tmp"] {
        removed |= std::fs::remove_file(dir.join(format!("{stem}{suffix}"))).is_ok();
    }
    if removed {
        if corrupt {
            report.corrupt += 1;
        } else {
            report.evicted += 1;
        }
    }
}
