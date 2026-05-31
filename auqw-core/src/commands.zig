const std = @import("std");
const errors = @import("errors.zig");
const AppState = @import("state.zig").AppState;

const cache = @import("commands/cache.zig");
const core = @import("commands/core.zig");
const downloads = @import("commands/downloads.zig");
const json = @import("commands/json_helpers.zig");
const library = @import("commands/library.zig");
const playback = @import("commands/playback.zig");
const queue = @import("commands/queue.zig");
const responses = @import("commands/responses.zig");
const tracks = @import("commands/tracks.zig");

const ObjectMap = std.json.ObjectMap;
const Value = std.json.Value;

pub fn invoke(state: *AppState, request_json: []const u8) errors.CoreError![]u8 {
    var parsed = std.json.parseFromSlice(Value, state.allocator, request_json, .{}) catch return error.InvalidJson;
    defer parsed.deinit();

    if (parsed.value != .object) return error.InvalidJson;
    const root = parsed.value.object;
    const id = json.optionalString(root, "id") orelse "";
    const command = json.requiredString(root, "command") catch return error.InvalidJson;
    const params = json.paramsObject(root) catch return error.InvalidJson;

    if (std.mem.eql(u8, command, "core.get_metadata")) return core.getMetadata(state, id);
    if (std.mem.eql(u8, command, "cache.artwork.upsert")) return cache.artworkUpsert(state, id, params);
    if (std.mem.eql(u8, command, "cache.artwork.list")) return cache.artworkList(state, id);
    if (std.mem.eql(u8, command, "cache.artwork.remove")) return cache.artworkRemove(state, id, params);
    if (std.mem.eql(u8, command, "downloads.queue")) return downloads.queueDownload(state, id, params);
    if (std.mem.eql(u8, command, "downloads.list")) return downloads.list(state, id);
    if (std.mem.eql(u8, command, "downloads.update")) return downloads.update(state, id, params);
    if (std.mem.eql(u8, command, "downloads.remove")) return downloads.remove(state, id, params);
    if (std.mem.eql(u8, command, "tracks.upsert")) return tracks.upsert(state, id, params);
    if (std.mem.eql(u8, command, "tracks.list")) return tracks.list(state, id);
    if (std.mem.eql(u8, command, "local_files.upsert")) return tracks.localFilesUpsert(state, id, params);
    if (std.mem.eql(u8, command, "queue.add")) return queue.add(state, id, params);
    if (std.mem.eql(u8, command, "queue.list")) return queue.list(state, id);
    if (std.mem.eql(u8, command, "queue.remove")) return queue.remove(state, id, params);
    if (std.mem.eql(u8, command, "queue.clear")) return queue.clear(state, id);
    if (std.mem.eql(u8, command, "queue.move")) return queue.move(state, id, params);
    if (std.mem.eql(u8, command, "playback.get")) return playback.get(state, id);
    if (std.mem.eql(u8, command, "playback.load_queue_item")) return playback.loadQueueItem(state, id, params);
    if (std.mem.eql(u8, command, "playback.update")) return playback.update(state, id, params);
    if (std.mem.eql(u8, command, "playback.options.get")) return playback.optionsGet(state, id);
    if (std.mem.eql(u8, command, "playback.options.update")) return playback.optionsUpdate(state, id, params);
    if (std.mem.eql(u8, command, "playlists.create")) return library.playlistsCreate(state, id, params);
    if (std.mem.eql(u8, command, "playlists.list")) return library.playlistsList(state, id);
    if (std.mem.eql(u8, command, "recent.add")) return library.recentAdd(state, id, params);
    if (std.mem.eql(u8, command, "recent.list")) return library.recentList(state, id);
    if (std.mem.eql(u8, command, "search_history.add")) return library.searchHistoryAdd(state, id, params);
    if (std.mem.eql(u8, command, "search_history.list")) return library.searchHistoryList(state, id);
    if (std.mem.eql(u8, command, "settings.get")) return library.settingsGet(state, id, params);
    if (std.mem.eql(u8, command, "settings.set")) return library.settingsSet(state, id, params);

    return error.UnknownCommand;
}

pub fn makeErrorResponse(allocator: std.mem.Allocator, id: []const u8, err: errors.CoreError) []u8 {
    return responses.makeErrorResponse(allocator, id, err);
}

fn parsedInvoke(allocator: std.mem.Allocator, state: *AppState, request_json: []const u8) !std.json.Parsed(Value) {
    const response = try invoke(state, request_json);
    defer allocator.free(response);
    return std.json.parseFromSlice(Value, allocator, response, .{});
}

fn expectData(parsed: *const std.json.Parsed(Value), expected_id: []const u8) !ObjectMap {
    const root = parsed.value.object;
    try std.testing.expectEqualStrings(expected_id, root.get("id").?.string);
    try std.testing.expectEqual(true, root.get("ok").?.bool);
    return root.get("data").?.object;
}

