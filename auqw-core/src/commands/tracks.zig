const std = @import("std");
const errors = @import("../errors.zig");
const models = @import("../models.zig");
const sqlite = @import("../sqlite.zig");
const AppState = @import("../state.zig").AppState;
const json = @import("json_helpers.zig");
const responses = @import("responses.zig");

const ObjectMap = std.json.ObjectMap;

pub fn upsert(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const track_id = if (json.optionalString(params, "id")) |value|
        state.allocator.dupe(u8, value) catch return error.AllocationFailed
    else
        models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(track_id);

    const title = json.requiredString(params, "title") catch return error.InvalidJson;
    const artist = json.optionalString(params, "artist");
    const album = json.optionalString(params, "album");
    const duration_ms = json.optionalInt(params, "duration_ms") catch return error.InvalidJson;
    const artwork_url = json.optionalString(params, "artwork_url");
    const provider = json.optionalString(params, "provider");
    const provider_track_id = json.optionalString(params, "provider_track_id");

    var stmt = state.db.prepare(
        \\INSERT INTO tracks (
        \\    id, provider, provider_track_id, title, artist, album, duration_ms, artwork_url, updated_at
        \\) VALUES (
        \\    ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now')
        \\)
        \\ON CONFLICT(id) DO UPDATE SET
        \\    provider = excluded.provider,
        \\    provider_track_id = excluded.provider_track_id,
        \\    title = excluded.title,
        \\    artist = excluded.artist,
        \\    album = excluded.album,
        \\    duration_ms = excluded.duration_ms,
        \\    artwork_url = excluded.artwork_url,
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    ) catch return error.Database;
    defer stmt.finalize();

    stmt.bindText(1, track_id) catch return error.Database;
    stmt.bindOptionalText(2, provider) catch return error.Database;
    stmt.bindOptionalText(3, provider_track_id) catch return error.Database;
    stmt.bindText(4, title) catch return error.Database;
    stmt.bindOptionalText(5, artist) catch return error.Database;
    stmt.bindOptionalText(6, album) catch return error.Database;
    stmt.bindOptionalInt64(7, duration_ms) catch return error.Database;
    stmt.bindOptionalText(8, artwork_url) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const track = getTrackById(state, track_id) catch return error.Database;
    defer track.deinit(state.allocator);

    return responses.makeSuccess(state.allocator, id, .{ .track = track });
}

pub fn list(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const tracks = listTracks(state) catch return error.Database;
    defer freeTracks(state.allocator, tracks);
    return responses.makeSuccess(state.allocator, id, .{ .tracks = tracks });
}

pub fn localFilesUpsert(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const path = json.requiredString(params, "path") catch return error.InvalidJson;
    const title = json.requiredString(params, "title") catch return error.InvalidJson;
    const artist = json.optionalString(params, "artist");
    const album = json.optionalString(params, "album");
    const duration_ms = json.optionalInt(params, "duration_ms") catch return error.InvalidJson;

    const candidate_track_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(candidate_track_id);
    const candidate_local_file_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(candidate_local_file_id);

    state.db.exec("BEGIN IMMEDIATE;") catch return error.Database;
    var committed = false;
    errdefer if (!committed) state.db.exec("ROLLBACK;") catch {};

    upsertLocalTrack(state, candidate_track_id, path, title, artist, album, duration_ms) catch return error.Database;
    const track = getTrackByProviderIdentity(state, "local", path) catch return error.Database;
    defer track.deinit(state.allocator);

    upsertLocalFile(state, candidate_local_file_id, track.id, path) catch return error.Database;
    const local_file = getLocalFileByPath(state, path) catch return error.Database;
    defer local_file.deinit(state.allocator);

    state.db.exec("COMMIT;") catch return error.Database;
    committed = true;

    return responses.makeSuccess(state.allocator, id, .{
        .track = track,
        .local_file = local_file,
    });
}

fn getTrackById(state: *AppState, id: []const u8) sqlite.DbError!models.Track {
    var stmt = try state.db.prepare(
        \\SELECT id, provider, provider_track_id, title, artist, album, duration_ms, artwork_url, created_at, updated_at
        \\FROM tracks
        \\WHERE id = ?
    );
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return trackFromStmt(state.allocator, &stmt);
}

