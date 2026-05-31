const std = @import("std");
const sqlite = @import("sqlite.zig");

pub const latest_version: i64 = 5;

pub fn run(db: *sqlite.Database) sqlite.DbError!void {
    try db.exec(
        \\BEGIN;
        \\
        \\CREATE TABLE IF NOT EXISTS schema_migrations (
        \\    version INTEGER PRIMARY KEY,
        \\    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE TABLE IF NOT EXISTS artists (
        \\    id TEXT PRIMARY KEY,
        \\    name TEXT NOT NULL UNIQUE,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE TABLE IF NOT EXISTS albums (
        \\    id TEXT PRIMARY KEY,
        \\    title TEXT NOT NULL,
        \\    artist_id TEXT REFERENCES artists(id) ON DELETE SET NULL,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE TABLE IF NOT EXISTS tracks (
        \\    id TEXT PRIMARY KEY,
        \\    provider TEXT,
        \\    provider_track_id TEXT,
        \\    title TEXT NOT NULL,
        \\    artist TEXT,
        \\    album TEXT,
        \\    duration_ms INTEGER,
        \\    artwork_url TEXT,
        \\    metadata_cached_at TEXT,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_provider_identity
        \\ON tracks(provider, provider_track_id)
        \\WHERE provider IS NOT NULL AND provider_track_id IS NOT NULL;
        \\
        \\CREATE TABLE IF NOT EXISTS playlists (
        \\    id TEXT PRIMARY KEY,
        \\    name TEXT NOT NULL,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE TABLE IF NOT EXISTS playlist_tracks (
        \\    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        \\    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        \\    position INTEGER NOT NULL,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        \\    PRIMARY KEY (playlist_id, track_id)
        \\);
        \\
        \\CREATE TABLE IF NOT EXISTS recent_tracks (
        \\    id TEXT PRIMARY KEY,
        \\    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        \\    played_at TEXT NOT NULL,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE INDEX IF NOT EXISTS idx_recent_tracks_played_at
        \\ON recent_tracks(played_at DESC, created_at DESC);
        \\
        \\CREATE TABLE IF NOT EXISTS search_history (
        \\    id TEXT PRIMARY KEY,
        \\    query TEXT NOT NULL,
        \\    searched_at TEXT NOT NULL,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE INDEX IF NOT EXISTS idx_search_history_searched_at
        \\ON search_history(searched_at DESC, created_at DESC);
        \\
        \\CREATE TABLE IF NOT EXISTS settings (
        \\    key TEXT PRIMARY KEY,
        \\    value TEXT,
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE TABLE IF NOT EXISTS cached_artwork (
        \\    id TEXT PRIMARY KEY,
        \\    track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
        \\    source_url TEXT,
        \\    cache_path TEXT NOT NULL,
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE INDEX IF NOT EXISTS idx_cached_artwork_track
        \\ON cached_artwork(track_id);
        \\
        \\CREATE INDEX IF NOT EXISTS idx_cached_artwork_source
        \\ON cached_artwork(source_url);
        \\
        \\CREATE TABLE IF NOT EXISTS downloads (
        \\    id TEXT PRIMARY KEY,
        \\    track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        \\    state TEXT NOT NULL,
        \\    progress INTEGER NOT NULL DEFAULT 0,
        \\    bytes_received INTEGER NOT NULL DEFAULT 0,
        \\    bytes_total INTEGER,
        \\    mime_type TEXT,
        \\    stream_kind TEXT,
        \\    error_text TEXT,
        \\    target_path TEXT,
        \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE INDEX IF NOT EXISTS idx_downloads_state
        \\ON downloads(state, updated_at DESC);
        \\
        \\CREATE INDEX IF NOT EXISTS idx_downloads_track
        \\ON downloads(track_id);
        \\
        \\CREATE TABLE IF NOT EXISTS local_files (
        \\    id TEXT PRIMARY KEY,
        \\    track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        \\    path TEXT NOT NULL UNIQUE,
        \\    discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE TABLE IF NOT EXISTS queue_items (
        \\    id TEXT PRIMARY KEY,
        \\    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        \\    position INTEGER NOT NULL,
        \\    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\CREATE INDEX IF NOT EXISTS idx_queue_items_order
        \\ON queue_items(position ASC, added_at ASC, id ASC);
        \\
        \\CREATE TABLE IF NOT EXISTS playback_state (
        \\    id INTEGER PRIMARY KEY CHECK (id = 1),
        \\    state TEXT NOT NULL CHECK (state IN ('stopped', 'loading', 'playing', 'paused', 'error')),
        \\    queue_item_id TEXT REFERENCES queue_items(id) ON DELETE SET NULL,
        \\    track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        \\    title TEXT,
        \\    artist TEXT,
        \\    album TEXT,
        \\    artwork_url TEXT,
        \\    local_path TEXT,
        \\    position_ms INTEGER,
        \\    duration_ms INTEGER,
        \\    error_message TEXT,
        \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\);
        \\
        \\INSERT OR IGNORE INTO playback_state(id, state) VALUES (1, 'stopped');
        \\
        \\INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
        \\INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
        \\INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
        \\
        \\COMMIT;
    );

    try ensureColumn(db, "tracks", "metadata_cached_at", "ALTER TABLE tracks ADD COLUMN metadata_cached_at TEXT");
    try ensureColumn(db, "downloads", "progress", "ALTER TABLE downloads ADD COLUMN progress INTEGER NOT NULL DEFAULT 0");
    try ensureColumn(db, "downloads", "bytes_received", "ALTER TABLE downloads ADD COLUMN bytes_received INTEGER NOT NULL DEFAULT 0");
    try ensureColumn(db, "downloads", "bytes_total", "ALTER TABLE downloads ADD COLUMN bytes_total INTEGER");
    try ensureColumn(db, "downloads", "mime_type", "ALTER TABLE downloads ADD COLUMN mime_type TEXT");
    try ensureColumn(db, "downloads", "stream_kind", "ALTER TABLE downloads ADD COLUMN stream_kind TEXT");
    try ensureColumn(db, "downloads", "error_text", "ALTER TABLE downloads ADD COLUMN error_text TEXT");
    try db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (4);");
    try db.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);");
}

pub fn currentVersion(db: *sqlite.Database) sqlite.DbError!i64 {
    var stmt = try db.prepare("SELECT COALESCE(MAX(version), 0) FROM schema_migrations");
    defer stmt.finalize();

    return switch (try stmt.step()) {
        .row => stmt.columnOptionalInt64(0) orelse 0,
        .done => 0,
    };
}

fn ensureColumn(db: *sqlite.Database, table: []const u8, column: []const u8, alter_sql: []const u8) sqlite.DbError!void {
    var sql_buf: [128]u8 = undefined;
    const pragma_sql = std.fmt.bufPrint(&sql_buf, "PRAGMA table_info({s})", .{table}) catch return error.AllocationFailed;
    var stmt = try db.prepare(pragma_sql);
    defer stmt.finalize();

    while ((try stmt.step()) == .row) {
        const name = try stmt.columnText(std.heap.page_allocator, 1);
        defer std.heap.page_allocator.free(name);
        if (std.mem.eql(u8, name, column)) {
            return;
        }
    }

    try db.exec(alter_sql);
}
