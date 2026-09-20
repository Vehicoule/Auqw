//! Sparse byte store: one backing file per session plus a persisted
//! extent map, so downloaded ranges are addressable at any offset and
//! crash leftovers settle honestly.
//!
//! Ordering invariant for crash honesty: file bytes are written and
//! `sync_data`'d *before* the sidecar that claims them is persisted, so
//! a persisted extent can never name bytes the file does not hold —
//! under-reporting is safe, over-reporting would be corruption.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::StreamError;

/// Number of chunk writes between sidecar flushes. Persisted extents
/// may lag the file by at most this many chunks; under-reporting is
/// the safe direction.
pub(crate) const PERSIST_EVERY_CHUNKS: u32 = 8;

/// The session files under `cache_dir`: `{handle}.bin` (data) and
/// `{handle}.json` (extent sidecar). `{handle}.json.tmp` is the
/// in-flight sidecar write.
#[derive(Debug, Clone)]
pub(crate) struct SessionPaths {
    /// Sparse backing file.
    pub data: PathBuf,
    /// Extent sidecar.
    pub sidecar: PathBuf,
    /// Temp sibling for atomic sidecar writes.
    pub tmp: PathBuf,
}

impl SessionPaths {
    /// Paths for `handle` inside `cache_dir`.
    pub(crate) fn new(cache_dir: &Path, handle: &str) -> Self {
        Self {
            data: cache_dir.join(format!("{handle}.bin")),
            sidecar: cache_dir.join(format!("{handle}.json")),
            tmp: cache_dir.join(format!("{handle}.json.tmp")),
        }
    }

    /// Remove all three files; missing files are fine.
    pub(crate) fn evict(&self) {
        for p in [&self.data, &self.sidecar, &self.tmp] {
            match std::fs::remove_file(p) {
                Ok(()) | Err(_) => {}
            }
        }
    }
}

/// Session metadata persisted in the sidecar. The signed URL is
/// deliberately absent — it must never reach disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Sidecar {
    /// Provider's source reference (not a secret).
    pub source_ref: String,
    /// Pinned MIME type.
    pub mime: String,
    /// Format itag when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub itag: Option<u32>,
    /// Bitrate hint when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
    /// Authoritative total length once the wire reported it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// URL expiry hint, epoch ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    /// Downloaded extents `[start, end)`, sorted and coalesced.
    pub extents: Vec<(u64, u64)>,
}

