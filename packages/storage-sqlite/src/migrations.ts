export const CURRENT_SCHEMA_VERSION = 6;

/**
 * Every table this schema owns, all versions. A database opened at
 * version zero must hold none of them — a partial migration cannot
 * exist because each migration is a single transaction — so one of
 * these names in sqlite_master means a foreign file being adopted
 * silently, and initialize rejects it instead of merging into it.
 */
export const KNOWN_TABLES: readonly string[] = Object.freeze([
  'schema_version',
  'recordings',
  'source_refs',
  'mappings',
  'likes',
  'queue_state',
  'queue_occurrences',
  'settings',
  'attempt_traces',
  'entities',
  'entity_source_refs',
  'playlists',
  'playlist_entries',
  'play_history',
  'play_counts',
  'match_reviews',
  'lyrics_cache',
  'artwork_cache',
  'downloads',
  'local_sources',
  'local_files',
  'sync_log',
  'sync_divergence',
  'sync_watermarks',
  'sync_meta',
]);

const MIGRATION_1: readonly string[] = [
  `CREATE TABLE schema_version (
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
 * `settings` widens by ALTER (all three columns are optional).
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
  `ALTER TABLE settings ADD COLUMN lyrics_provider TEXT`,
  `ALTER TABLE settings ADD COLUMN radio_provider TEXT`,
  `ALTER TABLE settings ADD COLUMN artwork_cache_bytes INTEGER CHECK (artwork_cache_bytes BETWEEN 16777216 AND 1073741824)`,
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

/**
 * v2 -> v3: offline slice (downloads + local files). `downloads` holds
 * one row per recording (`recording_id UNIQUE` — re-download
 * replaces); `local_sources`/`local_files` index user-picked folders.
 * `recordings` gains `provenance` ('provider' default — every
 * pre-slice-3 row is catalog-sourced), `settings` gains
 * `download_metered` (off by default) — both via ALTER with defaults.
 * `downloads.expires_at_ms`/`downloaded_ms` are mint-expiry and
 * completion stamps; `error_json` carries the last typed failure on
 * `failed_with_retry` rows.
 */
const MIGRATION_3: readonly string[] = [
  `CREATE TABLE downloads (
  download_id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  file_path TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('requested','transferring','available','failed_with_retry','removing')),
  committed_offset INTEGER NOT NULL CHECK (committed_offset >= 0),
  checksum TEXT,
  mime TEXT,
  itag INTEGER,
  expires_at_ms INTEGER CHECK (expires_at_ms >= 0 OR expires_at_ms IS NULL),
  error_json TEXT,
  priority INTEGER NOT NULL CHECK (priority >= 0),
  requested_ms INTEGER NOT NULL CHECK (requested_ms >= 0),
  downloaded_ms INTEGER CHECK (downloaded_ms >= 0 OR downloaded_ms IS NULL)
)`,
  `CREATE INDEX downloads_state_idx ON downloads(state)`,
  `CREATE TABLE local_sources (
  source_id TEXT PRIMARY KEY,
  tree_uri TEXT NOT NULL,
  label TEXT NOT NULL,
  added_ms INTEGER NOT NULL CHECK (added_ms >= 0),
  last_scan_ms INTEGER CHECK (last_scan_ms >= 0 OR last_scan_ms IS NULL)
)`,
  `CREATE TABLE local_files (
  file_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES local_sources(source_id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  fingerprint TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  album TEXT,
  duration_ms INTEGER CHECK (duration_ms >= 0 OR duration_ms IS NULL),
  genre TEXT,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE
)`,
  `CREATE INDEX local_files_source_idx ON local_files(source_id)`,
  `CREATE INDEX local_files_fingerprint_idx ON local_files(fingerprint)`,
  `ALTER TABLE recordings ADD COLUMN provenance TEXT NOT NULL DEFAULT 'provider' CHECK (provenance IN ('provider','local'))`,
  `ALTER TABLE settings ADD COLUMN download_metered INTEGER NOT NULL DEFAULT 0 CHECK (download_metered IN (0,1))`,
];

/**
 * v3 -> v4: `local_files.modified_ms` — the provider's last-modified
 * stamp persisted per scanned row so a same-size in-place
 * replacement still registers as changed (size alone can't detect
 * one). Nullable: rows predating the column re-fingerprint once on
 * their next scan, and providers without a stamp stay null.
 */
const MIGRATION_4: readonly string[] = [
  `ALTER TABLE local_files ADD COLUMN modified_ms INTEGER CHECK (modified_ms >= 0 OR modified_ms IS NULL)`,
];

/**
 * v4 -> v5: the SyncEngine's durable log (docs/specs/sync.md). Rows
 * carry canonical append order implicitly via rowid — `seq` is the
 * per-device watermark the engine stamps on each entry, NOT the table
 * order. `sync_divergence.seq` mirrors it so the retention floor can
 * drop rows below `dropDivergenceBefore` in one DELETE.
 * (device_id, seq) and (history_id) uniqueness make a crash-replayed
 * append idempotent via INSERT OR IGNORE.
 */
const MIGRATION_5: readonly string[] = [
  `CREATE TABLE sync_log (
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  entry_json TEXT NOT NULL,
  UNIQUE (device_id, seq)
)`,
  `CREATE TABLE sync_divergence (
  history_id TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  row_json TEXT NOT NULL
)`,
  `CREATE INDEX sync_divergence_seq_idx ON sync_divergence(seq)`,
  `CREATE TABLE sync_watermarks (
  device_id TEXT PRIMARY KEY,
  mark INTEGER NOT NULL CHECK (mark >= 0)
)`,
  `CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
)`,
];

/**
 * v5 -> v6: `settings.language` — the UI-language pin (BCP-47 tag).
 * Nullable with no default: a NULL (or pre-column) row means "follow
 * the platform locale", so the column must never mint a concrete
 * language of its own — only a value the user explicitly chose is
 * ever written.
 */
const MIGRATION_6: readonly string[] = [
  `ALTER TABLE settings ADD COLUMN language TEXT`,
];

/** Read-only migration index for driver/release inspection. */
export const MIGRATIONS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([...MIGRATION_1]),
  Object.freeze([...MIGRATION_2]),
  Object.freeze([...MIGRATION_3]),
  Object.freeze([...MIGRATION_4]),
  Object.freeze([...MIGRATION_5]),
  Object.freeze([...MIGRATION_6]),
]);

const CREATED_OBJECT_NAME =
  /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z_][A-Za-z0-9_]*)/i;
const RENAMED_OBJECT_NAME =
  /RENAME\s+TO\s+["'`\[]?([A-Za-z_][A-Za-z0-9_]*)/i;

