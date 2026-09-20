export const CURRENT_SCHEMA_VERSION = 1;

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

/** Read-only migration index for driver/release inspection. */
export const MIGRATIONS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([...MIGRATION_1]),
]);