impl Sidecar {
    /// Parse and structurally validate a sidecar file.
    ///
    /// # Errors
    /// A `String` describing the corruption (path-free); a corrupt
    /// sidecar means the pair must be dropped, never trusted.
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
        let sidecar: Sidecar = serde_json::from_slice(&bytes).map_err(|e| format!("json: {e}"))?;
        let mut prev_end = 0u64;
        for (s, e) in &sidecar.extents {
            if s >= e {
                return Err(format!("extent [{s},{e}) is empty"));
            }
            if *s < prev_end {
                return Err(format!("extent [{s},{e}) overlaps or is unsorted"));
            }
            prev_end = *e;
        }
        if sidecar.total.is_some_and(|t| prev_end > t) {
            return Err("extents exceed declared total".into());
        }
        Ok(sidecar)
    }

    /// Persist via sibling temp file + `sync_all` + atomic rename +
    /// parent-dir sync — the same durability chain as the plugin KV.
    fn persist(&self, path: &Path, tmp: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec(self)?;
        {
            let mut f = File::create(tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
        }
        std::fs::rename(tmp, path)?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
}

/// One session's sparse byte store: the backing file plus the in-memory
/// extent map (`start → end`, exclusive, coalesced, non-overlapping).
pub(crate) struct SparseStore {
    file: File,
    extents: BTreeMap<u64, u64>,
    /// Authoritative total from a `Content-Range` wire response.
    total: Option<u64>,
    /// Guest-reported `content_length` hint, used until the wire
    /// answers a `Content-Range`.
    hint_total: Option<u64>,
    /// Chunk writes since the last sidecar flush.
    dirty: u32,
}

impl SparseStore {
    /// Create a fresh store on `paths.data` (truncating).
    pub(crate) fn create(
        paths: &SessionPaths,
        hint_total: Option<u64>,
    ) -> Result<Self, StreamError> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&paths.data)
            .map_err(|e| StreamError::Internal {
                message: format!("cache file: {e}"),
            })?;
        Ok(Self {
            file,
            extents: BTreeMap::new(),
            total: None,
            hint_total,
            dirty: 0,
        })
    }

    /// Whether any extent covers `pos`.
    pub(crate) fn covers(&self, pos: u64) -> bool {
        self.extents
            .range(..=pos)
            .next_back()
            .is_some_and(|(_, e)| *e > pos)
    }

    /// End of the extent containing `pos`, if covered.
    fn extent_end(&self, pos: u64) -> Option<u64> {
        self.extents
            .range(..=pos)
            .next_back()
            .and_then(|(_, e)| (*e > pos).then_some(*e))
    }

    /// Read up to `max_len` bytes at `pos`; the result is capped at the
    /// containing extent's end. Caller must check [`Self::covers`]
    /// first — an uncovered `pos` is a bug, not an EOF.
    pub(crate) fn read_at(&mut self, pos: u64, max_len: u64) -> Result<Vec<u8>, StreamError> {
        let Some(end) = self.extent_end(pos) else {
            return Err(StreamError::Internal {
                message: format!("read of uncovered offset {pos}"),
            });
        };
        let n = (end - pos).min(max_len);
        self.file
            .seek(SeekFrom::Start(pos))
            .map_err(|e| StreamError::Internal {
                message: format!("seek {pos}: {e}"),
            })?;
        let mut buf = Vec::with_capacity(usize::try_from(n).unwrap_or(0));
        let mut take = (&self.file).take(n);
        take.read_to_end(&mut buf)
            .map_err(|e| StreamError::Internal {
                message: format!("read {pos}: {e}"),
            })?;
        if buf.len() as u64 != n {
            return Err(StreamError::Internal {
                message: format!("short read at {pos}: {}/{} bytes", buf.len(), n),
            });
        }
        Ok(buf)
    }

    /// Write `bytes` at `start` and merge `[start, start+len)` into the
    /// extent map (adjacent and overlapping extents coalesce).
    pub(crate) fn insert(&mut self, start: u64, bytes: &[u8]) -> Result<(), StreamError> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.file
            .seek(SeekFrom::Start(start))
            .and_then(|_| self.file.write_all(bytes))
            .map_err(|e| StreamError::Internal {
                message: format!("write {start}: {e}"),
            })?;
        let mut new_start = start;
        let mut new_end = start + bytes.len() as u64;
        let absorbed: Vec<u64> = self
            .extents
            .range(..=new_end)
            .filter(|(_, e)| **e >= new_start)
            .map(|(s, _)| *s)
            .collect();
        for s in absorbed {
            if let Some(e) = self.extents.remove(&s) {
                new_start = new_start.min(s);
                new_end = new_end.max(e);
            }
        }
        self.extents.insert(new_start, new_end);
        self.dirty += 1;
        Ok(())
    }

    /// The first uncovered offset in `[start, bound)`, or `None` when
    /// the window is fully covered.
    pub(crate) fn first_gap(&self, start: u64, bound: u64) -> Option<u64> {
        // `start` may sit inside an extent that began earlier; jump the
        // cursor past it before scanning forward.
        let mut cursor = self.extent_end(start).map_or(start, |e| e.max(start));
        for (s, e) in self.extents.range(cursor..) {
            if *s >= bound {
                break;
            }
            if *s > cursor {
                return Some(cursor);
            }
            cursor = cursor.max(*e);
            if cursor >= bound {
                return None;
            }
        }
        (cursor < bound).then_some(cursor)
    }

    /// Whether `[0, bound)` is fully covered (the head-ready check).
    pub(crate) fn head_covered(&self, bound: u64) -> bool {
        self.first_gap(0, bound).is_none()
    }

    /// Record the wire-authoritative total (`Content-Range` total).
    pub(crate) fn set_total(&mut self, total: u64) {
        self.total = Some(total);
    }

    /// The wire-reported total only (`None` until a `Content-Range`
    /// was accepted) — the stable-total check compares wire to wire.
    pub(crate) fn wire_total(&self) -> Option<u64> {
        self.total
    }

    /// Update the guest-reported length hint after a re-mint.
    pub(crate) fn set_hint(&mut self, hint: u64) {
        self.hint_total = Some(hint);
    }

    /// The best known total length: wire value wins, else the
    /// resolve-time `content_length` hint.
    pub(crate) fn effective_total(&self) -> Option<u64> {
        self.total.or(self.hint_total)
    }

    /// Persist the extent map when the dirty-chunk threshold or a
    /// milestone says so. File data is synced first — see the module
    /// ordering invariant.
    pub(crate) fn persist(
        &mut self,
        paths: &SessionPaths,
        meta: &SidecarMeta,
    ) -> Result<(), StreamError> {
        self.file.sync_data().map_err(|e| StreamError::Internal {
            message: format!("sync: {e}"),
        })?;
        let sidecar = Sidecar {
            source_ref: meta.source_ref.clone(),
            mime: meta.mime.clone(),
            itag: meta.itag,
            bitrate_kbps: meta.bitrate_kbps,
            total: self.total.or(self.hint_total),
            expires_at_ms: meta.expires_at_ms,
            extents: self.extents.iter().map(|(s, e)| (*s, *e)).collect(),
        };
        sidecar
            .persist(&paths.sidecar, &paths.tmp)
            .map_err(|e| StreamError::Internal {
                message: format!("sidecar: {e}"),
            })?;
        self.dirty = 0;
        Ok(())
    }

    /// Whether a flush is due by chunk count.
    pub(crate) fn persist_due(&self) -> bool {
        self.dirty >= PERSIST_EVERY_CHUNKS
    }
}

