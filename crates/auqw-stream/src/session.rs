//! One stream session: the shared state readers park on, the pump's
//! mint bookkeeping, and the lock-order rules that keep the blocking
//! bridge deadlock-free.
//!
//! Lock order (the only nestings allowed): the registry's `sessions`
//! map is outermost, then `shared` → `store` or `shared` → `core`.
//! `store` and `core` guards are never held while taking another lock.
//! Readers wait on `readers` with the `shared` guard; producers commit
//! store writes first, then take `shared` to record marks and notify —
//! so a reader either sees the extent or is already parked when the
//! notify lands.

use std::collections::BTreeSet;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::error::{lock, StreamError};
use crate::marks::{now_ms, PhaseMarks};
use crate::store::{SessionPaths, SidecarMeta, SparseStore};
use crate::{PreparedSource, Remint, StreamConfig};

/// State readers and lifecycle calls mutate behind `shared`.
pub(crate) struct Shared {
    /// First terminal error wins; every later `terminate` is a no-op.
    pub terminal: Option<StreamError>,
    /// A consumer has attached; attached sessions are exempt from
    /// supersede and fill ahead of `read_pos` instead of `head_bytes`.
    pub attached: bool,
    /// Consumer read frontier — drives the read-ahead window.
    pub read_pos: u64,
    /// Demand-read positions awaiting fetch-through (deduped set;
    /// removed when the fetch commits, kept while in flight).
    pub fetch_through: BTreeSet<u64>,
    /// Confirmed end-of-stream ceiling: `416` evidence that nothing
    /// exists at or above this offset when the total length is unknown.
    pub eof_below: Option<u64>,
    /// Bytes written to the store — the progress meter for
    /// zero-progress re-mint aborts.
    pub committed: u64,
    /// Lifecycle marks.
    pub marks: PhaseMarks,
}

/// Mint bookkeeping: the current source plus the budgets that bound
/// cap-death recovery (`403`/`416` → re-mint + resume).
pub(crate) struct PumpCore {
    /// Current mint; `url`/`expires_at_ms`/`content_length` are
    /// replaced on each successful re-mint. Never logged.
    pub source: PreparedSource,
    /// MIME captured at prepare; a re-mint that changes it is a
    /// terminal `InvalidResponse` — a silent container swap is a bug.
    pub pinned_mime: String,
    /// Host-supplied re-resolve for the same `source_ref`.
    pub remint: Arc<dyn Remint>,
    /// Re-mints performed (bounded by `StreamConfig::mint_budget`).
    pub mints_used: u32,
    /// Consecutive re-mints that produced no new bytes (bounded by
    /// `max_zero_progress_mints`).
    pub zero_progress: u32,
    /// `Shared::committed` snapshot taken at the last re-mint.
    pub committed_at_mint: u64,
}

/// What the pump should do next, computed under `shared`+`store`.
pub(crate) enum Action {
    /// Terminal state or fully covered file — the pump exits.
    Stop,
    /// Nothing to fetch right now; park until notified.
    Park,
    /// Fetch `len` bytes at `offset`. `through` marks demand reads
    /// (fetch-through): they outrank speculative fill and are never
    /// preempted by newer demand reads.
    Fetch {
        /// Range start.
        offset: u64,
        /// Max bytes to request.
        len: u64,
        /// Demand-driven fetch-through vs speculative fill.
        through: bool,
    },
}

/// One stream session's shared state and file backing.
pub(crate) struct SessionInner {
    /// Cache file locations (the handle is the filename stem and the
    /// registry's map key — the session does not need it again).
    pub paths: SessionPaths,
    /// Static sidecar fields.
    pub meta: SidecarMeta,
    /// Tuning knobs (copied from the registry config).
    pub config: StreamConfig,
    /// Extent store — innermost lock only.
    pub store: Mutex<SparseStore>,
    /// Reader-visible state — the condvar mutex.
    pub shared: Mutex<Shared>,
    /// Mint bookkeeping.
    pub core: Mutex<PumpCore>,
    /// Readers park here; every commit and every terminal transition
    /// signals it.
    pub readers: Condvar,
    /// General pump wake (attach, read advance, terminal).
    pub pump_notify: Notify,
    /// Fetch-through arrivals — preempts in-flight speculative fill.
    pub ft_notify: Notify,
    /// Cooperative abort for in-flight requests and re-mints.
    pub cancel: CancellationToken,
    /// The spawned pump task, aborted on terminate.
    pub task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Creation instant for the prepare TTL.
    pub created: Instant,
}

