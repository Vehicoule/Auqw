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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use tokio::runtime::Handle;

use crate::error::{lock, StreamError};
use crate::fetch::{Fetch, ReqwestFetch};
use crate::marks::{now_ms, PhaseMarks};
use crate::pump::pump_loop;
use crate::session::{PoolSignals, SessionInner};
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
    /// Handles this prepare ended or pruned: sessions it superseded
    /// plus already-terminal entries dropped from the map. Callers
    /// routing streams through a per-handle map (the mobile bindings)
    /// unregister these so a superseded handle can never be attached
    /// against a stale routing entry. Empty on a coalesced prepare.
    pub superseded: Vec<String>,
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
    sessions: Arc<Mutex<HashMap<String, Arc<SessionInner>>>>,
    /// Serializes the supersede-scan + session-creation + insert inside
    /// `prepare` — without it two concurrent prepares can interleave
    /// into two live unattached sessions.
    prepare_lock: Mutex<()>,
    /// Cross-session demand accounting (attached fetch-through
    /// outranks speculative fill).
    pool: Arc<PoolSignals>,
    counter: AtomicU64,
    /// Per-registry instance id — keeps handles unique across two live
    /// registries in one process (a second host must not mint `st-0`
    /// again and resolve against the wrong owner).
    instance: u64,
    sweep: SweepReport,
    /// Abandoned-prepare reaper task (TTL → `Evicted`), aborted on
    /// shutdown/drop.
    reaper: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Set by `shutdown` (or drop): later `prepare` calls fail
    /// `Cancelled` instead of resurrecting sessions on a dead registry.
    shutdown: AtomicBool,
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
        // The sweep settles *crash* leftovers — files of a previous
        // process instance. A second live registry on the same dir
        // must not evict the first's sessions, so each dir is swept at
        // most once per process (the first sweep already settled it).
        let key = config
            .cache_dir
            .canonicalize()
            .unwrap_or_else(|_| config.cache_dir.clone());
        let first = SWEPT_DIRS
            .lock()
            .map(|mut dirs| dirs.insert(key))
            .unwrap_or(false);
        let sweep = if first {
            sweep_dir(&config.cache_dir)
        } else {
            SweepReport::default()
        };
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let reaper = runtime.spawn(reap_loop(
            Arc::clone(&sessions),
            config.prepare_ttl,
            config.reap_interval,
        ));
        Ok(Self {
            config,
            fetch,
            runtime,
            sessions,
            prepare_lock: Mutex::new(()),
            pool: PoolSignals::new(),
            counter: AtomicU64::new(0),
            instance: NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed),
            sweep,
            reaper: Mutex::new(Some(reaper)),
            shutdown: AtomicBool::new(false),
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
    /// Per-(provider, sourceRef) coalescing (the prepare policy's
    /// debounce): a live, still-fresh *unattached* session minted by
    /// the same provider for the same `source_ref` is returned as-is —
    /// repeated intent on the same source finishes the in-flight
    /// prepare rather than cancelling and restarting it. Two providers
    /// answering the same `source_ref` mint different URLs, mimes, and
    /// itags, so the key carries provider identity; a stale candidate
    /// is superseded normally.
    ///
    /// # Errors
    /// As [`Self::prepare`].
    pub fn prepare_timed(
        &self,
        source: PreparedSource,
        remint: Arc<dyn Remint>,
        resolve_elapsed: Option<Duration>,
    ) -> Result<PrepareInfo, StreamError> {
        if self.shutdown.load(Ordering::Relaxed) {
            return Err(StreamError::Cancelled);
        }
        if source.url.is_empty() {
            return Err(StreamError::InvalidResponse {
                message: "prepare source has no url".into(),
            });
        }
        if !valid_mime(&source.mime) {
            return Err(StreamError::InvalidResponse {
                message: "prepare source mime is not `type/subtype`".into(),
            });
        }
        // Serialized: scan, coalesce-check, supersede, create, and
        // insert must be atomic against other prepares or two
        // concurrent prepares could both leave unattached sessions.
        let _guard = lock(&self.prepare_lock)?;
        // `shutdown` also takes this lock, so the flag check inside it
        // is decisive — a prepare can never insert a session after the
        // shutdown sweep has already run.
        if self.shutdown.load(Ordering::Relaxed) {
            return Err(StreamError::Cancelled);
        }
        if let Some(info) = self.reusable(&source.provider, &source.source_ref)? {
            return Ok(info);
        }
        let superseded = self.supersede_unattached()?;
        let handle = format!(
            "st-{}-{}",
            self.instance,
            self.counter.fetch_add(1, Ordering::Relaxed)
        );
        let session = SessionInner::new(
            handle.clone(),
            source.clone(),
            remint,
            self.config.clone(),
            Arc::clone(&self.pool),
        )?;
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
            superseded,
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
    /// into its typed error; a latched retriable failure surfaces its
    /// kind once — the next read re-drives the pump.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle; the session's
    /// terminal error; [`StreamError::Transient`] on deadline or a
    /// latched retriable failure.
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

    /// Cancel only if the session is still unattached — the intent-flip
    /// path (`cancelPrepare` landing after `prepared`): an attached,
    /// playing consumer is untouched; a still-speculative session is
    /// cancelled and its partial file evicted. No-op on unknown handles.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn cancel_if_unattached(&self, handle: &str) -> Result<(), StreamError> {
        if let Some(s) = self.lookup(handle)? {
            s.terminate_if(StreamError::Cancelled, |sh| !sh.attached);
        }
        Ok(())
    }

    /// Whether `handle` names a live (non-terminal) session — callers
    /// pruning stale handle bookkeeping (the bindings' prepare map)
    /// need the live answer, not just presence in the map.
    #[must_use]
    pub fn is_live(&self, handle: &str) -> bool {
        self.lookup(handle)
            .map(|o| o.is_some_and(|s| !s.is_terminal()))
            .unwrap_or(false)
    }

    /// End every session `Cancelled` (pumps aborted, readers woken,
    /// files evicted) and stop the reaper — for host teardown. Also
    /// runs on drop. Later `prepare` calls fail `Cancelled`.
    pub fn shutdown(&self) {
        // Serialize against `prepare`: it re-checks the flag under this
        // lock, so whichever runs second sees the other's outcome — a
        // racing prepare can never leave a live session behind the
        // sweep. Poison must not block teardown, hence `.ok()`.
        let _guard = self.prepare_lock.lock().ok();
        self.shutdown.store(true, Ordering::Relaxed);
        if let Ok(mut r) = self.reaper.lock() {
            if let Some(h) = r.take() {
                h.abort();
            }
        }
        let sessions: Vec<Arc<SessionInner>> = self
            .sessions
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();
        for s in sessions {
            s.terminate(StreamError::Cancelled);
        }
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

    /// A live, unattached, still-fresh session minted by `provider` for
    /// `source_ref`, if one exists — the coalescing candidate for a
    /// repeated prepare on the same source. Provider identity is part
    /// of the key: a same-ref prepare on a different provider must
    /// never inherit this session's URL, mime, itag, or remint. A
    /// stale candidate (detached past the TTL or inside the expiry
    /// margin) is left for the supersede scan instead.
    fn reusable(
        &self,
        provider: &str,
        source_ref: &str,
    ) -> Result<Option<PrepareInfo>, StreamError> {
        let sessions = lock(&self.sessions)?;
        let margin = u64::try_from(self.config.expiry_margin.as_millis()).unwrap_or(u64::MAX);
        for (handle, s) in sessions.iter() {
            if s.is_terminal() || s.is_attached() {
                continue;
            }
            if s.detached_for()
                .is_none_or(|d| d >= self.config.prepare_ttl)
            {
                continue;
            }
            let core = lock(&s.core)?;
            if core.source.provider != provider || core.source.source_ref != source_ref {
                continue;
            }
            if let Some(exp) = core.source.expires_at_ms {
                if now_ms().saturating_add(margin) >= exp {
                    continue;
                }
            }
            return Ok(Some(PrepareInfo {
                handle: handle.clone(),
                mime: core.source.mime.clone(),
                itag: core.source.itag,
                bitrate_kbps: core.source.bitrate_kbps,
                content_length: core.source.content_length,
                expires_at_ms: core.source.expires_at_ms,
                superseded: Vec::new(),
            }));
        }
        Ok(None)
    }

    /// Terminate every unattached non-terminal session with
    /// `Superseded` and drop terminal handles from the map. The
    /// still-unattached check is re-done inside the terminal
    /// transition — an attach that lands after the scan wins, so a
    /// playing consumer is never superseded by accident. Returns the
    /// handles the scan actually ended or pruned: callers routing by
    /// handle unregister these so a dead session's routing entry can
    /// never serve a later attach.
    fn supersede_unattached(&self) -> Result<Vec<String>, StreamError> {
        let (doomed, mut superseded) = {
            let mut sessions = lock(&self.sessions)?;
            let doomed: Vec<(String, Arc<SessionInner>)> = sessions
                .iter()
                .filter(|(_, s)| !s.is_attached() && !s.is_terminal())
                .map(|(h, s)| (h.clone(), Arc::clone(s)))
                .collect();
            let mut pruned = Vec::new();
            sessions.retain(|h, s| {
                if s.is_terminal() {
                    pruned.push(h.clone());
                    false
                } else {
                    true
                }
            });
            (doomed, pruned)
        };
        for (h, s) in doomed {
            s.terminate_if(StreamError::Superseded, |sh| !sh.attached);
            // An attach landing in the race window keeps the session
            // live — only handles the transition actually ended belong
            // on the unregister list.
            if s.is_terminal() {
                superseded.push(h);
            }
        }
        Ok(superseded)
    }
}

impl Drop for StreamRegistry {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The abandoned-prepare reaper: every `interval`, sessions detached
/// longer than `ttl` end `Evicted` (readers woken, partial files
/// dropped) — an intent that never became a play, or a consumer that
/// detached and never came back, does not pin cache space or a parked
/// pump forever. Detached duration is the clock, not session age: a
/// session that played past the TTL and then closed survives the
/// DataSource close→open window its age would otherwise forfeit.
async fn reap_loop(
    sessions: Arc<Mutex<HashMap<String, Arc<SessionInner>>>>,
    ttl: Duration,
    interval: Duration,
) {
    let interval = interval.max(Duration::from_millis(50));
    loop {
        tokio::time::sleep(interval).await;
        let doomed: Vec<(String, Arc<SessionInner>)> = sessions
            .lock()
            .map(|m| {
                m.iter()
                    .filter(|(_, s)| !s.is_terminal() && s.detached_for().is_some_and(|d| d >= ttl))
                    .map(|(h, s)| (h.clone(), Arc::clone(s)))
                    .collect()
            })
            .unwrap_or_default();
        for (handle, s) in doomed {
            // Recheck under `shared`: an attach landing between the
            // filter and here clears `detached_since`, so the recheck
            // fails and the attach wins — never an evict on a session
            // a consumer just reconnected to.
            if s.terminate_if(StreamError::Evicted, |sh| {
                sh.detached_since.is_some_and(|d| d.elapsed() >= ttl)
            }) {
                // The evicted session can never attach or serve again —
                // keeping its entry only grows the map on every
                // abandoned prepare, and callers routing by handle drop
                // it on the `not-found` answer anyway. Entries killed
                // by other paths keep their typed terminal error until
                // the next supersede prunes them.
                if let Ok(mut m) = sessions.lock() {
                    m.remove(&handle);
                }
            }
        }
    }
}

/// Cache dirs already swept this process — see [`StreamRegistry::with_fetch`].
static SWEPT_DIRS: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Monotonic registry instance id for `st-{instance}-{n}` handles.
static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(0);

/// `type/subtype` shape only — the seam does not second-guess the
/// container family (Media3 owns that), but a malformed mime at
/// prepare is an `InvalidResponse` now, not a player failure later.
fn valid_mime(mime: &str) -> bool {
    let Some((t, s)) = mime.split_once('/') else {
        return false;
    };
    !t.is_empty()
        && !s.is_empty()
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+' | b'_'))
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