/// The static session fields a [`SparseStore::persist`] stamps into
/// the sidecar (everything but the extents and total).
pub(crate) struct SidecarMeta {
    /// Provider source reference.
    pub source_ref: String,
    /// Pinned MIME.
    pub mime: String,
    /// Format itag.
    pub itag: Option<u32>,
    /// Bitrate hint.
    pub bitrate_kbps: Option<u32>,
    /// URL expiry hint.
    pub expires_at_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "auqw-stream-store-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&p)
                .map(|_| Self(p))
                .unwrap_or_else(|e| panic!("mkdir: {e}"))
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn store(tag: &str) -> (TempDir, SessionPaths, SparseStore) {
        let dir = TempDir::new(tag);
        let paths = SessionPaths::new(&dir.0, "s1");
        let s = SparseStore::create(&paths, Some(1000)).unwrap_or_else(|e| panic!("create: {e}"));
        (dir, paths, s)
    }

    fn insert(store: &mut SparseStore, start: u64, len: u64) {
        let bytes = vec![7u8; usize::try_from(len).unwrap_or(0)];
        store
            .insert(start, &bytes)
            .unwrap_or_else(|e| panic!("insert: {e}"));
    }

    #[test]
    fn inserts_merge_adjacent_and_overlap() {
        let (_d, _p, mut s) = store("merge");
        insert(&mut s, 0, 10);
        insert(&mut s, 10, 10); // adjacent merges
        insert(&mut s, 50, 10); // disjoint stays
        insert(&mut s, 15, 40); // bridges [0,20) and [50,60) → [0,60)
        assert_eq!(s.extents.iter().collect::<Vec<_>>(), vec![(&0, &60)]);
        assert!(s.covers(0));
        assert!(s.covers(59));
        assert!(!s.covers(60));
    }

    #[test]
    fn enclosed_and_overlapping_inserts_coalesce() {
        let (_d, _p, mut s) = store("enclosed");
        insert(&mut s, 100, 50);
        insert(&mut s, 110, 10); // fully enclosed
        insert(&mut s, 90, 15); // overlaps front
        assert_eq!(s.extents.len(), 1);
        assert_eq!(s.extent_end(90), Some(150));
        assert!(!s.covers(89));
    }

    #[test]
    fn first_gap_finds_holes() {
        let (_d, _p, mut s) = store("gap");
        insert(&mut s, 0, 10);
        insert(&mut s, 20, 10);
        assert_eq!(s.first_gap(0, 100), Some(10));
        assert_eq!(s.first_gap(0, 10), None);
        assert_eq!(s.first_gap(25, 40), Some(30));
        assert_eq!(s.first_gap(20, 30), None);
    }

    #[test]
    fn read_at_caps_at_extent_end() {
        let (_d, _p, mut s) = store("read");
        insert(&mut s, 8, 10);
        let got = s.read_at(8, 100).unwrap_or_else(|e| panic!("read: {e}"));
        assert_eq!(got.len(), 10);
        let got = s.read_at(12, 3).unwrap_or_else(|e| panic!("read: {e}"));
        assert_eq!(got, vec![7u8; 3]);
    }

    #[test]
    fn sidecar_round_trip_and_corruption() {
        let (dir, paths, mut s) = store("sidecar");
        let meta = SidecarMeta {
            source_ref: "vid".into(),
            mime: "audio/mp4".into(),
            itag: Some(140),
            bitrate_kbps: Some(129),
            expires_at_ms: Some(99),
        };
        insert(&mut s, 0, 64);
        insert(&mut s, 128, 32);
        s.persist(&paths, &meta)
            .unwrap_or_else(|e| panic!("persist: {e}"));
        let loaded = Sidecar::load(&paths.sidecar).unwrap_or_else(|e| panic!("load: {e}"));
        assert_eq!(loaded.extents, vec![(0, 64), (128, 160)]);
        assert_eq!(loaded.itag, Some(140));
        assert_eq!(loaded.total, Some(1000));
        // Corrupt JSON is an error, never a silent reset.
        std::fs::write(&paths.sidecar, b"{not json").unwrap_or_else(|e| panic!("w: {e}"));
        assert!(Sidecar::load(&paths.sidecar).is_err());
        drop(dir);
    }

    #[test]
    fn overlap_and_unsorted_extents_are_corrupt() {
        let dir = TempDir::new("corrupt");
        let path = dir.0.join("x.json");
        std::fs::write(
            &path,
            br#"{"source_ref":"v","mime":"m","extents":[[10,20],[15,25]]}"#,
        )
        .unwrap_or_else(|e| panic!("w: {e}"));
        assert!(Sidecar::load(&path).is_err());
        std::fs::write(
            &path,
            br#"{"source_ref":"v","mime":"m","extents":[[10,20],[5,8]]}"#,
        )
        .unwrap_or_else(|e| panic!("w: {e}"));
        assert!(Sidecar::load(&path).is_err());
    }
}
