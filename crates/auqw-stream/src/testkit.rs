//! Test-only helpers shared by the crate's unit tests: a per-test temp
//! cache dir and unique handles. Never compiled into the library.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::error::StreamError;
use crate::fetch::{BodyStream, Fetch, FetchResponse};
use crate::{PreparedSource, Remint, StreamConfig};

static UNIQUE: AtomicU64 = AtomicU64::new(0);

/// A unique suffix for handles/dirs within this process.
pub(crate) fn unique() -> u64 {
    UNIQUE.fetch_add(1, Ordering::Relaxed)
}

/// A temp dir removed on drop.
pub(crate) struct TestDir(PathBuf);

impl TestDir {
    /// Create `auqw-stream-<tag>-<pid>-<n>` under the system temp dir.
    pub(crate) fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "auqw-stream-{tag}-{}-{}",
            std::process::id(),
            unique()
        ));
        std::fs::create_dir_all(&p)
            .map(|_| Self(p))
            .unwrap_or_else(|e| panic!("mkdir {e}"))
    }

    /// The directory path.
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A small test config rooted at `dir`.
pub(crate) fn test_config(dir: &TestDir) -> StreamConfig {
    let mut c = StreamConfig::new(dir.path().to_path_buf());
    c.chunk_bytes = 128;
    c.head_bytes = 256;
    c.read_ahead = 512;
    c.stall = std::time::Duration::from_secs(2);
    c.read_deadline = std::time::Duration::from_secs(2);
    c.retry_backoff = std::time::Duration::from_millis(5);
    c
}

/// A one-chunk body stream.
pub(crate) fn stream_body(body: Vec<u8>) -> BodyStream {
    Box::pin(futures_util::stream::once(async move { Ok(body) }))
}

/// A `206` reply of `len` bytes of `0xAB` at `offset` against a
/// `total`-byte resource.
pub(crate) fn resp(status: u16, offset: u64, len: u64, total: u64) -> FetchResponse {
    let end = offset + len - 1;
    FetchResponse {
        status,
        content_range: Some(format!("bytes {offset}-{end}/{total}")),
        body: stream_body(vec![0xABu8; usize::try_from(len).unwrap_or(0)]),
    }
}

/// A fetch whose every call is answered from a script; requests are
/// recorded so tests can assert range requests at exact offsets.
pub(crate) struct ScriptedFetch {
    /// The remaining scripted answers — tests push replacements to
    /// extend a run mid-flight.
    pub(crate) steps: Mutex<VecDeque<Step>>,
    /// `(offset, max_len)` of each range request seen, in order —
    /// tests assert fetch behaviour off this directly.
    pub(crate) requests: Mutex<Vec<(u64, u64)>>,
}

/// One scripted answer to a fetch call.
pub(crate) enum Step {
    Reply(FetchResponse),
    Fail(StreamError),
    Hang,
}

impl ScriptedFetch {
    pub(crate) fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: Mutex::new(steps.into()),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl Fetch for ScriptedFetch {
    fn get_range<'a>(
        &'a self,
        _url: &'a str,
        offset: u64,
        max_len: u64,
        _stall: Duration,
        _deadline: Duration,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FetchResponse, StreamError>> + Send + 'a>,
    > {
        if let Ok(mut r) = self.requests.lock() {
            r.push((offset, max_len));
        }
        let step = self
            .steps
            .lock()
            .ok()
            .and_then(|mut s| s.pop_front())
            .unwrap_or(Step::Hang);
        Box::pin(async move {
            match step {
                Step::Reply(r) => Ok(r),
                Step::Fail(e) => Err(e),
                Step::Hang => std::future::pending().await,
            }
        })
    }
}

/// A re-mint that always answers the same canned source — server
/// tests never exercise the re-mint path.
pub(crate) struct StaticRemint;

impl Remint for StaticRemint {
    fn remint(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<PreparedSource, StreamError>> + Send>,
    > {
        Box::pin(async { Ok(source()) })
    }
}

/// The canned 1024-byte `audio/mp4` source every scripted session
/// serves.
pub(crate) fn source() -> PreparedSource {
    PreparedSource {
        url: "https://signed.example/s?sig=SECRET".into(),
        mime: "audio/mp4".into(),
        itag: Some(140),
        bitrate_kbps: Some(129),
        content_length: Some(1024),
        expires_at_ms: None,
        source_ref: "vid".into(),
        provider: "test".into(),
    }
}
