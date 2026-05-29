const std = @import("std");
const errors = @import("errors.zig");
const migrations = @import("migrations.zig");
const models = @import("models.zig");
const sqlite = @import("sqlite.zig");
const AppState = @import("state.zig").AppState;

const ObjectMap = std.json.ObjectMap;
const Value = std.json.Value;

pub fn invoke(state: *AppState, request_json: []const u8) errors.CoreError![]u8 {
    var parsed = std.json.parseFromSlice(Value, state.allocator, request_json, .{}) catch return error.InvalidJson;
    defer parsed.deinit();

    if (parsed.value != .object) return error.InvalidJson;
    const root = parsed.value.object;
    const id = optionalString(root, "id") orelse "";
    const command = requiredString(root, "command") catch return error.InvalidJson;
    const params = paramsObject(root) catch return error.InvalidJson;

    if (std.mem.eql(u8, command, "core.get_metadata")) return getMetadata(state, id);
    if (std.mem.eql(u8, command, "tracks.upsert")) return tracksUpsert(state, id, params);
    if (std.mem.eql(u8, command, "tracks.list")) return tracksList(state, id);
    if (std.mem.eql(u8, command, "local_files.upsert")) return localFilesUpsert(state, id, params);
    if (std.mem.eql(u8, command, "queue.add")) return queueAdd(state, id, params);
    if (std.mem.eql(u8, command, "queue.list")) return queueList(state, id);
    if (std.mem.eql(u8, command, "queue.remove")) return queueRemove(state, id, params);
    if (std.mem.eql(u8, command, "queue.clear")) return queueClear(state, id);
    if (std.mem.eql(u8, command, "playback.get")) return playbackGet(state, id);
    if (std.mem.eql(u8, command, "playback.load_queue_item")) return playbackLoadQueueItem(state, id, params);
    if (std.mem.eql(u8, command, "playback.update")) return playbackUpdate(state, id, params);
    if (std.mem.eql(u8, command, "playlists.create")) return playlistsCreate(state, id, params);
    if (std.mem.eql(u8, command, "playlists.list")) return playlistsList(state, id);
    if (std.mem.eql(u8, command, "recent.add")) return recentAdd(state, id, params);
    if (std.mem.eql(u8, command, "recent.list")) return recentList(state, id);
    if (std.mem.eql(u8, command, "search_history.add")) return searchHistoryAdd(state, id, params);
    if (std.mem.eql(u8, command, "search_history.list")) return searchHistoryList(state, id);
    if (std.mem.eql(u8, command, "settings.get")) return settingsGet(state, id, params);
    if (std.mem.eql(u8, command, "settings.set")) return settingsSet(state, id, params);

    return error.UnknownCommand;
}

pub fn makeErrorResponse(allocator: std.mem.Allocator, id: []const u8, err: errors.CoreError) []u8 {
    return std.json.Stringify.valueAlloc(allocator, .{
        .id = id,
        .ok = false,
        .@"error" = .{
            .code = errors.jsonCode(err),
            .message = errors.message(err),
        },
    }, .{}) catch blk: {
        break :blk allocator.dupe(u8, "{\"id\":\"\",\"ok\":false,\"error\":{\"code\":\"allocation_failed\",\"message\":\"Allocation failed\"}}") catch "";
    };
}

fn makeSuccess(allocator: std.mem.Allocator, id: []const u8, data: anytype) errors.CoreError![]u8 {
    return std.json.Stringify.valueAlloc(allocator, .{
        .id = id,
        .ok = true,
        .data = data,
    }, .{}) catch return error.AllocationFailed;
}

fn getMetadata(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const version = migrations.currentVersion(&state.db) catch return error.Database;
    return makeSuccess(state.allocator, id, .{
        .app_id = state.app_id[0..state.app_id.len],
        .app_name = state.app_name[0..state.app_name.len],
        .database_path = state.db.path[0..state.db.path.len],
        .schema_version = version,
    });
}

