const std = @import("std");
const errors = @import("../errors.zig");
const models = @import("../models.zig");
const sqlite = @import("../sqlite.zig");
const AppState = @import("../state.zig").AppState;
const json = @import("json_helpers.zig");
const responses = @import("responses.zig");

const ObjectMap = std.json.ObjectMap;

pub fn playlistsCreate(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const playlist_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(playlist_id);
    const name = json.requiredString(params, "name") catch return error.InvalidJson;

    var stmt = state.db.prepare("INSERT INTO playlists(id, name) VALUES (?, ?)") catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, playlist_id) catch return error.Database;
    stmt.bindText(2, name) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const playlist = getPlaylistById(state, playlist_id) catch return error.Database;
    defer playlist.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .playlist = playlist });
}

pub fn playlistsList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const playlists = listPlaylists(state) catch return error.Database;
    defer freePlaylists(state.allocator, playlists);
    return responses.makeSuccess(state.allocator, id, .{ .playlists = playlists });
}

pub fn recentAdd(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(item_id);
    const track_id = json.requiredString(params, "track_id") catch return error.InvalidJson;
    const played_at = json.optionalString(params, "played_at");

    var stmt = state.db.prepare(
        \\INSERT INTO recent_tracks(id, track_id, played_at)
        \\VALUES (?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ) catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, item_id) catch return error.Database;
    stmt.bindText(2, track_id) catch return error.Database;
    stmt.bindOptionalText(3, played_at) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const item = getRecentById(state, item_id) catch return error.Database;
    defer item.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .item = item });
}

pub fn recentList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const items = listRecent(state) catch return error.Database;
    defer freeRecent(state.allocator, items);
    return responses.makeSuccess(state.allocator, id, .{ .items = items });
}

pub fn recentClear(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    var stmt = state.db.prepare("DELETE FROM recent_tracks") catch return error.Database;
    defer stmt.finalize();
    if ((stmt.step() catch return error.Database) != .done) return error.Database;
    return responses.makeSuccess(state.allocator, id, .{ .removed = state.db.changes() });
}

pub fn favoritesAdd(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(item_id);
    const track_id = json.requiredString(params, "track_id") catch return error.InvalidJson;
    const added_at = json.optionalString(params, "added_at");

    var stmt = state.db.prepare(
        \\INSERT INTO favorite_tracks(id, track_id, added_at)
        \\VALUES (?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))
        \\ON CONFLICT(track_id) DO UPDATE SET
        \\    added_at = excluded.added_at
    ) catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, item_id) catch return error.Database;
    stmt.bindText(2, track_id) catch return error.Database;
    stmt.bindOptionalText(3, added_at) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const item = getFavoriteByTrackId(state, track_id) catch return error.Database;
    defer item.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .item = item });
}

pub fn favoritesRemove(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const track_id = json.requiredString(params, "track_id") catch return error.InvalidJson;

    var stmt = state.db.prepare("DELETE FROM favorite_tracks WHERE track_id = ?") catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, track_id) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;
    return responses.makeSuccess(state.allocator, id, .{ .removed = state.db.changes() });
}

pub fn favoritesList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const items = listFavorites(state) catch return error.Database;
    defer freeFavorites(state.allocator, items);
    return responses.makeSuccess(state.allocator, id, .{ .items = items });
}

pub fn searchHistoryAdd(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(item_id);
    const query = json.requiredString(params, "query") catch return error.InvalidJson;
    const searched_at = json.optionalString(params, "searched_at");

    var stmt = state.db.prepare(
        \\INSERT INTO search_history(id, query, searched_at)
        \\VALUES (?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    ) catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, item_id) catch return error.Database;
    stmt.bindText(2, query) catch return error.Database;
    stmt.bindOptionalText(3, searched_at) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const item = getSearchById(state, item_id) catch return error.Database;
    defer item.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .item = item });
}

pub fn searchHistoryList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const items = listSearchHistory(state) catch return error.Database;
    defer freeSearchHistory(state.allocator, items);
    return responses.makeSuccess(state.allocator, id, .{ .items = items });
}

