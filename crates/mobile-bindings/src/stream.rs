//! The streaming-seam surface of the UniFFI boundary.
//!
//! `start_prepare` runs a `playback.resolve` through the normal
//! invocation path and registers the result with the seam's registry;
//! the `stream_*` calls are the player's synchronous session surface
//! (attach, blocking read, close, release, marks). All behavior lives
//! in `auqw-host-surface` — this file maps its outcomes onto UniFFI
//! records and delegates. The signed URL never crosses this boundary —
//! outcomes carry handles and metadata only.

use auqw_host_surface as surface;
use thiserror::Error;

use crate::{AttemptSummary, HostError, PluginHost};

/// A prepared stream session as reported to the player: the opaque
/// handle plus metadata. The signed URL never crosses this boundary.
#[derive(uniffi::Record)]
pub struct PreparedStream {
    /// Opaque session handle for `stream_open`/`stream_read`/...
    pub handle: String,
    /// MIME type; pinned across re-mints.
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

impl From<surface::PreparedStream> for PreparedStream {
    fn from(s: surface::PreparedStream) -> Self {
        Self {
            handle: s.handle,
            mime: s.mime,
            itag: s.itag,
            bitrate_kbps: s.bitrate_kbps,
            content_length: s.content_length,
            expires_at_ms: s.expires_at_ms,
        }
    }
}

/// Terminal outcome of one `start_prepare` invocation.
#[derive(uniffi::Enum)]
pub enum PrepareOutcome {
    /// The resolve produced a source and the seam registered it.
    Prepared {
        /// The prepared session handle + metadata.
        stream: PreparedStream,
        /// Handles this prepare superseded or pruned — the caller's
        /// handle routing must drop these so a dead session's entry
        /// can never serve a later attach.
        superseded: Vec<String>,
        /// Invocation accounting for the resolve.
        attempt: AttemptSummary,
    },
    /// The resolve or the seam registration failed.
    Failed {
        /// Taxonomy kind (`no-result`, `cancelled`, ...).
        kind: String,
        /// Human-readable detail (never contains the URL).
        message: String,
        /// Invocation accounting for the resolve.
        attempt: AttemptSummary,
    },
}

impl From<surface::PrepareOutcome> for PrepareOutcome {
    fn from(o: surface::PrepareOutcome) -> Self {
        match o {
            surface::PrepareOutcome::Prepared {
                stream,
                superseded,
                attempt,
            } => Self::Prepared {
                stream: stream.into(),
                superseded,
                attempt: attempt.into(),
            },
            surface::PrepareOutcome::Failed {
                kind,
                message,
                attempt,
            } => Self::Failed {
                kind,
                message,
                attempt: attempt.into(),
            },
        }
    }
}

/// Receives the terminal outcome of [`PluginHost::start_prepare`].
#[uniffi::export(callback_interface)]
pub trait PrepareListener: Send + Sync {
    /// Called exactly once per request, on a runtime worker thread.
    fn on_outcome(&self, request_id: String, outcome: PrepareOutcome);
}

/// Errors raised synchronously by the `stream_*` calls.
///
/// Field names avoid `message` for the same reason as [`HostError`].
#[derive(uniffi::Error, Error, Debug)]
pub enum StreamError {
    /// `HostConfig.stream_path` was unset — the seam is not running.
    #[error("stream seam unavailable (stream_path unset)")]
    Unavailable,
    /// The session operation failed; `kind` is the ABI taxonomy.
    #[error("{kind}: {detail}")]
    Failed {
        /// Kebab-case error kind.
        kind: String,
        /// Failure detail (never contains the signed URL).
        detail: String,
    },
}

impl From<surface::StreamError> for StreamError {
    fn from(e: surface::StreamError) -> Self {
        match e {
            surface::StreamError::Unavailable => Self::Unavailable,
            surface::StreamError::Failed { kind, detail } => Self::Failed { kind, detail },
        }
    }
}

/// Lifecycle marks for one stream session: epoch-ms timestamps plus
/// durations, for joining intent → prepared → attached → rendered.
#[derive(uniffi::Record)]
pub struct StreamPhaseMarks {
    /// Epoch ms when `prepare` registered the session.
    pub prepare_started_ms: u64,
    /// Duration of the minting `playback.resolve`, when known.
    pub resolve_ms: Option<u64>,
    /// Duration of the most recent re-mint, when one ran.
    pub mint_ms: Option<u64>,
    /// Epoch ms when the first byte landed.
    pub first_byte_ms: Option<u64>,
    /// Epoch ms when the head-fill bound was covered.
    pub head_ready_ms: Option<u64>,
    /// Epoch ms of the first attach.
    pub attach_ms: Option<u64>,
}

impl From<surface::StreamPhaseMarks> for StreamPhaseMarks {
    fn from(m: surface::StreamPhaseMarks) -> Self {
        Self {
            prepare_started_ms: m.prepare_started_ms,
            resolve_ms: m.resolve_ms,
            mint_ms: m.mint_ms,
            first_byte_ms: m.first_byte_ms,
            head_ready_ms: m.head_ready_ms,
            attach_ms: m.attach_ms,
        }
    }
}

#[uniffi::export]
impl PluginHost {
    /// Resolve `source_ref` and register the result as a prepared
    /// stream session (bounded speculative head fill). The outcome —
    /// including the opaque stream handle — arrives on `listener`.
    ///
    /// # Errors
    /// [`HostError::UnknownPlugin`] if `plugin_id` was never loaded;
    /// [`HostError::Runtime`] when the seam is not configured.
    pub fn start_prepare(
        &self,
        plugin_id: String,
        source_ref: String,
        listener: Box<dyn PrepareListener>,
    ) -> Result<String, HostError> {
        let request_id = self.next_request_id();
        self.inner.start_prepare(
            plugin_id,
            source_ref,
            request_id.clone(),
            move |request_id, outcome| async move {
                listener.on_outcome(request_id, outcome.into());
            },
        )?;
        Ok(request_id)
    }