fn tracksUpsert(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const track_id = if (optionalString(params, "id")) |value|
        state.allocator.dupe(u8, value) catch return error.AllocationFailed
    else
        models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(track_id);

    const title = requiredString(params, "title") catch return error.InvalidJson;
    const artist = optionalString(params, "artist");
    const album = optionalString(params, "album");
    const duration_ms = optionalInt(params, "duration_ms") catch return error.InvalidJson;
    const artwork_url = optionalString(params, "artwork_url");
    const provider = optionalString(params, "provider");
    const provider_track_id = optionalString(params, "provider_track_id");

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

    return makeSuccess(state.allocator, id, .{ .track = track });
}

fn tracksList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const tracks = listTracks(state) catch return error.Database;
    defer freeTracks(state.allocator, tracks);
    return makeSuccess(state.allocator, id, .{ .tracks = tracks });
}

fn localFilesUpsert(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const path = requiredString(params, "path") catch return error.InvalidJson;
    const title = requiredString(params, "title") catch return error.InvalidJson;
    const artist = optionalString(params, "artist");
    const album = optionalString(params, "album");
    const duration_ms = optionalInt(params, "duration_ms") catch return error.InvalidJson;

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

    return makeSuccess(state.allocator, id, .{
        .track = track,
        .local_file = local_file,
    });
}

fn queueAdd(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(item_id);
    const track_id = requiredString(params, "track_id") catch return error.InvalidJson;

    var stmt = state.db.prepare(
        \\INSERT INTO queue_items(id, track_id, position)
        \\SELECT ?, tracks.id, COALESCE((SELECT MAX(position) + 1 FROM queue_items), 0)
        \\FROM tracks
        \\WHERE tracks.id = ?
    ) catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, item_id) catch return error.Database;
    stmt.bindText(2, track_id) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const item = getQueueItemById(state, item_id) catch return error.Database;
    defer item.deinit(state.allocator);
    return makeSuccess(state.allocator, id, .{ .item = item });
}

fn queueList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const items = listQueue(state) catch return error.Database;
    defer freeQueueItems(state.allocator, items);
    return makeSuccess(state.allocator, id, .{ .items = items });
}

fn queueRemove(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = requiredString(params, "id") catch return error.InvalidJson;

    var stmt = state.db.prepare("DELETE FROM queue_items WHERE id = ?") catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, item_id) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    return queueList(state, id);
}

fn queueClear(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    state.db.exec("DELETE FROM queue_items") catch return error.Database;
    return queueList(state, id);
}

fn playbackGet(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const playback = getPlaybackState(state) catch return error.Database;
    defer playback.deinit(state.allocator);
    return makeSuccess(state.allocator, id, .{ .playback = playback });
}

fn playbackLoadQueueItem(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const queue_item_id = requiredString(params, "id") catch return error.InvalidJson;
    const item = getQueueItemById(state, queue_item_id) catch return error.Database;
    defer item.deinit(state.allocator);

    if (item.local_path == null) {
        updatePlaybackFromQueueItem(state, "error", item, null, item.duration_ms, "Queue item has no local file") catch return error.Database;
    } else {
        updatePlaybackFromQueueItem(state, "loading", item, null, item.duration_ms, null) catch return error.Database;
    }

    const playback = getPlaybackState(state) catch return error.Database;
    defer playback.deinit(state.allocator);
    return makeSuccess(state.allocator, id, .{
        .playback = playback,
        .item = item,
    });
}

