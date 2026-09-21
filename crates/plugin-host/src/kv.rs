//! Per-plugin key/value storage. Namespaces are isolated by plugin id;
//! invocations stage writes and commit them only on a valid `done`
//! result. The store holds plugin state only — credentials never
//! belong here by policy.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

use crate::error::KvError;
use crate::redact::redact_text;

/// KV key cap, in UTF-8 bytes.
pub(crate) const MAX_KV_KEY_BYTES: usize = 128;
/// Decoded KV value cap (64 KiB).
pub(crate) const MAX_KV_VALUE_BYTES: usize = 64 * 1024;
/// Committed namespace cap per plugin: keys + values, 256 KiB.
pub(crate) const MAX_KV_NAMESPACE_BYTES: usize = 256 * 1024;

/// Snapshot/commit port for one plugin's KV namespace.
pub trait KeyValueStore: Send + Sync {
    /// The plugin's committed key/value pairs.
    ///
    /// # Errors
    /// [`KvError`] on backend failure.
    fn snapshot(&self, plugin_id: &str) -> Result<BTreeMap<String, Vec<u8>>, KvError>;

    /// Atomically apply a staged patch to the current committed
    /// namespace: `Some(bytes)` sets, `None` deletes. Disjoint writes
    /// staged by concurrent invocations both survive; last committer
    /// wins only for the same key.
    ///
    /// # Errors
    /// [`KvError::TooLarge`] when the resulting namespace would violate
    /// the size caps — nothing is committed. [`KvError`] on backend
    /// failure; the committed state is unchanged.
    fn commit(
        &self,
        plugin_id: &str,
        writes: BTreeMap<String, Option<Vec<u8>>>,
    ) -> Result<(), KvError>;
}

/// Per-plugin namespaces, each a key → bytes map.
type StoreMap = BTreeMap<String, BTreeMap<String, Vec<u8>>>;

/// The cap violation `ns` commits, if any — a detail message the
/// caller wraps in the typed error that fits its path. The store is
/// the final authority on caps: invocation-side checks are only early
/// feedback.
fn caps_violation(ns: &BTreeMap<String, Vec<u8>>) -> Option<String> {
    let mut total = 0usize;
    for (key, value) in ns {
        if key.is_empty() || key.len() > MAX_KV_KEY_BYTES {
            return Some(format!(
                "key {:?} violates the 128-byte cap",
                redact_text(key, &[])
            ));
        }
        if value.len() > MAX_KV_VALUE_BYTES {
            return Some(format!(
                "key {:?} value exceeds 64 KiB",
                redact_text(key, &[])
            ));
        }
        total += key.len() + value.len();
    }
    if total > MAX_KV_NAMESPACE_BYTES {
        return Some("namespace exceeds 256 KiB".into());
    }
    None
}

/// Apply `writes` to `ns` in place: `Some` sets, `None` deletes.
fn apply_patch(ns: &mut BTreeMap<String, Vec<u8>>, writes: BTreeMap<String, Option<Vec<u8>>>) {
    for (key, value) in writes {
        match value {
            Some(v) => {
                ns.insert(key, v);
            }
            None => {
                ns.remove(&key);
            }
        }
    }
}

/// Volatile [`KeyValueStore`] for hosts without a state path.
pub struct MemoryKeyValueStore {
    maps: Mutex<StoreMap>,
}

