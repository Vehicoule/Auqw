const std = @import("std");
const errors = @import("../errors.zig");
const models = @import("../models.zig");
const sqlite = @import("../sqlite.zig");
const AppState = @import("../state.zig").AppState;
const json = @import("json_helpers.zig");
const responses = @import("responses.zig");

const ObjectMap = std.json.ObjectMap;

const valid_states = [_][]const u8{
    "queued",
    "resolving",
    "downloading",
    "verifying",
    "completed",
    "failed",
    "cancelled",
};

const download_select_sql =
    \\SELECT d.id, d.track_id, d.state, d.progress, d.bytes_received, d.bytes_total, d.mime_type, d.stream_kind,
    \\       d.error_text, d.target_path, d.created_at, d.updated_at,
    \\       t.provider, t.provider_track_id, t.title, t.artist, t.album, t.duration_ms, t.artwork_url
    \\FROM downloads d
    \\LEFT JOIN tracks t ON t.id = d.track_id
;

pub fn queueDownload(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const download_id = if (json.optionalString(params, "id")) |provided|
        state.allocator.dupe(u8, provided) catch return error.AllocationFailed
    else
        models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(download_id);

    const track_id = json.requiredString(params, "track_id") catch return error.InvalidJson;
    const target_path = json.optionalString(params, "target_path");
    const state_name = json.optionalString(params, "state") orelse "queued";
    if (!isValidState(state_name)) return error.InvalidJson;
    const progress = normalizeProgress(json.optionalInt(params, "progress") catch return error.InvalidJson);
    const bytes_received = normalizeOptionalBytes(json.optionalInt(params, "bytes_received") catch return error.InvalidJson) orelse 0;
    const bytes_total = normalizeOptionalBytes(json.optionalInt(params, "bytes_total") catch return error.InvalidJson);
    const mime_type = json.optionalString(params, "mime_type");
    const stream_kind = json.optionalString(params, "stream_kind");
    const error_text = json.optionalString(params, "error_text");

    var stmt = state.db.prepare(
        \\INSERT INTO downloads (id, track_id, state, progress, bytes_received, bytes_total, mime_type, stream_kind, error_text, target_path, updated_at)
        \\VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\ON CONFLICT(id) DO UPDATE SET
        \\    track_id = excluded.track_id,
        \\    state = excluded.state,
        \\    progress = excluded.progress,
        \\    bytes_received = excluded.bytes_received,
        \\    bytes_total = excluded.bytes_total,
        \\    mime_type = excluded.mime_type,
        \\    stream_kind = excluded.stream_kind,
        \\    error_text = excluded.error_text,
        \\    target_path = excluded.target_path,
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    ) catch return error.Database;
    defer stmt.finalize();

    stmt.bindText(1, download_id) catch return error.Database;
    stmt.bindText(2, track_id) catch return error.Database;
    stmt.bindText(3, state_name) catch return error.Database;
    stmt.bindInt64(4, progress) catch return error.Database;
    stmt.bindInt64(5, bytes_received) catch return error.Database;
    stmt.bindOptionalInt64(6, bytes_total) catch return error.Database;
    stmt.bindOptionalText(7, mime_type) catch return error.Database;
    stmt.bindOptionalText(8, stream_kind) catch return error.Database;
    stmt.bindOptionalText(9, error_text) catch return error.Database;
    stmt.bindOptionalText(10, target_path) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const download = getDownloadById(state, download_id) catch return error.Database;
    defer download.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .download = download });
}

pub fn list(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const downloads = listDownloads(state) catch return error.Database;
    defer freeDownloads(state.allocator, downloads);
    return responses.makeSuccess(state.allocator, id, .{ .downloads = downloads });
}