fn createTestState(allocator: std.mem.Allocator, data_dir: ?[]const u8) !*AppState {
    return AppState.create(allocator, .{
        .app_id = "com.Vehicoule.auqw",
        .app_name = "Auqw",
        .data_dir = data_dir,
        .cache_dir = null,
    });
}

test "command dispatcher returns unknown command error" {
    const allocator = std.testing.allocator;
    var state = try createTestState(allocator, null);
    defer state.deinit();

    try std.testing.expectError(error.UnknownCommand, invoke(state, "{\"id\":\"bad\",\"command\":\"nope\",\"params\":{}}"));
}

test "metadata command contract includes schema version" {
    const allocator = std.testing.allocator;
    var state = try createTestState(allocator, null);
    defer state.deinit();

    var parsed = try parsedInvoke(allocator, state, "{\"id\":\"meta\",\"command\":\"core.get_metadata\",\"params\":{}}");
    defer parsed.deinit();

    const data = try expectData(&parsed, "meta");
    try std.testing.expectEqualStrings("com.Vehicoule.auqw", data.get("app_id").?.string);
    try std.testing.expectEqualStrings("Auqw", data.get("app_name").?.string);
    try std.testing.expectEqualStrings(":memory:", data.get("database_path").?.string);
    try std.testing.expectEqual(@as(i64, 5), data.get("schema_version").?.integer);
}

test "queue command contract preserves moved order" {
    const allocator = std.testing.allocator;
    var state = try createTestState(allocator, null);
    defer state.deinit();

    var alpha = try parsedInvoke(allocator, state, "{\"id\":\"alpha\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/alpha.mp3\",\"title\":\"Alpha\"}}");
    defer alpha.deinit();
    const alpha_track_id = try allocator.dupe(u8, (try expectData(&alpha, "alpha")).get("track").?.object.get("id").?.string);
    defer allocator.free(alpha_track_id);

    var beta = try parsedInvoke(allocator, state, "{\"id\":\"beta\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/beta.flac\",\"title\":\"Beta\"}}");
    defer beta.deinit();
    const beta_track_id = try allocator.dupe(u8, (try expectData(&beta, "beta")).get("track").?.object.get("id").?.string);
    defer allocator.free(beta_track_id);

    const add_alpha_request = try std.fmt.allocPrint(allocator, "{{\"id\":\"add-alpha\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{alpha_track_id});
    defer allocator.free(add_alpha_request);
    var add_alpha = try parsedInvoke(allocator, state, add_alpha_request);
    defer add_alpha.deinit();
    const alpha_queue_id = try allocator.dupe(u8, (try expectData(&add_alpha, "add-alpha")).get("item").?.object.get("id").?.string);
    defer allocator.free(alpha_queue_id);

    const add_beta_request = try std.fmt.allocPrint(allocator, "{{\"id\":\"add-beta\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{beta_track_id});
    defer allocator.free(add_beta_request);
    var add_beta = try parsedInvoke(allocator, state, add_beta_request);
    defer add_beta.deinit();
    const beta_queue_id = try allocator.dupe(u8, (try expectData(&add_beta, "add-beta")).get("item").?.object.get("id").?.string);
    defer allocator.free(beta_queue_id);

    const move_request = try std.fmt.allocPrint(allocator, "{{\"id\":\"move\",\"command\":\"queue.move\",\"params\":{{\"id\":\"{s}\",\"to_index\":0}}}}", .{beta_queue_id});
    defer allocator.free(move_request);
    var moved = try parsedInvoke(allocator, state, move_request);
    defer moved.deinit();

    const items = (try expectData(&moved, "move")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), items.len);
    try std.testing.expectEqualStrings(beta_queue_id, items[0].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 0), items[0].object.get("position").?.integer);
    try std.testing.expectEqualStrings(alpha_queue_id, items[1].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 1), items[1].object.get("position").?.integer);
}

test "playback options command contract persists settings" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const data_dir_len = try tmp.dir.realPath(std.testing.io, &data_dir_buf);
    const data_dir = data_dir_buf[0..data_dir_len];

    var first = try createTestState(allocator, data_dir);
    var updated = try parsedInvoke(allocator, first, "{\"id\":\"update\",\"command\":\"playback.options.update\",\"params\":{\"repeat_mode\":\"all\",\"shuffle_enabled\":true}}");
    defer updated.deinit();
    var options = (try expectData(&updated, "update")).get("options").?.object;
    try std.testing.expectEqualStrings("all", options.get("repeat_mode").?.string);
    try std.testing.expectEqual(true, options.get("shuffle_enabled").?.bool);
    first.deinit();

    var second = try createTestState(allocator, data_dir);
    defer second.deinit();

    var persisted = try parsedInvoke(allocator, second, "{\"id\":\"persisted\",\"command\":\"playback.options.get\",\"params\":{}}");
    defer persisted.deinit();
    options = (try expectData(&persisted, "persisted")).get("options").?.object;
    try std.testing.expectEqualStrings("all", options.get("repeat_mode").?.string);
    try std.testing.expectEqual(true, options.get("shuffle_enabled").?.bool);
}