fn playbackUpdate(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const next_state = requiredString(params, "state") catch return error.InvalidJson;
    if (!isValidPlaybackState(next_state)) return error.InvalidJson;

    const current = getPlaybackState(state) catch return error.Database;
    defer current.deinit(state.allocator);

    const next_position_ms = if (params.get("position_ms") != null)
        optionalInt(params, "position_ms") catch return error.InvalidJson
    else
        current.position_ms;
    const next_duration_ms = if (params.get("duration_ms") != null)
        optionalInt(params, "duration_ms") catch return error.InvalidJson
    else
        current.duration_ms;
    const next_error_message = if (std.mem.eql(u8, next_state, "error"))
        optionalString(params, "error_message") orelse current.error_message
    else
        null;

    updatePlaybackFull(
        state,
        next_state,
        current.queue_item_id,
        current.track_id,
        current.title,
        current.artist,
        current.album,
        current.artwork_url,
        current.local_path,
        next_position_ms,
        next_duration_ms,
        next_error_message,
    ) catch return error.Database;

    const playback = getPlaybackState(state) catch return error.Database;
    defer playback.deinit(state.allocator);
    return makeSuccess(state.allocator, id, .{ .playback = playback });
}

fn playlistsCreate(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const playlist_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(playlist_id);
    const name = requiredString(params, "name") catch return error.InvalidJson;

    var stmt = state.db.prepare("INSERT INTO playlists(id, name) VALUES (?, ?)") catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, playlist_id) catch return error.Database;
    stmt.bindText(2, name) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    const playlist = getPlaylistById(state, playlist_id) catch return error.Database;
    defer playlist.deinit(state.allocator);
    return makeSuccess(state.allocator, id, .{ .playlist = playlist });
}

fn playlistsList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const playlists = listPlaylists(state) catch return error.Database;
    defer freePlaylists(state.allocator, playlists);
    return makeSuccess(state.allocator, id, .{ .playlists = playlists });
}

fn recentAdd(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(item_id);
    const track_id = requiredString(params, "track_id") catch return error.InvalidJson;
    const played_at = optionalString(params, "played_at");

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
    return makeSuccess(state.allocator, id, .{ .item = item });
}

fn recentList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const items = listRecent(state) catch return error.Database;
    defer freeRecent(state.allocator, items);
    return makeSuccess(state.allocator, id, .{ .items = items });
}

fn searchHistoryAdd(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(item_id);
    const query = requiredString(params, "query") catch return error.InvalidJson;
    const searched_at = optionalString(params, "searched_at");

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
    return makeSuccess(state.allocator, id, .{ .item = item });
}

fn searchHistoryList(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const items = listSearchHistory(state) catch return error.Database;
    defer freeSearchHistory(state.allocator, items);
    return makeSuccess(state.allocator, id, .{ .items = items });
}

fn settingsSet(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const key = requiredString(params, "key") catch return error.InvalidJson;
    const value = requiredString(params, "value") catch return error.InvalidJson;

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
    return makeSuccess(state.allocator, id, .{ .setting = setting });
}

fn settingsGet(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const key = requiredString(params, "key") catch return error.InvalidJson;
    const setting = getSettingByKey(state, key) catch return error.Database;
    defer setting.deinit(state.allocator);
    return makeSuccess(state.allocator, id, .{ .setting = setting });
}