pub fn searchHistoryClear(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    var stmt = state.db.prepare("DELETE FROM search_history") catch return error.Database;
    defer stmt.finalize();
    if ((stmt.step() catch return error.Database) != .done) return error.Database;
    return responses.makeSuccess(state.allocator, id, .{ .removed = state.db.changes() });
}

pub fn settingsSet(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const key = json.requiredString(params, "key") catch return error.InvalidJson;
    const value = json.requiredString(params, "value") catch return error.InvalidJson;

    var stmt = state.db.prepare(
        \\INSERT INTO settings(key, value, updated_at)
        \\VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\ON CONFLICT(key) DO UPDATE SET
        \\    value = excluded.value,
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    ) catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, key) catch return error.Database;
    stmt.bindText(2, value) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const setting = getSettingByKey(state, key) catch return error.Database;
    defer setting.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .setting = setting });
}

pub fn settingsGet(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const key = json.requiredString(params, "key") catch return error.InvalidJson;
    const setting = getSettingByKey(state, key) catch return error.Database;
    defer setting.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .setting = setting });
}

pub fn getSettingByKey(state: *AppState, key: []const u8) sqlite.DbError!models.Setting {
    var stmt = try state.db.prepare("SELECT key, value, updated_at FROM settings WHERE key = ?");
    defer stmt.finalize();
    try stmt.bindText(1, key);

    if ((try stmt.step()) == .row) {
        return .{
            .key = try stmt.columnText(state.allocator, 0),
            .value = try stmt.columnOptionalText(state.allocator, 1),
            .updated_at = try stmt.columnOptionalText(state.allocator, 2),
        };
    }

    return .{
        .key = state.allocator.dupe(u8, key) catch return error.AllocationFailed,
        .value = null,
        .updated_at = null,
    };
}

pub fn setSettingValue(state: *AppState, key: []const u8, value: []const u8) sqlite.DbError!void {
    var stmt = try state.db.prepare(
        \\INSERT INTO settings(key, value, updated_at)
        \\VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        \\ON CONFLICT(key) DO UPDATE SET
        \\    value = excluded.value,
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    );
    defer stmt.finalize();
    try stmt.bindText(1, key);
    try stmt.bindText(2, value);
    if ((try stmt.step()) != .done) return error.Database;
}

