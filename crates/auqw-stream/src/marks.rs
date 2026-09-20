//! Phase marks: epoch-millisecond timestamps plus durations so the
//! player port can join intent → prepared → attached → rendered.

/// Lifecycle marks for one stream session.
///
/// `*_ms` epoch fields are wall-clock epoch milliseconds (suitable for
/// joining with JS-side marks); `resolve_ms`/`mint_ms` are durations.
/// `None` means the phase has not happened. The signed URL is never
/// part of any mark.
#[derive(Debug, Clone, Default)]
pub struct PhaseMarks {
    /// Epoch ms when `prepare` registered the session.
    pub prepare_started_ms: u64,
    /// Duration of the `playback.resolve` that minted the source, when
    /// reported through [`crate::StreamRegistry::prepare_timed`].
    pub resolve_ms: Option<u64>,
    /// Duration of the most recent successful re-mint inside the pump.
    pub mint_ms: Option<u64>,
    /// Epoch ms when the first byte landed in the store.
    pub first_byte_ms: Option<u64>,
    /// Epoch ms when the head-fill bound (`head_bytes`) was covered.
    pub head_ready_ms: Option<u64>,
    /// Epoch ms of the first `attach`.
    pub attach_ms: Option<u64>,
}

/// Epoch milliseconds now (system clock).
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}
