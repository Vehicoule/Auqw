//! Host services handed to a plugin invocation. Everything a guest can
//! reach outside its sandbox arrives through these ports — the guest
//! itself only emits `host_request` step messages.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::http::HttpClient;
use crate::kv::KeyValueStore;

/// The host-provided ports one invocation may use.
pub struct HostServices<'a> {
    /// Performs the guest's authorized outbound HTTP.
    pub http: &'a dyn HttpClient,
    /// Per-plugin KV namespace snapshots and commits — `Arc` so an
    /// invocation can hand the call to the blocking pool instead of
    /// stalling a runtime worker on file I/O.
    pub kv: Arc<dyn KeyValueStore>,
    /// Wall clock backing `now_ms` requests.
    pub clock: &'a dyn HostClock,
    /// Base URL of a bgutil-compatible PO-token service
    /// (`POST {provider}/get_pot`); `None` leaves `pot_token` requests
    /// answered `unsupported`.
    pub pot_provider: Option<&'a str>,
}

/// Wall clock for `now_ms` host requests.
pub trait HostClock: Send + Sync {
    /// Epoch milliseconds now.
    fn now_ms(&self) -> u64;
}

/// [`HostClock`] over the system wall clock.
pub struct SystemClock;

impl HostClock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0)
    }
}