impl MemoryKeyValueStore {
    /// An empty in-memory store.
    #[must_use]
    pub fn new() -> Self {
        Self {
            maps: Mutex::new(BTreeMap::new()),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, StoreMap>, KvError> {
        self.maps
            .lock()
            .map_err(|_| KvError::Io("lock poisoned".into()))
    }
}

impl Default for MemoryKeyValueStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyValueStore for MemoryKeyValueStore {
    fn snapshot(&self, plugin_id: &str) -> Result<BTreeMap<String, Vec<u8>>, KvError> {
        Ok(self.lock()?.get(plugin_id).cloned().unwrap_or_default())
    }

    fn commit(
        &self,
        plugin_id: &str,
        writes: BTreeMap<String, Option<Vec<u8>>>,
    ) -> Result<(), KvError> {
        if writes.is_empty() {
            return Ok(());
        }
        let mut maps = self.lock()?;
        let mut ns = maps.get(plugin_id).cloned().unwrap_or_default();
        apply_patch(&mut ns, writes);
        if let Some(msg) = caps_violation(&ns) {
            return Err(KvError::TooLarge(msg));
        }
        if ns.is_empty() {
            maps.remove(plugin_id);
        } else {
            maps.insert(plugin_id.to_string(), ns);
        }
        Ok(())
    }
}

/// Durable [`KeyValueStore`]: one JSON file holding every plugin
/// namespace, values base64-encoded. Writes are serialized under a
/// mutex and land via a sibling temp file, `sync_all`, an atomic
/// rename, and a parent-directory sync. A malformed or over-cap
/// existing file is a typed error, never a silent reset.
pub struct FileKeyValueStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileKeyValueStore {
    /// Open the store at `path`; the file is created on first commit.
    ///
    /// # Errors
    /// [`KvError::Corrupt`] when the file exists but is not the store
    /// format or violates the size caps. [`KvError::Io`] on read
    /// failure.
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, KvError> {
        let store = Self {
            path: path.into(),
            lock: Mutex::new(()),
        };
        // Read eagerly so a corrupt store fails at startup, not inside
        // the first invocation that touches it.
        store.read_all()?;
        Ok(store)
    }

    fn guard(&self) -> Result<MutexGuard<'_, ()>, KvError> {
        self.lock
            .lock()
            .map_err(|_| KvError::Io("lock poisoned".into()))
    }

    fn read_all(&self) -> Result<StoreMap, KvError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(e) => return Err(KvError::Io(format!("{}: {e}", self.path.display()))),
        };
        let encoded: BTreeMap<String, BTreeMap<String, String>> = serde_json::from_slice(&bytes)
            .map_err(|e| KvError::Corrupt(format!("{}: {e}", self.path.display())))?;
        let mut out = BTreeMap::new();
        for (plugin_id, ns) in encoded {
            let mut values = BTreeMap::new();
            for (key, b64) in ns {
                let value = B64.decode(&b64).map_err(|e| {
                    KvError::Corrupt(format!("{}: {plugin_id}/{key}: {e}", self.path.display()))
                })?;
                values.insert(key, value);
            }
            if let Some(msg) = caps_violation(&values) {
                return Err(KvError::Corrupt(format!(
                    "{}: {plugin_id}: {msg}",
                    self.path.display()
                )));
            }
            out.insert(plugin_id, values);
        }
        Ok(out)
    }

    fn write_all(&self, map: &StoreMap) -> Result<(), KvError> {
        let encoded: BTreeMap<String, BTreeMap<String, String>> = map
            .iter()
            .map(|(plugin_id, ns)| {
                (
                    plugin_id.clone(),
                    ns.iter().map(|(k, v)| (k.clone(), B64.encode(v))).collect(),
                )
            })
            .collect();
        let json = serde_json::to_vec(&encoded).map_err(|e| KvError::Io(format!("encode: {e}")))?;
        // A unique sibling tmp per write: two store instances on one
        // path must not clobber each other's staging file (they'd still
        // last-writer-wins at rename — a documented one-store-per-path
        // assumption — but the committed file stays whole).
        static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let mut tmp_name = self.path.as_os_str().to_os_string();
        tmp_name.push(format!(
            ".tmp.{}.{}",
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let tmp = PathBuf::from(tmp_name);
        {
            let mut file = std::fs::File::create(&tmp)
                .map_err(|e| KvError::Io(format!("{}: {e}", tmp.display())))?;
            file.write_all(&json)
                .map_err(|e| KvError::Io(format!("{}: {e}", tmp.display())))?;
            file.sync_all()
                .map_err(|e| KvError::Io(format!("{}: {e}", tmp.display())))?;
        }
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| KvError::Io(format!("{}: {e}", self.path.display())))?;
        // The rename's directory entry needs its own sync — without it
        // a crash could still lose the committed file.
        if let Some(parent) = self.path.parent() {
            let dir = std::fs::File::open(parent)
                .map_err(|e| KvError::Io(format!("{}: {e}", parent.display())))?;
            dir.sync_all()
                .map_err(|e| KvError::Io(format!("{}: {e}", parent.display())))?;
        }
        Ok(())
    }
}

impl KeyValueStore for FileKeyValueStore {
    fn snapshot(&self, plugin_id: &str) -> Result<BTreeMap<String, Vec<u8>>, KvError> {
        let _guard = self.guard()?;
        Ok(self.read_all()?.get(plugin_id).cloned().unwrap_or_default())
    }

    fn commit(
        &self,
        plugin_id: &str,
        writes: BTreeMap<String, Option<Vec<u8>>>,
    ) -> Result<(), KvError> {
        if writes.is_empty() {
            return Ok(());
        }
        let _guard = self.guard()?;
        let mut all = self.read_all()?;
        let mut ns = all.get(plugin_id).cloned().unwrap_or_default();
        apply_patch(&mut ns, writes);
        if let Some(msg) = caps_violation(&ns) {
            return Err(KvError::TooLarge(msg));
        }
        if ns.is_empty() {
            all.remove(plugin_id);
        } else {
            all.insert(plugin_id.to_string(), ns);
        }
        self.write_all(&all)
    }
}