impl SessionInner {
    /// Build the session files and in-memory state; writes the initial
    /// (empty-extents) sidecar so a crash leaves a valid pair.
    pub(crate) fn new(
        handle: String,
        source: PreparedSource,
        remint: Arc<dyn Remint>,
        config: StreamConfig,
    ) -> Result<Arc<Self>, StreamError> {
        let paths = SessionPaths::new(&config.cache_dir, &handle);
        let mut store = SparseStore::create(&paths, source.content_length)?;
        let meta = SidecarMeta {
            source_ref: source.source_ref.clone(),
            mime: source.mime.clone(),
            itag: source.itag,
            bitrate_kbps: source.bitrate_kbps,
            expires_at_ms: source.expires_at_ms,
        };
        store.persist(&paths, &meta)?;
        Ok(Arc::new(Self {
            paths,
            meta,
            config,
            store: Mutex::new(store),
            shared: Mutex::new(Shared {
                terminal: None,
                attached: false,
                read_pos: 0,
                fetch_through: BTreeSet::new(),
                eof_below: None,
                committed: 0,
                marks: PhaseMarks {
                    prepare_started_ms: now_ms(),
                    ..PhaseMarks::default()
                },
            }),
            core: Mutex::new(PumpCore {
                pinned_mime: source.mime.clone(),
                source,
                remint,
                mints_used: 0,
                zero_progress: 0,
                committed_at_mint: 0,
            }),
            readers: Condvar::new(),
            pump_notify: Notify::new(),
            ft_notify: Notify::new(),
            cancel: CancellationToken::new(),
            task: Mutex::new(None),
            created: Instant::now(),
        }))
    }

    /// Clone of the terminal error, if the session has ended.
    pub(crate) fn terminal_err(&self) -> Option<StreamError> {
        lock(&self.shared).ok().and_then(|sh| sh.terminal.clone())
    }

    /// Whether the session is still live (for the supersede scan).
    pub(crate) fn is_terminal(&self) -> bool {
        self.terminal_err().is_some()
    }

    /// Whether a consumer is attached (for the supersede scan).
    pub(crate) fn is_attached(&self) -> bool {
        lock(&self.shared).map(|sh| sh.attached).unwrap_or(false)
    }

    /// Enter terminal state: first error wins, parked readers wake into
    /// it, in-flight work is aborted, and the partial file is evicted
    /// (v1 pins nothing offline).
    pub(crate) fn terminate(&self, e: StreamError) {
        {
            let Ok(mut sh) = lock(&self.shared) else {
                return;
            };
            if sh.terminal.is_some() {
                return;
            }
            sh.terminal = Some(e);
        }
        self.cancel.cancel();
        self.readers.notify_all();
        self.pump_notify.notify_one();
        if let Ok(mut t) = self.task.lock() {
            if let Some(h) = t.take() {
                h.abort();
            }
        }
        self.paths.evict();
    }

    /// The URL the pump fetches next (current mint).
    pub(crate) fn current_url(&self) -> Result<String, StreamError> {
        Ok(lock(&self.core)?.source.url.clone())
    }

    /// The host re-mint closure.
    pub(crate) fn remint_fn(&self) -> Result<Arc<dyn Remint>, StreamError> {
        Ok(Arc::clone(&lock(&self.core)?.remint))
    }

