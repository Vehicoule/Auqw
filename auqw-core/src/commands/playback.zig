const std = @import("std");
const errors = @import("../errors.zig");
const models = @import("../models.zig");
const sqlite = @import("../sqlite.zig");
const AppState = @import("../state.zig").AppState;
const json = @import("json_helpers.zig");
const library = @import("library.zig");
const queue = @import("queue.zig");
const responses = @import("responses.zig");

const ObjectMap = std.json.ObjectMap;

const PlaybackOptions = struct {
    repeat_mode: []const u8,
    shuffle_enabled: bool,
};

pub fn get(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const playback = getPlaybackState(state) catch return error.Database;
    defer playback.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{ .playback = playback });
}

pub fn loadQueueItem(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const queue_item_id = json.requiredString(params, "id") catch return error.InvalidJson;
    const item = queue.getQueueItemById(state, queue_item_id) catch return error.Database;
    defer item.deinit(state.allocator);

    if (item.local_path == null and (item.provider == null or item.provider_track_id == null)) {
        updatePlaybackFromQueueItem(state, "error", item, null, item.duration_ms, "Queue item has no local file") catch return error.Database;
    } else {
        updatePlaybackFromQueueItem(state, "loading", item, null, item.duration_ms, null) catch return error.Database;
    }

    const playback = getPlaybackState(state) catch return error.Database;
    defer playback.deinit(state.allocator);
    return responses.makeSuccess(state.allocator, id, .{
        .playback = playback,
        .item = item,
    });
}

pub fn update(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const next_state = json.requiredString(params, "state") catch return error.InvalidJson;
    if (!isValidPlaybackState(next_state)) return error.InvalidJson;

    const current = getPlaybackState(state) catch return error.Database;
    defer current.deinit(state.allocator);

    const next_position_ms = if (params.get("position_ms") != null)
        json.optionalInt(params, "position_ms") catch return error.InvalidJson
    else
        current.position_ms;
    const next_duration_ms = if (params.get("duration_ms") != null)
        json.optionalInt(params, "duration_ms") catch return error.InvalidJson
    else
        current.duration_ms;
    const next_error_message = if (std.mem.eql(u8, next_state, "error"))
        json.optionalString(params, "error_message") orelse current.error_message
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
    return responses.makeSuccess(state.allocator, id, .{ .playback = playback });
}

pub fn optionsGet(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const options = getPlaybackOptions(state) catch return error.Database;
    return responses.makeSuccess(state.allocator, id, .{ .options = options });
}

pub fn optionsUpdate(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    if (params.get("repeat_mode")) |value| {
        if (value != .null) {
            const repeat_mode = json.requiredString(params, "repeat_mode") catch return error.InvalidJson;
            if (!isValidRepeatMode(repeat_mode)) return error.InvalidJson;
            library.setSettingValue(state, "playback.repeat_mode", repeat_mode) catch return error.Database;
        }
    }

    if (params.get("shuffle_enabled")) |value| {
        if (value != .null) {
            const shuffle_enabled = json.optionalBool(params, "shuffle_enabled") catch return error.InvalidJson;
            const shuffle_text = if (shuffle_enabled orelse false) "true" else "false";
            library.setSettingValue(state, "playback.shuffle_enabled", shuffle_text) catch return error.Database;
        }
    }

    const options = getPlaybackOptions(state) catch return error.Database;
    return responses.makeSuccess(state.allocator, id, .{ .options = options });
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
    return std.mem.eql(u8, value, "stopped") or std.mem.eql(u8, value, "loading") or std.mem.eql(u8, value, "playing") or std.mem.eql(u8, value, "paused") or std.mem.eql(u8, value, "error");
}

fn isValidRepeatMode(value: []const u8) bool {
    return std.mem.eql(u8, value, "off") or std.mem.eql(u8, value, "one") or std.mem.eql(u8, value, "all");
}

fn getPlaybackOptions(state: *AppState) sqlite.DbError!PlaybackOptions {
    const repeat_setting = try library.getSettingByKey(state, "playback.repeat_mode");
    defer repeat_setting.deinit(state.allocator);
    const shuffle_setting = try library.getSettingByKey(state, "playback.shuffle_enabled");
    defer shuffle_setting.deinit(state.allocator);

    return .{
        .repeat_mode = normalizeRepeatMode(repeat_setting.value),
        .shuffle_enabled = isTrueSetting(shuffle_setting.value),
    };
}

fn normalizeRepeatMode(value: ?[]const u8) []const u8 {
    const text = value orelse return "off";
    if (std.mem.eql(u8, text, "one")) return "one";
    if (std.mem.eql(u8, text, "all")) return "all";
    return "off";
}

fn isTrueSetting(value: ?[]const u8) bool {
    const text = value orelse return false;
    return std.mem.eql(u8, text, "true");
}
