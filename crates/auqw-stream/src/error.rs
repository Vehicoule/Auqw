//! Typed errors for the stream seam.
//!
//! The taxonomy mirrors the ABI error kinds plus the seam's own
//! lifecycle kinds (`released`, `superseded`, `evicted`). Every variant
//! carries a kebab-case [`StreamError::kind`] string so the player port
//! can classify without parsing messages.

use thiserror::Error;

/// A failure anywhere in the stream seam.
///
/// Invariant: no variant's text ever contains a signed stream URL —
/// messages carry kinds, offsets, and statuses only. `message` fields
/// must be built from host-trusted or already-redacted text.
#[derive(Debug, Clone, Error)]
pub enum StreamError {
    /// The invocation was cancelled (`cancel`, or the session ended
    /// under an in-flight read).
    #[error("cancelled")]
    Cancelled,
    /// `release` ended the session.
    #[error("released")]
    Released,
    /// A newer `prepare` superseded this unattached session.
    #[error("superseded by a newer prepare")]
    Superseded,
    /// The session was evicted (TTL abandon or cache cleanup).
    #[error("evicted")]
    Evicted,
    /// The signed URL is past its expiry margin, or a hole was read on
    /// a session that can no longer mint.
    #[error("expired")]
    Expired,
    /// Retryable transport or upstream failure. `message` carries
    /// offsets/statuses, never URLs.
    #[error("transient: {message}")]
    Transient {
        /// Failure detail.
        message: String,
    },
    /// The upstream rate-limited the request (HTTP 429).
    #[error("rate-limit: {message}")]
    RateLimited {
        /// Failure detail.
        message: String,
    },
    /// The provider capped the stream (repeated `403`/`416`) and the
    /// re-mint or zero-progress budget ran out.
    #[error("streams-capped: {message}")]
    StreamsCapped {
        /// Failure detail.
        message: String,
    },
    /// A response violated the seam's wire rules (non-`206` answer to a
    /// range request, bad `Content-Range`, unstable total length,
    /// empty or oversized body, mime swap on re-mint).
    #[error("invalid-response: {message}")]
    InvalidResponse {
        /// Failure detail.
        message: String,
    },
    /// Host-side failure: cache I/O, runtime, or configuration.
    #[error("internal: {message}")]
    Internal {
        /// Failure detail.
        message: String,
    },
    /// The handle names no live session.
    #[error("not-found")]
    NotFound,
}

impl StreamError {
    /// The kebab-case error-kind string for the port taxonomy.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Released => "released",
            Self::Superseded => "superseded",
            Self::Evicted => "evicted",
            Self::Expired => "expired",
            Self::Transient { .. } => "transient",
            Self::RateLimited { .. } => "rate-limit",
            Self::StreamsCapped { .. } => "streams-capped",
            Self::InvalidResponse { .. } => "invalid-response",
            Self::Internal { .. } => "internal",
            Self::NotFound => "not-found",
        }
    }

    /// The failure detail without the kind prefix — the variant's own
    /// message, or the kind itself for fieldless variants. Boundaries
    /// render `{kind}: {detail}`; using `Display` there would double
    /// the kind (`"transient: transient: msg"`).
    #[must_use]
    pub fn detail(&self) -> String {
        match self {
            Self::Transient { message }
            | Self::RateLimited { message }
            | Self::StreamsCapped { message }
            | Self::InvalidResponse { message }
            | Self::Internal { message } => message.clone(),
            _ => self.kind().to_string(),
        }
    }
}

/// Lock a mutex, mapping poisoning to [`StreamError::Internal`].
pub(crate) fn lock<T>(
    m: &std::sync::Mutex<T>,
) -> Result<std::sync::MutexGuard<'_, T>, StreamError> {
    m.lock().map_err(|_| StreamError::Internal {
        message: "lock poisoned".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_kebab_case() {
        let cases = [
            (StreamError::Cancelled, "cancelled"),
            (StreamError::Released, "released"),
            (StreamError::Superseded, "superseded"),
            (StreamError::Evicted, "evicted"),
            (StreamError::Expired, "expired"),
            (
                StreamError::Transient {
                    message: "x".into(),
                },
                "transient",
            ),
            (
                StreamError::RateLimited {
                    message: "x".into(),
                },
                "rate-limit",
            ),
            (
                StreamError::StreamsCapped {
                    message: "x".into(),
                },
                "streams-capped",
            ),
            (
                StreamError::InvalidResponse {
                    message: "x".into(),
                },
                "invalid-response",
            ),
            (
                StreamError::Internal {
                    message: "x".into(),
                },
                "internal",
            ),
            (StreamError::NotFound, "not-found"),
        ];
        for (e, kind) in cases {
            assert_eq!(e.kind(), kind);
            assert!(!e.to_string().contains("http"), "{e}");
        }
    }
}