fn getPlaylistById(state: *AppState, id: []const u8) sqlite.DbError!models.Playlist {
    var stmt = try state.db.prepare("SELECT id, name, created_at, updated_at FROM playlists WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return playlistFromStmt(state.allocator, &stmt);
}

fn listPlaylists(state: *AppState) sqlite.DbError![]models.Playlist {
    var stmt = try state.db.prepare("SELECT id, name, created_at, updated_at FROM playlists ORDER BY created_at DESC, id DESC");
    defer stmt.finalize();

    var items: std.ArrayList(models.Playlist) = .empty;
    errdefer freePlaylists(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try playlistFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn playlistFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.Playlist {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .name = try stmt.columnText(allocator, 1),
        .created_at = try stmt.columnText(allocator, 2),
        .updated_at = try stmt.columnText(allocator, 3),
    };
}

fn getRecentById(state: *AppState, id: []const u8) sqlite.DbError!models.RecentTrack {
    var stmt = try state.db.prepare(
        \\SELECT r.id, r.track_id, r.played_at, r.created_at,
        \\       t.provider, t.provider_track_id, t.title, t.artist, t.album, t.duration_ms, t.artwork_url
        \\FROM recent_tracks r
        \\JOIN tracks t ON t.id = r.track_id
        \\WHERE r.id = ?
    );
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return recentFromStmt(state.allocator, &stmt);
}

fn listRecent(state: *AppState) sqlite.DbError![]models.RecentTrack {
    var stmt = try state.db.prepare(
        \\SELECT r.id, r.track_id, r.played_at, r.created_at,
        \\       t.provider, t.provider_track_id, t.title, t.artist, t.album, t.duration_ms, t.artwork_url
        \\FROM recent_tracks r
        \\JOIN tracks t ON t.id = r.track_id
        \\ORDER BY r.played_at DESC, r.created_at DESC, r.id DESC
    );
    defer stmt.finalize();

    var items: std.ArrayList(models.RecentTrack) = .empty;
    errdefer freeRecent(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try recentFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn recentFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.RecentTrack {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .track_id = try stmt.columnText(allocator, 1),
        .played_at = try stmt.columnText(allocator, 2),
        .created_at = try stmt.columnText(allocator, 3),
        .provider = try stmt.columnOptionalText(allocator, 4),
        .provider_track_id = try stmt.columnOptionalText(allocator, 5),
        .title = try stmt.columnText(allocator, 6),
        .artist = try stmt.columnOptionalText(allocator, 7),
        .album = try stmt.columnOptionalText(allocator, 8),
        .duration_ms = stmt.columnOptionalInt64(9),
        .artwork_url = try stmt.columnOptionalText(allocator, 10),
    };
}

fn getFavoriteByTrackId(state: *AppState, track_id: []const u8) sqlite.DbError!models.FavoriteTrack {
    var stmt = try state.db.prepare(
        \\SELECT f.id, f.track_id, f.added_at, f.created_at,
        \\       t.provider, t.provider_track_id, t.title, t.artist, t.album, t.duration_ms, t.artwork_url
        \\FROM favorite_tracks f
        \\JOIN tracks t ON t.id = f.track_id
        \\WHERE f.track_id = ?
    );
    defer stmt.finalize();
    try stmt.bindText(1, track_id);
    if ((try stmt.step()) != .row) return error.Database;
    return favoriteFromStmt(state.allocator, &stmt);
}

fn listFavorites(state: *AppState) sqlite.DbError![]models.FavoriteTrack {
    var stmt = try state.db.prepare(
        \\SELECT f.id, f.track_id, f.added_at, f.created_at,
        \\       t.provider, t.provider_track_id, t.title, t.artist, t.album, t.duration_ms, t.artwork_url
        \\FROM favorite_tracks f
        \\JOIN tracks t ON t.id = f.track_id
        \\ORDER BY f.added_at DESC, f.created_at DESC, f.id DESC
    );
    defer stmt.finalize();

    var items: std.ArrayList(models.FavoriteTrack) = .empty;
    errdefer freeFavorites(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try favoriteFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn favoriteFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.FavoriteTrack {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .track_id = try stmt.columnText(allocator, 1),
        .added_at = try stmt.columnText(allocator, 2),
        .created_at = try stmt.columnText(allocator, 3),
        .provider = try stmt.columnOptionalText(allocator, 4),
        .provider_track_id = try stmt.columnOptionalText(allocator, 5),
        .title = try stmt.columnText(allocator, 6),
        .artist = try stmt.columnOptionalText(allocator, 7),
        .album = try stmt.columnOptionalText(allocator, 8),
        .duration_ms = stmt.columnOptionalInt64(9),
        .artwork_url = try stmt.columnOptionalText(allocator, 10),
    };
}

fn getSearchById(state: *AppState, id: []const u8) sqlite.DbError!models.SearchHistoryItem {
    var stmt = try state.db.prepare("SELECT id, query, searched_at FROM search_history WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return searchFromStmt(state.allocator, &stmt);
}

fn listSearchHistory(state: *AppState) sqlite.DbError![]models.SearchHistoryItem {
    var stmt = try state.db.prepare("SELECT id, query, searched_at FROM search_history ORDER BY searched_at DESC, created_at DESC, id DESC");
    defer stmt.finalize();

    var items: std.ArrayList(models.SearchHistoryItem) = .empty;
    errdefer freeSearchHistory(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try searchFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn searchFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.SearchHistoryItem {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .query = try stmt.columnText(allocator, 1),
        .searched_at = try stmt.columnText(allocator, 2),
    };
}

fn freePlaylists(allocator: std.mem.Allocator, items: []models.Playlist) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn freeRecent(allocator: std.mem.Allocator, items: []models.RecentTrack) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn freeFavorites(allocator: std.mem.Allocator, items: []models.FavoriteTrack) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn freeSearchHistory(allocator: std.mem.Allocator, items: []models.SearchHistoryItem) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}
