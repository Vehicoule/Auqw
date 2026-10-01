//! The session registry: prepares, attaches, reads, and lifecycle —
//! plus the startup sweep that settles crash leftovers honestly.
//!
//! Supersede policy: at most one *unowned* unattached session lives at
//! a time; a new `prepare` terminates any unattached, unclaimed
//! prepared/preparing session (`Superseded`) and evicts its partial
//! file. Attached sessions are exempt — playing audio is never
//! preempted by prefetch — and claimed sessions are exempt too: a
//! `Prepared` whose ownership slot committed is in the deliver→attach
//! window, where an unattached-only teardown would kill the handle
//! the listener is about to open.
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
use crate::pump::{classify_status, drive_fetch, pump_loop, FetchOutcome};
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
    /// against a stale routing entry. A coalesced prepare's survivor
    /// is never on it, but the list still carries every *other*
    /// unattached, unclaimed session the scan ended.
    pub superseded: Vec<String>,
}

/// What [`StreamRegistry::probe`] returns: the contiguous bytes at
/// the requested position plus the best-known stream total.
#[derive(Debug, Clone)]
pub struct ProbeRead {
    /// Contiguous committed bytes from `position` — empty on a
    /// confirmed EOF and on a fetch-disabled hole.
    pub bytes: Vec<u8>,
    /// Best-known stream total (wire `Content-Range` wins over the
    /// resolve-time hint); `None` while neither has produced one.
    pub total: Option<u64>,
    /// `position` is confirmed at/past end-of-stream — never true
    /// for a mere unfetched hole.
    pub eof: bool,
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
    /// Supersedes any unattached, unclaimed live session and
    /// garbage-collects terminal handles. The returned [`PrepareInfo`]
    /// never carries the signed URL.
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
            // A coalesced prepare still owns the supersede scan: the
            // reused session is exempt by handle, but every *other*
            // unattached, unclaimed session ends — an
            // attached-then-detached sibling left live here would
            // mean two unowned unattached sessions coexisting.
            let superseded = self.supersede_unattached(Some(&info.handle))?;
            return Ok(PrepareInfo { superseded, ..info });
        }
        let superseded = self.supersede_unattached(None)?;
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

    /// Coalesce-check without a mint: a live, unattached, still-fresh
    /// session minted by `provider` for `source_ref` — e.g. an advisory
    /// warm issued moments earlier — is returned under the same policy
    /// as [`Self::prepare_timed`]'s reuse branch: the adopting caller
    /// becomes the session's owner and every *other* unattached session
    /// is superseded, so the at-most-one-unattached invariant holds.
    /// `Ok(None)` leaves the registry untouched — the caller then runs
    /// the normal resolve.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn adopt_reusable(
        &self,
        provider: &str,
        source_ref: &str,
    ) -> Result<Option<PrepareInfo>, StreamError> {
        if self.shutdown.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let _guard = lock(&self.prepare_lock)?;
        let Some(info) = self.reusable(provider, source_ref)? else {
            return Ok(None);
        };
        let superseded = self.supersede_unattached(Some(&info.handle))?;
        Ok(Some(PrepareInfo { superseded, ..info }))
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

    /// Probe attach for requests that spend no body bytes (HEAD):
    /// the same liveness verdict as [`Registry::attach`] but without
    /// re-anchoring `read_pos` or claiming consumer intent.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle;
    /// [`StreamError::Expired`] when the URL is inside the expiry
    /// margin or the prepare TTL has passed; the session's terminal
    /// error if it already ended.
    pub fn attach_probe(&self, handle: &str) -> Result<(), StreamError> {
        self.session(handle)?.attach_probe()
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

    /// Non-demanding read for decorative consumers (waveform peaks):
    /// `Some(bytes)` a committed hit, `Some(vec![])` a confirmed EOF,
    /// `None` an unfetched hole. Queues no fetch-through demand and
    /// never parks — a caller-side timeout leaves nothing queued
    /// competing with playback.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle; the session's
    /// terminal error if it already ended.
    pub fn peek(
        &self,
        handle: &str,
        position: u64,
        max_len: u64,
    ) -> Result<Option<Vec<u8>>, StreamError> {
        self.session(handle)?.peek(position, max_len)
    }

    /// One probe read's outcome: the contiguous bytes served or
    /// fetched at `position`, the best-known stream total, and a
    /// confirmed-EOF flag. `fetch: false` on a hole returns
    /// `bytes: []`, `eof: false` — the caller treats that as "not
    /// committed yet", never as end-of-stream.
    ///
    /// A probe is a *decorative* read: it queues no demand, never
    /// parks, and moves no read position. On a committed hit it is
    /// `peek` semantics plus the total report; on a hole with
    /// `fetch` enabled it issues ONE bounded ranged GET through the
    /// session's own `Fetch` — same URL, same mint headers, same
    /// `206`/`Content-Range` validation as the pump — and commits the
    /// bytes into the sparse store, so a probed extent is real data
    /// every later reader (playback included) serves for free. It
    /// never re-mints: a `403` reads back as `Expired` for the caller
    /// to retry once the element's own demand has re-minted, and a
    /// `429` stakes the same provider cooldown the pump honors (the
    /// probe errors `RateLimited` rather than landing inside the ask).
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle; the session's
    /// terminal error if it already ended; `RateLimited` while a
    /// provider `Retry-After` window is still open; the classified
    /// wire/status error otherwise.
    pub async fn probe(
        &self,
        handle: &str,
        position: u64,
        max_len: u64,
        fetch: bool,
    ) -> Result<ProbeRead, StreamError> {
        let session = self.session(handle)?;
        // Probe requests cap at the pump's chunk size — a decoration
        // asks for bounded samples, not segments. `chunk_bytes` floors
        // at 1: a zeroed config must degrade, not panic the clamp.
        let want = max_len.clamp(1, session.config.chunk_bytes.max(1));
        // Committed hit or a confirmed hole/EOF — the peek semantics,
        // with the total riding along either way.
        if let Some(bytes) = session.peek(position, want)? {
            return Ok(ProbeRead {
                eof: bytes.is_empty(),
                bytes,
                total: session.effective_total()?,
            });
        }
        let total = session.effective_total()?;
        if !fetch {
            return Ok(ProbeRead {
                bytes: Vec::new(),
                total,
                eof: false,
            });
        }
        // An open provider `Retry-After` window binds every leg —
        // probes included. Under-waiting is the hammer the header
        // exists to prevent.
        if let Some(wait) = session.cooldown_remaining() {
            return Err(StreamError::RateLimited {
                message: format!("probe at {position} inside provider cooldown"),
                retry_after_ms: Some(u64::try_from(wait.as_millis()).unwrap_or(u64::MAX)),
            });
        }
        let (url, headers) = session.current_fetch()?;
        match drive_fetch(&session, &*self.fetch, &url, &headers, position, want).await? {
            FetchOutcome::Committed => {
                // Re-peek serves exactly what was committed — the
                // same bytes every later reader sees.
                let bytes = session.peek(position, want)?.unwrap_or_default();
                Ok(ProbeRead {
                    eof: bytes.is_empty(),
                    bytes,
                    total: session.effective_total()?,
                })
            }
            FetchOutcome::Status(416, range_total, _) => {
                // Same wire rule as the pump: a `bytes */N` total is
                // authoritative — a refusal AT/PAST it confirms EOF;
                // one covering the probe position is self-contradictory
                // and must not set a ceiling it can't honor.
                if let Some(total) = range_total {
                    session.check_total(total)?;
                    if position < total {
                        return Err(StreamError::InvalidResponse {
                            message: format!(
                                "416 at offset {position} but Content-Range declares total {total}"
                            ),
                        });
                    }
                    session.mark_eof_below(total);
                    return Ok(ProbeRead {
                        bytes: Vec::new(),
                        total: session.effective_total()?,
                        eof: true,
                    });
                }
                // Bare refusal: ambiguous between real EOF and a dead
                // signed URL, and the probe never re-mints to
                // disambiguate — it confirms only what the known total
                // already proves; otherwise the position is simply
                // unprobed (`eof: false` like an unfetched hole).
                let proven = matches!(session.effective_total()?, Some(t) if position >= t);
                Ok(ProbeRead {
                    bytes: Vec::new(),
                    total: session.effective_total()?,
                    eof: proven,
                })
            }
            FetchOutcome::Status(429, _, retry_after_ms) => {
                // Stake the provider's ask session-wide — whichever
                // leg fetches next owes the remainder — bounded by the
                // same `rate_limit_cooldown_cap` the pump's retry path
                // honors, so an oversized ask can't freeze every fetch
                // leg for the provider's full window.
                let e = classify_status(429, position, retry_after_ms);
                if let Some(ms) = retry_after_ms {
                    let wait = Duration::from_millis(
                        ms.min(
                            u64::try_from(session.config.rate_limit_cooldown_cap.as_millis())
                                .unwrap_or(u64::MAX),
                        ),
                    );
                    session.set_cooldown(std::time::Instant::now() + wait);
                }
                Err(e)
            }
            // `403` is a dead mint — `Expired`, not `InvalidResponse`:
            // the caller's retry lands after the element's own demand
            // has re-minted the session.
            FetchOutcome::Status(403, _, _) => Err(StreamError::Expired),
            FetchOutcome::Status(status, _, retry_after_ms) => {
                Err(classify_status(status, position, retry_after_ms))
            }
        }
    }

    /// DataSource close: detaches the consumer; the session stays live
    /// for re-attach and — if it was never claimed — becomes
    /// supersedable again.
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

    /// Claim the session for a committed ownership slot — the seam's
    /// half of the host's `PreparedSlot` insert, run inside the
    /// ownership map's critical section so the slot and the claim land
    /// atomically to `cancel`. Once claimed, unattached-only teardowns
    /// (`supersede_unattached`, `cancel_if_unattached`) skip the
    /// session — it is owned through the deliver→attach window and
    /// across later detaches; `release`, owner `cancel`, expiry, and
    /// the detached reaper still end it. Idempotent; no-op on unknown
    /// handles.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn claim(&self, handle: &str) -> Result<(), StreamError> {
        if let Some(s) = self.lookup(handle)? {
            s.claim();
        }
        Ok(())
    }

    /// [`Self::claim`] gated on liveness under the session lock:
    /// `false` when the handle is unknown or already terminal — the
    /// caller must not deliver it. This is the registry-level
    /// reservation for the deliver→attach window: a session killed
    /// between the caller's liveness snapshot and the claim can no
    /// longer be marked owned and emitted `Prepared`.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn claim_if_live(&self, handle: &str) -> Result<bool, StreamError> {
        Ok(self.lookup(handle)?.is_some_and(|s| s.claim_if_live()))
    }

    /// Cancel only if the session is still unattached and unclaimed —
    /// the intent-flip path (`cancelPrepare` landing after `prepared`):
    /// an attached, playing consumer is untouched, and a claimed
    /// session belongs to its delivered handle (the owner's `cancel`
    /// removes its slot and releases by handle instead); a
    /// still-speculative session is cancelled and its partial file
    /// evicted. No-op on unknown handles.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn cancel_if_unattached(&self, handle: &str) -> Result<(), StreamError> {
        if let Some(s) = self.lookup(handle)? {
            s.terminate_if(StreamError::Cancelled, |sh| !sh.attached && !sh.claimed);
        }
        Ok(())
    }

    /// Owner abandonment: the last `PreparedSlot` owner cancelled.
    /// Attached, the session is only marked — a bookkeeping cancel
    /// must never end a playing stream; the mark makes its `close`
    /// drop `claimed`, so the detached session is supersede/reaper-
    /// reachable instead of sitting ownerless to the TTL. Unattached
    /// it ends `Cancelled` now — nobody is left to attach for.
    /// Unlike `cancel_if_unattached` this ignores `claimed`: the
    /// claim guards OTHER owners' teardowns — its last owner is gone.
    /// No-op on unknown handles.
    ///
    /// # Errors
    /// [`StreamError::Internal`] on lock poisoning.
    pub fn abandon(&self, handle: &str) -> Result<(), StreamError> {
        if let Some(s) = self.lookup(handle)? {
            s.abandon();
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

    /// The session's terminal error if it has ended — the loopback
    /// adapter refuses to mint a URL for a dead handle, and a request
    /// that lands after termination maps this error to its status.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle.
    pub fn terminal_err(&self, handle: &str) -> Result<Option<StreamError>, StreamError> {
        Ok(self.session(handle)?.terminal_err())
    }

    /// `(mime, content_length)` of the session's pinned source — the
    /// `Content-Type` and resolve-time length hint the loopback
    /// adapter reports. The wire `Content-Range` wins over the hint
    /// once bytes land; [`Self::effective_total`] has the freshest
    /// total.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle.
    pub fn source_meta(&self, handle: &str) -> Result<(String, Option<u64>), StreamError> {
        let session = self.session(handle)?;
        let core = lock(&session.core)?;
        Ok((core.source.mime.clone(), core.source.content_length))
    }

    /// The session's best-known total length — the wire
    /// `Content-Range` total when bytes have landed, else the
    /// resolve-time hint — the loopback adapter's `Content-Range`
    /// bookkeeping.
    ///
    /// # Errors
    /// [`StreamError::NotFound`] for an unknown handle.
    pub fn effective_total(&self, handle: &str) -> Result<Option<u64>, StreamError> {
        self.session(handle)?.effective_total()
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

    /// Terminate every unattached, unclaimed, non-terminal session
    /// with `Superseded` and drop terminal handles from the map.
    /// `except` exempts one handle outright — the survivor of a
    /// coalesced prepare, which is unattached by definition and would
    /// otherwise doom itself (and it is never named on the return
    /// list even if it turned terminal between the reuse check and
    /// the scan). The still-unattached-and-unclaimed check is re-done
    /// inside the terminal transition — an attach or a slot-commit
    /// claim landing after the scan wins, so a delivered or playing
    /// consumer is never superseded by accident. Returns the handles
    /// the scan actually ended or pruned: callers routing by handle
    /// unregister these so a dead session's routing entry can never
    /// serve a later attach.
    fn supersede_unattached(&self, except: Option<&str>) -> Result<Vec<String>, StreamError> {
        let (doomed, mut superseded) = {
            let mut sessions = lock(&self.sessions)?;
            let doomed: Vec<(String, Arc<SessionInner>)> = sessions
                .iter()
                .filter(|(h, s)| {
                    Some(h.as_str()) != except
                        && !s.is_attached()
                        && !s.is_claimed()
                        && !s.is_terminal()
                })
                .map(|(h, s)| (h.clone(), Arc::clone(s)))
                .collect();
            let mut pruned = Vec::new();
            sessions.retain(|h, s| {
                if s.is_terminal() && Some(h.as_str()) != except {
                    pruned.push(h.clone());
                    false
                } else {
                    true
                }
            });
            (doomed, pruned)
        };
        for (h, s) in doomed {
            s.terminate_if(StreamError::Superseded, |sh| !sh.attached && !sh.claimed);
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
            // a consumer just reconnected to. The map lock spans the
            // terminal write and the removal (`sessions` is outermost),
            // so a lookup can never observe the terminal-but-present
            // gap — a stale handle answers `not-found`, never a
            // transient `evicted`.
            if let Ok(mut m) = sessions.lock() {
                if s.terminate_if(StreamError::Evicted, |sh| {
                    sh.detached_since.is_some_and(|d| d.elapsed() >= ttl)
                }) {
                    // The evicted session can never attach or serve
                    // again — keeping its entry only grows the map on
                    // every abandoned prepare, and callers routing by
                    // handle drop it on the `not-found` answer anyway.
                    // Entries killed by other paths keep their typed
                    // terminal error until the next supersede prunes
                    // them.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::FetchResponse;
    use crate::testkit::*;

    /// A prepared session whose head fill is disabled — `head_bytes`
    /// 0 parks the pump before it requests — so the probe leg is the
    /// only fetcher and scripted steps land on it in order.
    async fn probed(cfg: StreamConfig, steps: Vec<Step>) -> (StreamRegistry, String) {
        let fetch = Arc::new(ScriptedFetch::new(steps));
        let reg = StreamRegistry::with_fetch(cfg, Handle::current(), fetch)
            .unwrap_or_else(|e| panic!("registry: {e}"));
        let info = reg
            .prepare(source(), Arc::new(StaticRemint))
            .unwrap_or_else(|e| panic!("prepare: {e}"));
        (reg, info.handle)
    }

    /// The [`SessionInner`] behind `handle` — tests observe staked
    /// cooldowns off it directly.
    fn session_of(reg: &StreamRegistry, handle: &str) -> Arc<SessionInner> {
        lock(&reg.sessions)
            .unwrap_or_else(|e| panic!("{e}"))
            .get(handle)
            .cloned()
            .unwrap_or_else(|| panic!("no session {handle}"))
    }

    /// A probe `429` stakes the provider's `Retry-After` ask bounded
    /// by `rate_limit_cooldown_cap` — the same bound the pump's retry
    /// path honors — while the error still reports the real ask.
    /// Uncapped, a >cap ask froze every fetch leg on the session for
    /// the provider's full window.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn probe_429_stakes_capped_cooldown() {
        let d = TestDir::new("probe429");
        let mut cfg = test_config(&d);
        cfg.head_bytes = 0;
        let ask = 86_400_000u64; // a day — the uncapped wedge this guards
        let (reg, h) = probed(
            cfg,
            vec![
                Step::Reply(FetchResponse {
                    status: 429,
                    content_range: None,
                    retry_after_ms: Some(ask),
                    body: stream_body(vec![]),
                }),
                Step::Reply(resp(206, 0, 8, 1024)),
            ],
        )
        .await;
        let Err(e) = reg.probe(&h, 0, 8, true).await else {
            panic!("a 429 probe must fail");
        };
        assert!(
            matches!(
                e,
                StreamError::RateLimited {
                    retry_after_ms: Some(ms),
                    ..
                } if ms == ask
            ),
            "error keeps the provider's real ask"
        );
        let cap = reg.config.rate_limit_cooldown_cap;
        let remaining = session_of(&reg, &h)
            .cooldown_remaining()
            .unwrap_or_else(|| panic!("a 429 must stake a cooldown"));
        assert!(remaining <= cap, "stake {remaining:?} exceeds cap {cap:?}");
        // The window ends at the cap: once it elapses a fetch leg
        // runs again instead of owing the provider's full ask.
        tokio::time::sleep(cap + Duration::from_millis(50)).await;
        let read = reg
            .probe(&h, 0, 8, true)
            .await
            .unwrap_or_else(|e| panic!("post-cap probe: {e}"));
        assert_eq!(read.bytes.len(), 8);
    }

    /// `chunk_bytes` 0 is a degenerate config the probe must survive:
    /// `u64::clamp(1, 0)` panics. The request bounds at one byte and
    /// the hole answer is the usual `fetch: false` shape.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn probe_survives_zero_chunk_bytes() {
        let d = TestDir::new("probe0chunk");
        let mut cfg = test_config(&d);
        cfg.head_bytes = 0;
        cfg.chunk_bytes = 0;
        let (reg, h) = probed(cfg, Vec::new()).await;
        let read = reg
            .probe(&h, 0, 8, false)
            .await
            .unwrap_or_else(|e| panic!("probe: {e}"));
        assert!(read.bytes.is_empty() && !read.eof);
    }
}
