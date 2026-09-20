//! Test-only helpers shared by the crate's unit tests: a per-test temp
//! cache dir and unique handles. Never compiled into the library.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::StreamConfig;

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