fn getTrackById(state: *AppState, id: []const u8) sqlite.DbError!models.Track {
    var stmt = try state.db.prepare(
        \\SELECT id, title, artist, album, duration_ms, artwork_url, created_at, updated_at
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
        \\SELECT id, title, artist, album, duration_ms, artwork_url, created_at, updated_at
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
        \\SELECT id, title, artist, album, duration_ms, artwork_url, created_at, updated_at
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
        .title = try stmt.columnText(allocator, 1),
        .artist = try stmt.columnOptionalText(allocator, 2),
        .album = try stmt.columnOptionalText(allocator, 3),
        .duration_ms = stmt.columnOptionalInt64(4),
        .artwork_url = try stmt.columnOptionalText(allocator, 5),
        .created_at = try stmt.columnText(allocator, 6),
        .updated_at = try stmt.columnText(allocator, 7),
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

fn getQueueItemById(state: *AppState, id: []const u8) sqlite.DbError!models.QueueItem {
    var stmt = try state.db.prepare(
        \\SELECT
        \\    queue_items.id,
        \\    queue_items.track_id,
        \\    queue_items.position,
        \\    queue_items.added_at,
        \\    tracks.title,
        \\    tracks.artist,
        \\    tracks.album,
        \\    tracks.duration_ms,
        \\    tracks.artwork_url,
        \\    local_files.path
        \\FROM queue_items
        \\JOIN tracks ON tracks.id = queue_items.track_id
        \\LEFT JOIN local_files ON local_files.track_id = queue_items.track_id
        \\WHERE queue_items.id = ?
    );
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return queueItemFromStmt(state.allocator, &stmt);
}

fn listQueue(state: *AppState) sqlite.DbError![]models.QueueItem {
    var stmt = try state.db.prepare(
        \\SELECT
        \\    queue_items.id,
        \\    queue_items.track_id,
        \\    queue_items.position,
        \\    queue_items.added_at,
        \\    tracks.title,
        \\    tracks.artist,
        \\    tracks.album,
        \\    tracks.duration_ms,
        \\    tracks.artwork_url,
        \\    local_files.path
        \\FROM queue_items
        \\JOIN tracks ON tracks.id = queue_items.track_id
        \\LEFT JOIN local_files ON local_files.track_id = queue_items.track_id
        \\ORDER BY queue_items.position ASC, queue_items.added_at ASC, queue_items.id ASC
    );
    defer stmt.finalize();

    var items: std.ArrayList(models.QueueItem) = .empty;
    errdefer freeQueueItems(state.allocator, items.items);
    while ((try stmt.step()) == .row) {
        const item = try queueItemFromStmt(state.allocator, &stmt);
        items.append(state.allocator, item) catch {
            item.deinit(state.allocator);
            return error.AllocationFailed;
        };
    }
    return items.toOwnedSlice(state.allocator) catch return error.AllocationFailed;
}

fn queueItemFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.QueueItem {
    return .{
        .id = try stmt.columnText(allocator, 0),
        .track_id = try stmt.columnText(allocator, 1),
        .position = stmt.columnOptionalInt64(2) orelse 0,
        .added_at = try stmt.columnText(allocator, 3),
        .title = try stmt.columnText(allocator, 4),
        .artist = try stmt.columnOptionalText(allocator, 5),
        .album = try stmt.columnOptionalText(allocator, 6),
        .duration_ms = stmt.columnOptionalInt64(7),
        .artwork_url = try stmt.columnOptionalText(allocator, 8),
        .local_path = try stmt.columnOptionalText(allocator, 9),
    };
}

fn getPlaybackState(state: *AppState) sqlite.DbError!models.PlaybackState {
    var stmt = try state.db.prepare(
        \\SELECT
        \\    state,
        \\    queue_item_id,
        \\    track_id,
        \\    title,
        \\    artist,
        \\    album,
        \\    artwork_url,
        \\    local_path,
        \\    position_ms,
        \\    duration_ms,
        \\    error_message
        \\FROM playback_state
        \\WHERE id = 1
    );
    defer stmt.finalize();
    if ((try stmt.step()) != .row) return error.Database;
    return playbackStateFromStmt(state.allocator, &stmt);
}

fn playbackStateFromStmt(allocator: std.mem.Allocator, stmt: *sqlite.Statement) sqlite.DbError!models.PlaybackState {
    return .{
        .state = try stmt.columnText(allocator, 0),
        .queue_item_id = try stmt.columnOptionalText(allocator, 1),
        .track_id = try stmt.columnOptionalText(allocator, 2),
        .title = try stmt.columnOptionalText(allocator, 3),
        .artist = try stmt.columnOptionalText(allocator, 4),
        .album = try stmt.columnOptionalText(allocator, 5),
        .artwork_url = try stmt.columnOptionalText(allocator, 6),
        .local_path = try stmt.columnOptionalText(allocator, 7),
        .position_ms = stmt.columnOptionalInt64(8),
        .duration_ms = stmt.columnOptionalInt64(9),
        .error_message = try stmt.columnOptionalText(allocator, 10),
    };
}

fn updatePlaybackFromQueueItem(
    state: *AppState,
    playback_state: []const u8,
    item: models.QueueItem,
    position_ms: ?i64,
    duration_ms: ?i64,
    error_message: ?[]const u8,
) sqlite.DbError!void {
    try updatePlaybackFull(
        state,
        playback_state,
        item.id,
        item.track_id,
        item.title,
        item.artist,
        item.album,
        item.artwork_url,
        item.local_path,
        position_ms,
        duration_ms,
        error_message,
    );
}

fn updatePlaybackFull(
    state: *AppState,
    playback_state: []const u8,
    queue_item_id: ?[]const u8,
    track_id: ?[]const u8,
    title: ?[]const u8,
    artist: ?[]const u8,
    album: ?[]const u8,
    artwork_url: ?[]const u8,
    local_path: ?[]const u8,
    position_ms: ?i64,
    duration_ms: ?i64,
    error_message: ?[]const u8,
) sqlite.DbError!void {
    var stmt = try state.db.prepare(
        \\UPDATE playback_state
        \\SET
        \\    state = ?,
        \\    queue_item_id = ?,
        \\    track_id = ?,
        \\    title = ?,
        \\    artist = ?,
        \\    album = ?,
        \\    artwork_url = ?,
        \\    local_path = ?,
        \\    position_ms = ?,
        \\    duration_ms = ?,
        \\    error_message = ?,
        \\    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        \\WHERE id = 1
    );
    defer stmt.finalize();

    try stmt.bindText(1, playback_state);
    try stmt.bindOptionalText(2, queue_item_id);
    try stmt.bindOptionalText(3, track_id);
    try stmt.bindOptionalText(4, title);
    try stmt.bindOptionalText(5, artist);
    try stmt.bindOptionalText(6, album);
    try stmt.bindOptionalText(7, artwork_url);
    try stmt.bindOptionalText(8, local_path);
    try stmt.bindOptionalInt64(9, position_ms);
    try stmt.bindOptionalInt64(10, duration_ms);
    try stmt.bindOptionalText(11, error_message);
    if ((try stmt.step()) != .done) return error.Database;
}

fn isValidPlaybackState(value: []const u8) bool {
    return std.mem.eql(u8, value, "stopped")
        or std.mem.eql(u8, value, "loading")
        or std.mem.eql(u8, value, "playing")
        or std.mem.eql(u8, value, "paused")
        or std.mem.eql(u8, value, "error");
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
    var stmt = try state.db.prepare("SELECT id, track_id, played_at, created_at FROM recent_tracks WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindText(1, id);
    if ((try stmt.step()) != .row) return error.Database;
    return recentFromStmt(state.allocator, &stmt);
}

fn listRecent(state: *AppState) sqlite.DbError![]models.RecentTrack {
    var stmt = try state.db.prepare("SELECT id, track_id, played_at, created_at FROM recent_tracks ORDER BY played_at DESC, created_at DESC, id DESC");
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

fn getSettingByKey(state: *AppState, key: []const u8) sqlite.DbError!models.Setting {
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

fn freeTracks(allocator: std.mem.Allocator, items: []models.Track) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn freeQueueItems(allocator: std.mem.Allocator, items: []models.QueueItem) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn freePlaylists(allocator: std.mem.Allocator, items: []models.Playlist) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn freeRecent(allocator: std.mem.Allocator, items: []models.RecentTrack) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn freeSearchHistory(allocator: std.mem.Allocator, items: []models.SearchHistoryItem) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}

fn paramsObject(root: ObjectMap) !ObjectMap {
    const value = root.get("params") orelse return error.InvalidJson;
    if (value != .object) return error.InvalidJson;
    return value.object;
}

fn requiredString(object: ObjectMap, key: []const u8) ![]const u8 {
    return optionalString(object, key) orelse error.InvalidJson;
}

fn optionalString(object: ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .string => |text| text,
        .null => null,
        else => null,
    };
}

fn optionalInt(object: ObjectMap, key: []const u8) !?i64 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .integer => |number| number,
        .null => null,
        else => error.InvalidJson,
    };
}
