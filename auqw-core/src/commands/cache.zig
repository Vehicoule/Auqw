const std = @import("std");
const errors = @import("../errors.zig");
const models = @import("../models.zig");
const sqlite = @import("../sqlite.zig");
const AppState = @import("../state.zig").AppState;
const json = @import("json_helpers.zig");
const responses = @import("responses.zig");

const ObjectMap = std.json.ObjectMap;

pub fn artworkUpsert(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const track_id = json.optionalString(params, "track_id");
    const source_url = json.optionalString(params, "source_url");
    const cache_path = json.requiredString(params, "cache_path") catch return error.InvalidJson;
    if (track_id == null and source_url == null) return error.InvalidJson;

    const existing_artwork_id = findArtworkId(state, track_id, source_url) catch return error.Database;
    const artwork_id = existing_artwork_id orelse blk: {
        if (json.optionalString(params, "id")) |provided| {
            break :blk state.allocator.dupe(u8, provided) catch return error.AllocationFailed;
        }
        break :blk models.generateId(state.allocator) catch return error.AllocationFailed;
    };
    defer state.allocator.free(artwork_id);

    var stmt = state.db.prepare(
        \\INSERT INTO cached_artwork (id, track_id, source_url, cache_path, updated_at)
        \\VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\ON CONFLICT(id) DO UPDATE SET
        \\    track_id = excluded.track_id,
        \\    source_url = excluded.source_url,
        \\    cache_path = excluded.cache_path,
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    ) catch return error.Database;
    defer stmt.finalize();

    stmt.bindText(1, artwork_id) catch return error.Database;
    stmt.bindOptionalText(2, track_id) catch return error.Database;
    stmt.bindOptionalText(3, source_url) catch return error.Database;
    stmt.bindText(4, cache_path) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const artwork = getArtworkById(state, artwork_id) catch return error.Database;
    defer artwork.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .artwork = artwork });
}

pub fn artworkList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const artwork = listArtwork(state) catch return error.Database;
    defer freeArtwork(state.allocator, artwork);
    return responses.makeSuccess(state.allocator, id, .{ .artwork = artwork });
}

pub fn artworkRemove(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const artwork_id = json.requiredString(params, "id") catch return error.InvalidJson;
    const artwork = getArtworkById(state, artwork_id) catch return error.Database;
    errdefer artwork.deinit(state.allocator);

    var stmt = state.db.prepare("DELETE FROM cached_artwork WHERE id = ?") catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, artwork_id) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    defer artwork.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .removed = true, .artwork = artwork });
}

fn findArtworkId(state: *AppState, track_id: ?[]const u8, source_url: ?[]const u8) sqlite.DbError!?[]u8 {
    if (track_id) |value| {
        var stmt = try state.db.prepare("SELECT id FROM cached_artwork WHERE track_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1");
        defer stmt.finalize();
        try stmt.bindText(1, value);
        if ((try stmt.step()) == .row) return try stmt.columnText(state.allocator, 0);
    }

    if (source_url) |value| {
        var stmt = try state.db.prepare("SELECT id FROM cached_artwork WHERE source_url = ? ORDER BY updated_at DESC, id DESC LIMIT 1");
        defer stmt.finalize();
        try stmt.bindText(1, value);
        if ((try stmt.step()) == .row) return try stmt.columnText(state.allocator, 0);
    }

    return null;
}

fn getArtworkById(state: *AppState, id: []const u8) sqlite.DbError!models.CachedArtwork {
    var stmt = try state.db.prepare(
        \\SELECT id, track_id, source_url, cache_path, updated_at
        \\FROM cached_artwork
        \\WHERE id = ?
    );
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return artworkFromStmt(state.allocator, &stmt);
}

fn listArtwork(state: *AppState) sqlite.DbError![]models.CachedArtwork {
    var stmt = try state.db.prepare(
        \\SELECT id, track_id, source_url, cache_path, updated_at
        \\FROM cached_artwork
        \\ORDER BY updated_at DESC, id DESC
    );
    defer stmt.finalize();

    var items: std.ArrayList(models.CachedArtwork) = .empty;
    errdefer freeArtwork(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try artworkFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn artworkFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.CachedArtwork {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .track_id = try stmt.columnOptionalText(allocator, 1),
        .source_url = try stmt.columnOptionalText(allocator, 2),
        .cache_path = try stmt.columnText(allocator, 3),
        .updated_at = try stmt.columnText(allocator, 4),
    };
}

fn freeArtwork(allocator: std.mem.Allocator, items: []models.CachedArtwork) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}
