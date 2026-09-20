export const CURRENT_SCHEMA_VERSION = 2;

const MIGRATION_1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version >= 0)
)`,
  `CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  duration_ms INTEGER,
  release_year INTEGER,
  artwork_json TEXT NOT NULL,
  explicit INTEGER CHECK (explicit IN (0,1) OR explicit IS NULL),
  genre TEXT,
  isrc TEXT,
  version_labels_json TEXT NOT NULL
)`,
  `CREATE TABLE source_refs (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'track'),
  source_id TEXT NOT NULL,
  PRIMARY KEY (recording_id, ordinal),
  UNIQUE (recording_id, provider, kind, source_id)
)`,
  `CREATE TABLE mappings (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'track'),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('automatic','user-confirmed','rejected')),
  matched_at_ms INTEGER NOT NULL CHECK (matched_at_ms >= 0),
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (recording_id, ordinal)
)`,
  `CREATE TABLE likes (
  entity_kind TEXT NOT NULL CHECK (entity_kind = 'track'),
  entity_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  liked_at_ms INTEGER NOT NULL CHECK (liked_at_ms >= 0),
  PRIMARY KEY (entity_kind, entity_id)
)`,
  `CREATE TABLE queue_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  current_occurrence_id TEXT,
  position_ms INTEGER NOT NULL CHECK (position_ms >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('stopped','paused','playing')),
  blocked_error_json TEXT
)`,
  `CREATE TABLE queue_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  selected_provider TEXT,
  selected_kind TEXT CHECK (selected_kind = 'track' OR selected_kind IS NULL),
  selected_source_id TEXT,
  CHECK ((selected_provider IS NULL AND selected_kind IS NULL AND selected_source_id IS NULL)
      OR (selected_provider IS NOT NULL AND selected_kind = 'track' AND selected_source_id IS NOT NULL))
)`,
  `CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalog_provider TEXT NOT NULL,
  playback_provider TEXT NOT NULL,
  storefront TEXT,
  quality_kbps INTEGER NOT NULL CHECK (quality_kbps BETWEEN 1 AND 512),
  theme TEXT NOT NULL CHECK (theme IN ('dark','light','oled','system')),
  prefetch INTEGER NOT NULL CHECK (prefetch IN (0,1))
)`,
  `CREATE TABLE attempt_traces (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  trace_json TEXT NOT NULL
)`,
  `CREATE INDEX attempt_traces_request_id_idx ON attempt_traces(request_id)`,
];

/**
 * v1 -> v2: library ownership. `likes` cannot be widened in place —
 * SQLite CHECK constraints are immutable — so it is rebuilt inside the
 * transaction: v1 rows copy across as track likes. The new `likes`
 * has no foreign key on `target_id` by design: 'track' targets name
 * `recordings.id` while 'album'/'artist' targets name
 * `entities.entity_id`; the polymorphic reference is enforced by the
 * application's persisted-document validation, not the schema.
 */
const MIGRATION_2: readonly string[] = [
  `CREATE TABLE entities (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('album','artist')),
  title TEXT NOT NULL,
  artist_name TEXT,
  artwork_json TEXT,
  created_ms INTEGER NOT NULL CHECK (created_ms >= 0)
)`,
  `CREATE TABLE entity_source_refs (
  entity_id TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ref_json TEXT NOT NULL,
  PRIMARY KEY (entity_id, provider)
)`,
  `CREATE TABLE playlists (
  playlist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_ms INTEGER NOT NULL CHECK (created_ms >= 0),
  updated_ms INTEGER NOT NULL CHECK (updated_ms >= 0)
)`,
  `CREATE TABLE playlist_entries (
  entry_id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(playlist_id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  position REAL NOT NULL,
  selected_ref_json TEXT,
  added_ms INTEGER NOT NULL CHECK (added_ms >= 0)
)`,
  `CREATE INDEX playlist_entries_playlist_idx ON playlist_entries(playlist_id)`,
  `CREATE TABLE play_history (
  event_id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  occurrence_id TEXT,
  played_ms INTEGER NOT NULL CHECK (played_ms >= 0),
  listened_ms INTEGER NOT NULL CHECK (listened_ms >= 0)
)`,
  `CREATE INDEX play_history_played_idx ON play_history(played_ms)`,
  `CREATE TABLE play_counts (
  recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
  count INTEGER NOT NULL CHECK (count >= 0),
  last_ms INTEGER NOT NULL CHECK (last_ms >= 0)
)`,
  `CREATE TABLE match_reviews (
  review_id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  candidates_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','dismissed')),
  resolution_json TEXT,
  created_ms INTEGER NOT NULL CHECK (created_ms >= 0),
  resolved_ms INTEGER CHECK (resolved_ms >= 0 OR resolved_ms IS NULL)
)`,
  `CREATE INDEX match_reviews_status_idx ON match_reviews(status)`,
  `CREATE TABLE lyrics_cache (
  recording_id TEXT PRIMARY KEY REFERENCES recordings(id),
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plain','synced')),
  payload_json TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL CHECK (fetched_ms >= 0)
)`,
  `CREATE TABLE artwork_cache (
  url TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  last_accessed_ms INTEGER NOT NULL CHECK (last_accessed_ms >= 0)
)`,
  `CREATE INDEX artwork_cache_accessed_idx ON artwork_cache(last_accessed_ms)`,
  `CREATE TABLE likes_new (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('track','album','artist')),
  target_id TEXT NOT NULL,
  liked_ms INTEGER NOT NULL CHECK (liked_ms >= 0),
  PRIMARY KEY (entity_kind, target_id)
)`,
  `INSERT INTO likes_new (entity_kind, target_id, liked_ms)
   SELECT entity_kind, entity_id, liked_at_ms FROM likes`,
  `DROP TABLE likes`,
  `ALTER TABLE likes_new RENAME TO likes`,
];

/** Read-only migration index for driver/release inspection. */
export const MIGRATIONS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([...MIGRATION_1]),
  Object.freeze([...MIGRATION_2]),
]);