    /// Live check for pump fetch points.
    pub(crate) fn check_live(&self) -> Result<(), StreamError> {
        match self.terminal_err() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Best-known total length (wire `Content-Range` wins over the
    /// resolve-time `content_length` hint).
    pub(crate) fn effective_total(&self) -> Result<Option<u64>, StreamError> {
        Ok(lock(&self.store)?.effective_total())
    }

    /// Record a wire total; a changed total across chunks is a wire-rule
    /// violation (`InvalidResponse`), not a silent update.
    pub(crate) fn check_total(&self, total: u64) -> Result<(), StreamError> {
        let mut store = lock(&self.store)?;
        if let Some(prev) = store.wire_total() {
            if prev != total {
                return Err(StreamError::InvalidResponse {
                    message: format!("total length changed {prev} -> {total}"),
                });
            }
        }
        store.set_total(total);
        Ok(())
    }

    /// Bookkeep a re-mint attempt: the session mint budget and the
    /// zero-progress counter are enforced here.
    pub(crate) fn begin_mint(&self) -> Result<(), StreamError> {
        let sh = lock(&self.shared)?;
        let mut core = lock(&self.core)?;
        if core.mints_used > 0 {
            if sh.committed == core.committed_at_mint {
                core.zero_progress += 1;
                if core.zero_progress > self.config.max_zero_progress_mints {
                    return Err(StreamError::StreamsCapped {
                        message: format!("{} re-mints made no progress", core.zero_progress),
                    });
                }
            } else {
                core.zero_progress = 0;
            }
        }
        core.committed_at_mint = sh.committed;
        core.mints_used += 1;
        if core.mints_used > self.config.mint_budget {
            return Err(StreamError::StreamsCapped {
                message: format!("re-mint budget {} exhausted", self.config.mint_budget),
            });
        }
        Ok(())
    }

    /// Adopt a re-minted source. The MIME pin is enforced: a re-mint
    /// that returns a different container is terminal, never a silent
    /// swap. Returns the source to install only when it passes.
    pub(crate) fn finish_mint(
        &self,
        source: PreparedSource,
        elapsed: Duration,
    ) -> Result<(), StreamError> {
        let mut sh = lock(&self.shared)?;
        let mut core = lock(&self.core)?;
        if source.mime != core.pinned_mime {
            return Err(StreamError::InvalidResponse {
                message: format!(
                    "re-mint changed mime {} -> {}",
                    core.pinned_mime, source.mime
                ),
            });
        }
        if let Some(len) = source.content_length {
            lock(&self.store)?.set_hint(len);
        }
        let url = source.url;
        core.source.url = url;
        core.source.expires_at_ms = source.expires_at_ms;
        core.source.content_length = source.content_length;
        sh.marks.mint_ms = Some(u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX));
        Ok(())
    }

    /// Commit fetched bytes: extent merge, marks, sidecar flush at
    /// milestones, then wake parked readers. Store work happens before
    /// the `shared` guard is taken (see module lock order).
    pub(crate) fn commit(
        &self,
        offset: u64,
        bytes: &[u8],
        through: Option<u64>,
    ) -> Result<(), StreamError> {
        let head_covered = {
            let mut store = lock(&self.store)?;
            store.insert(offset, bytes)?;
            store.head_covered(self.config.head_bytes)
        };
        let mut sh = lock(&self.shared)?;
        if let Some(p) = through {
            sh.fetch_through.remove(&p);
        }
        sh.committed += bytes.len() as u64;
        if sh.marks.first_byte_ms.is_none() {
            sh.marks.first_byte_ms = Some(now_ms());
        }
        let became_ready = head_covered && sh.marks.head_ready_ms.is_none();
        if became_ready {
            sh.marks.head_ready_ms = Some(now_ms());
        }
        let due = lock(&self.store)?.persist_due();
        if became_ready || due {
            lock(&self.store)?.persist(&self.paths, &self.meta)?;
        }
        drop(sh);
        self.readers.notify_all();
        Ok(())
    }

    /// Note a confirmed end-of-stream ceiling (`416` evidence) and wake
    /// readers parked at or above it.
    pub(crate) fn mark_eof_below(&self, at: u64) {
        if let Ok(mut sh) = lock(&self.shared) {
            sh.eof_below = Some(sh.eof_below.map_or(at, |b| b.min(at)));
        }
        self.readers.notify_all();
        self.pump_notify.notify_one();
    }

    /// The pump's next action — fetch-through first (demand reads
    /// outrank speculative fill), then the fill window, then park.
    pub(crate) fn next_action(&self) -> Result<Action, StreamError> {
        let mut sh = lock(&self.shared)?;
        if sh.terminal.is_some() {
            return Ok(Action::Stop);
        }
        let store = lock(&self.store)?;
        let total = store.effective_total();
        if total.is_some_and(|t| store.first_gap(0, t).is_none()) {
            return Ok(Action::Stop);
        }
        if let Some(&pos) = sh.fetch_through.iter().next() {
            return Ok(Action::Fetch {
                offset: pos,
                len: self.config.chunk_bytes,
                through: true,
            });
        }
        let (lo, mut bound) = if sh.attached {
            (
                sh.read_pos,
                sh.read_pos.saturating_add(self.config.read_ahead),
            )
        } else {
            (0, self.config.head_bytes)
        };
        if let Some(t) = total {
            bound = bound.min(t);
        }
        if let Some(b) = sh.eof_below {
            bound = bound.min(b);
        }
        match store.first_gap(lo, bound) {
            Some(gap) => Ok(Action::Fetch {
                offset: gap,
                len: (bound - gap).min(self.config.chunk_bytes),
                through: false,
            }),
            None => {
                if !sh.attached && sh.marks.head_ready_ms.is_none() {
                    sh.marks.head_ready_ms = Some(now_ms());
                }
                Ok(Action::Park)
            }
        }
    }

    /// `attach` marks the consumer live: exempt from supersede, the
    /// fill bound switches from `head_bytes` to the read-ahead window,
    /// and expiry/TTL are enforced — a stale prepare ends `Expired`.
    pub(crate) fn attach(&self, position: u64) -> Result<Option<u64>, StreamError> {
        {
            let mut sh = lock(&self.shared)?;
            if let Some(e) = &sh.terminal {
                return Err(e.clone());
            }
            let core = lock(&self.core)?;
            if let Some(exp) = core.source.expires_at_ms {
                let margin =
                    u64::try_from(self.config.expiry_margin.as_millis()).unwrap_or(u64::MAX);
                if now_ms().saturating_add(margin) >= exp {
                    drop(core);
                    drop(sh);
                    self.terminate(StreamError::Expired);
                    return Err(StreamError::Expired);
                }
            }
            if self.created.elapsed() >= self.config.prepare_ttl {
                drop(core);
                drop(sh);
                self.terminate(StreamError::Expired);
                return Err(StreamError::Expired);
            }
            sh.attached = true;
            sh.read_pos = position;
            if sh.marks.attach_ms.is_none() {
                sh.marks.attach_ms = Some(now_ms());
            }
        }
        self.pump_notify.notify_one();
        self.effective_total()
            .map(|t| t.map(|t| t.saturating_sub(position)))
    }

    /// `close` detaches the consumer; the session stays live for
    /// re-attach and becomes supersedable again. Idempotent.
    pub(crate) fn close(&self) {
        if let Ok(mut sh) = lock(&self.shared) {
            sh.attached = false;
        }
    }

    /// Blocking read for foreign (JNI) threads — see the crate-level
    /// invariant: this parks the calling thread on a `Condvar`, so it
    /// must never run on a runtime worker. Empty `Vec` means EOF
    /// (`position` at or past the known end, or a confirmed `416`
    /// ceiling). Every terminal transition wakes into its typed error;
    /// `read_deadline` bounds the whole call into `Transient`.
    pub(crate) fn read(&self, position: u64, max_len: u64) -> Result<Vec<u8>, StreamError> {
        if max_len == 0 {
            return Ok(Vec::new());
        }
        let deadline = Instant::now() + self.config.read_deadline;
        let mut sh = lock(&self.shared)?;
        loop {
            if let Some(e) = &sh.terminal {
                return Err(e.clone());
            }
            if let Some(served) = self.try_serve(&mut sh, position, max_len)? {
                return Ok(served);
            }
            self.queue_through(&mut sh, position);
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(StreamError::Transient {
                    message: format!(
                        "read deadline {}ms exceeded at offset {position}",
                        self.config.read_deadline.as_millis()
                    ),
                });
            }
            let (guard, _) =
                self.readers
                    .wait_timeout(sh, remaining)
                    .map_err(|_| StreamError::Internal {
                        message: "lock poisoned".into(),
                    })?;
            sh = guard;
        }
    }

    /// Serve `position` from the store under `shared` (store is the
    /// inner lock). `Some(vec![])` is EOF, `Some(bytes)` a hit,
    /// `None` a hole.
    fn try_serve(
        &self,
        sh: &mut Shared,
        position: u64,
        max_len: u64,
    ) -> Result<Option<Vec<u8>>, StreamError> {
        let mut store = lock(&self.store)?;
        if store.covers(position) {
            let bytes = store.read_at(position, max_len)?;
            sh.read_pos = sh.read_pos.max(position + bytes.len() as u64);
            drop(store);
            self.pump_notify.notify_one();
            return Ok(Some(bytes));
        }
        if store.effective_total().is_some_and(|t| position >= t) {
            return Ok(Some(Vec::new()));
        }
        if sh.eof_below.is_some_and(|b| position >= b) {
            return Ok(Some(Vec::new()));
        }
        Ok(None)
    }

    /// Register a demand read at `position` and wake the pump.
    fn queue_through(&self, sh: &mut Shared, position: u64) {
        if sh.fetch_through.insert(position) {
            self.ft_notify.notify_one();
            self.pump_notify.notify_one();
        }
        sh.read_pos = sh.read_pos.max(position);
    }
}