fn listTracks(state: *AppState) sqlite.DbError![]models.Track {
    var stmt = try state.db.prepare(
        \\SELECT id, provider, provider_track_id, title, artist, album, duration_ms, artwork_url, created_at, updated_at
        \\FROM tracks
        \\ORDER BY title COLLATE NOCASE ASC, id ASC
    );
    defer stmt.finalize();

    var items: std.ArrayList(models.Track) = .empty;
    errdefer freeTracks(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try trackFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn upsertLocalTrack(
    state: *AppState,
    track_id: []const u8,
    path: []const u8,
    title: []const u8,
    artist: ?[]const u8,
    album: ?[]const u8,
    duration_ms: ?i64,
) sqlite.DbError!void {
    var stmt = try state.db.prepare(
        \\INSERT INTO tracks (
        \\    id, provider, provider_track_id, title, artist, album, duration_ms, artwork_url, updated_at
        \\) VALUES (
        \\    ?, 'local', ?, ?, ?, ?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now')
        \\)
        \\ON CONFLICT(provider, provider_track_id)
        \\WHERE provider IS NOT NULL AND provider_track_id IS NOT NULL
        \\DO UPDATE SET
        \\    title = excluded.title,
        \\    artist = excluded.artist,
        \\    album = excluded.album,
        \\    duration_ms = excluded.duration_ms,
        \\    artwork_url = excluded.artwork_url,
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    );
    defer stmt.finalize();

    try stmt.bindText(1, track_id);
    try stmt.bindText(2, path);
    try stmt.bindText(3, title);
    try stmt.bindOptionalText(4, artist);
    try stmt.bindOptionalText(5, album);
    try stmt.bindOptionalInt64(6, duration_ms);
    if ((try stmt.step()) != .done) return error.Database;
}

fn upsertLocalFile(
    state: *AppState,
    local_file_id: []const u8,
    track_id: []const u8,
    path: []const u8,
) sqlite.DbError!void {
    var stmt = try state.db.prepare(
        \\INSERT INTO local_files (id, track_id, path)
        \\VALUES (?, ?, ?)
        \\ON CONFLICT(path) DO UPDATE SET
        \\    track_id = excluded.track_id
    );
    defer stmt.finalize();

    try stmt.bindText(1, local_file_id);
    try stmt.bindText(2, track_id);
    try stmt.bindText(3, path);
    if ((try stmt.step()) != .done) return error.Database;
}

fn getTrackByProviderIdentity(state: *AppState, provider: []const u8, provider_track_id: []const u8) sqlite.DbError!models.Track {
    var stmt = try state.db.prepare(
        \\SELECT id, provider, provider_track_id, title, artist, album, duration_ms, artwork_url, created_at, updated_at
        \\FROM tracks
        \\WHERE provider = ? AND provider_track_id = ?
    );
    defer stmt.finalize();
    try stmt.bindText(1, provider);
    try stmt.bindText(2, provider_track_id);
    if ((try stmt.step()) != .row) return error.Database;
    return trackFromStmt(state.allocator, &stmt);
}

fn getLocalFileByPath(state: *AppState, path: []const u8) sqlite.DbError!models.LocalFile {
    var stmt = try state.db.prepare("SELECT id, track_id, path, discovered_at FROM local_files WHERE path = ?");
    defer stmt.finalize();
    try stmt.bindText(1, path);
    if ((try stmt.step()) != .row) return error.Database;
    return localFileFromStmt(state.allocator, &stmt);
}

fn trackFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.Track {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .provider = try stmt.columnOptionalText(allocator, 1),
        .provider_track_id = try stmt.columnOptionalText(allocator, 2),
        .title = try stmt.columnText(allocator, 3),
        .artist = try stmt.columnOptionalText(allocator, 4),
        .album = try stmt.columnOptionalText(allocator, 5),
        .duration_ms = stmt.columnOptionalInt64(6),
        .artwork_url = try stmt.columnOptionalText(allocator, 7),
        .created_at = try stmt.columnText(allocator, 8),
        .updated_at = try stmt.columnText(allocator, 9),
    };
}

fn localFileFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.LocalFile {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .track_id = try stmt.columnText(allocator, 1),
        .path = try stmt.columnText(allocator, 2),
        .discovered_at = try stmt.columnText(allocator, 3),
    };
}

fn freeTracks(allocator: std.mem.Allocator, items: []models.Track) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}