pub fn update(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const download_id = json.requiredString(params, "id") catch return error.InvalidJson;
    const state_name = json.optionalString(params, "state");
    if (state_name) |value| {
        if (!isValidState(value)) return error.InvalidJson;
    }
    const progress = json.optionalInt(params, "progress") catch return error.InvalidJson;
    const bytes_received = json.optionalInt(params, "bytes_received") catch return error.InvalidJson;
    const bytes_total = json.optionalInt(params, "bytes_total") catch return error.InvalidJson;
    const mime_type = json.optionalString(params, "mime_type");
    const stream_kind = json.optionalString(params, "stream_kind");
    const error_text = json.optionalString(params, "error_text");
    const target_path = json.optionalString(params, "target_path");

    var stmt = state.db.prepare(
        \\UPDATE downloads
        \\SET state = COALESCE(?, state),
        \\    progress = COALESCE(?, progress),
        \\    bytes_received = COALESCE(?, bytes_received),
        \\    bytes_total = COALESCE(?, bytes_total),
        \\    mime_type = COALESCE(?, mime_type),
        \\    stream_kind = COALESCE(?, stream_kind),
        \\    error_text = COALESCE(?, error_text),
        \\    target_path = COALESCE(?, target_path),
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        \\WHERE id = ?
    ) catch return error.Database;
    defer stmt.finalize();

    stmt.bindOptionalText(1, state_name) catch return error.Database;
    stmt.bindOptionalInt64(2, if (progress) |value| normalizeProgress(value) else null) catch return error.Database;
    stmt.bindOptionalInt64(3, if (bytes_received) |value| normalizeBytes(value) else null) catch return error.Database;
    stmt.bindOptionalInt64(4, if (bytes_total) |value| normalizeBytes(value) else null) catch return error.Database;
    stmt.bindOptionalText(5, mime_type) catch return error.Database;
    stmt.bindOptionalText(6, stream_kind) catch return error.Database;
    stmt.bindOptionalText(7, error_text) catch return error.Database;
    stmt.bindOptionalText(8, target_path) catch return error.Database;
    stmt.bindText(9, download_id) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const download = getDownloadById(state, download_id) catch return error.Database;
    defer download.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .download = download });
}

pub fn remove(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const download_id = json.requiredString(params, "id") catch return error.InvalidJson;
    const download = getDownloadById(state, download_id) catch return error.Database;
    errdefer download.deinit(state.allocator);

    var stmt = state.db.prepare("DELETE FROM downloads WHERE id = ?") catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, download_id) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    defer download.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .removed = true, .download = download });
}

fn isValidState(value: []const u8) bool {
    for (valid_states) |state_name| {
        if (std.mem.eql(u8, value, state_name)) return true;
    }
    return false;
}

fn normalizeProgress(value: ?i64) i64 {
    const progress = value orelse 0;
    if (progress < 0) return 0;
    if (progress > 100) return 100;
    return progress;
}

fn normalizeBytes(value: i64) i64 {
    if (value < 0) return 0;
    return value;
}

fn normalizeOptionalBytes(value: ?i64) ?i64 {
    return if (value) |number| normalizeBytes(number) else null;
}

fn getDownloadById(state: *AppState, id: []const u8) sqlite.DbError!models.Download {
    var stmt = try state.db.prepare(download_select_sql ++ " WHERE d.id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return downloadFromStmt(state.allocator, &stmt);
}

fn listDownloads(state: *AppState) sqlite.DbError![]models.Download {
    var stmt = try state.db.prepare(download_select_sql ++ " ORDER BY d.updated_at DESC, d.created_at DESC, d.id DESC");
    defer stmt.finalize();

    var items: std.ArrayList(models.Download) = .empty;
    errdefer freeDownloads(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try downloadFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn downloadFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.Download {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .track_id = try stmt.columnOptionalText(allocator, 1),
        .state = try stmt.columnText(allocator, 2),
        .progress = stmt.columnOptionalInt64(3) orelse 0,
        .bytes_received = stmt.columnOptionalInt64(4) orelse 0,
        .bytes_total = stmt.columnOptionalInt64(5),
        .mime_type = try stmt.columnOptionalText(allocator, 6),
        .stream_kind = try stmt.columnOptionalText(allocator, 7),
        .error_text = try stmt.columnOptionalText(allocator, 8),
        .target_path = try stmt.columnOptionalText(allocator, 9),
        .created_at = try stmt.columnText(allocator, 10),
        .updated_at = try stmt.columnText(allocator, 11),
        .provider = try stmt.columnOptionalText(allocator, 12),
        .provider_track_id = try stmt.columnOptionalText(allocator, 13),
        .title = try stmt.columnOptionalText(allocator, 14),
        .artist = try stmt.columnOptionalText(allocator, 15),
        .album = try stmt.columnOptionalText(allocator, 16),
        .duration_ms = stmt.columnOptionalInt64(17),
        .artwork_url = try stmt.columnOptionalText(allocator, 18),
    };
}

fn freeDownloads(allocator: std.mem.Allocator, items: []models.Download) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}