/**
 * Namespaces SQLite collides names within: tables, views, and
 * indexes share one ('object'); triggers live in their own and may
 * reuse an object name without colliding.
 */
export type SchemaObjectKind = 'object' | 'trigger';

/**
 * Every schema-object name the migrations create or rename to —
 * final tables, throwaways like `likes_new`, and named indexes —
 * tagged with its collision namespace. Derived from the SQL itself
 * so a new migration cannot forget to declare its objects. The
 * version-zero foreign-file probe rejects only same-namespace
 * collisions: a foreign `downloads_state_idx` index collides with
 * our `CREATE INDEX`, a foreign `downloads` trigger does not.
 */
export const KNOWN_SCHEMA_OBJECTS: readonly {
  readonly kind: SchemaObjectKind;
  readonly name: string;
}[] = Object.freeze(
  Array.from(
    new Map(
      MIGRATIONS.flat()
        .flatMap((sql) => {
          const created = CREATED_OBJECT_NAME.exec(sql);
          const renamed = RENAMED_OBJECT_NAME.exec(sql);
          return [
            created !== null
              ? {
                  kind: ((created[1] ?? '').toUpperCase() === 'TRIGGER'
                    ? 'trigger'
                    : 'object') as SchemaObjectKind,
                  name: created[2] as string,
                }
              : undefined,
            renamed !== null
              ? ({ kind: 'object', name: renamed[1] } as const)
              : undefined,
          ];
        })
        .filter(
          (entry): entry is { kind: SchemaObjectKind; name: string } =>
            entry !== undefined,
        )
        .concat(
          KNOWN_TABLES.map((name) => ({ kind: 'object' as const, name })),
        )
        .map((entry) => [`${entry.kind}:${entry.name}`, entry] as const),
    ).values(),
  ),
);