    /// Attach a consumer at `position` (DataSource open). Returns
    /// `content_length - position` when the stream total is known.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] with the session's kind otherwise.
    pub fn stream_open(&self, handle: String, position: u64) -> Result<Option<u64>, StreamError> {
        self.inner
            .stream_open(handle, position)
            .map_err(StreamError::from)
    }

    /// Blocking read — **foreign (JNI/DataSource) threads only**;
    /// parking a runtime worker is a bug. Empty bytes = EOF. Bounded by
    /// the seam's read deadline; terminal transitions wake into their
    /// typed error.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] with the session's kind otherwise.
    pub fn stream_read(
        &self,
        handle: String,
        position: u64,
        max_len: u64,
    ) -> Result<Vec<u8>, StreamError> {
        self.inner
            .stream_read(handle, position, max_len)
            .map_err(StreamError::from)
    }

    /// DataSource close: detaches the consumer; the session stays live
    /// for re-attach.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] for an unknown handle.
    pub fn stream_close(&self, handle: String) -> Result<(), StreamError> {
        self.inner.stream_close(handle).map_err(StreamError::from)
    }

    /// Terminal release: parked readers unwind `released`, in-flight
    /// work aborts, the partial file is evicted. Idempotent.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured.
    pub fn stream_release(&self, handle: String) -> Result<(), StreamError> {
        self.inner.stream_release(handle).map_err(StreamError::from)
    }

    /// The session's lifecycle marks — available even after terminal
    /// states.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] for an unknown handle.
    pub fn stream_phase_marks(&self, handle: String) -> Result<StreamPhaseMarks, StreamError> {
        self.inner
            .stream_phase_marks(handle)
            .map(StreamPhaseMarks::from)
            .map_err(StreamError::from)
    }

    /// Dev-gate entry: register a session for a bare URL, skipping the
    /// guest `playback.resolve` (same convention as the Kotlin
    /// `devAttachFile`). Everything downstream of resolve is the real
    /// path — sparse store, pump, fetch-through, marks — so the seam
    /// gates can be exercised while the provider's resolve is
    /// unreachable. Re-mint is pinned to fail `Expired` unless
    /// `remintable` opts the session into re-minting the same source —
    /// the fixture URL is its own provider, letting the forced-cap
    /// gate exercise the real 403 → re-mint → resume path on-device.
    /// A one-hour expiry keeps it out of the measured window.
    ///
    /// # Errors
    /// [`StreamError::Unavailable`] when the seam is not configured;
    /// [`StreamError::Failed`] with the prepare's kind otherwise.
    pub fn dev_prepare_url(
        &self,
        url: String,
        mime: String,
        content_length: Option<u64>,
        remintable: bool,
    ) -> Result<PreparedStream, StreamError> {
        self.inner
            .dev_prepare_url(url, mime, content_length, remintable)
            .map(PreparedStream::from)
            .map_err(StreamError::from)
    }
}
