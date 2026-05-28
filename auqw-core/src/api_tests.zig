const std = @import("std");
const api = @import("api.zig");

const allocator = std.testing.allocator;
const error_ok: c_int = 0;
const error_invalid_json: c_int = 4;
const error_unknown_command: c_int = 5;

fn expectInvoke(core: *api.AuqwCore, request: [:0]const u8) !std.json.Parsed(std.json.Value) {
    var out: ?[*:0]u8 = null;
    const result = api.auqw_core_invoke_json(core, request, &out);
    try std.testing.expectEqual(error_ok, result);

    const response = out orelse return error.MissingResponse;
    defer api.auqw_free(response);

    return std.json.parseFromSlice(std.json.Value, allocator, std.mem.span(response), .{});
}

fn expectErrorInvoke(core: *api.AuqwCore, request: [:0]const u8, expected: c_int, expected_code: []const u8) !void {
    var out: ?[*:0]u8 = null;
    const result = api.auqw_core_invoke_json(core, request, &out);
    try std.testing.expectEqual(expected, result);

    const response = out orelse return error.MissingResponse;
    defer api.auqw_free(response);

    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, std.mem.span(response), .{});
    defer parsed.deinit();

    const root = parsed.value.object;
    try std.testing.expectEqual(false, root.get("ok").?.bool);
    try std.testing.expectEqualStrings(expected_code, root.get("error").?.object.get("code").?.string);
}

fn expectOk(parsed: std.json.Parsed(std.json.Value), expected_id: []const u8) !std.json.ObjectMap {
    const root = parsed.value.object;
    try std.testing.expectEqualStrings(expected_id, root.get("id").?.string);
    try std.testing.expectEqual(true, root.get("ok").?.bool);
    return root.get("data").?.object;
}

test "core metadata reports app details and migrated schema" {
    var core: ?*api.AuqwCore = null;
    const options = api.AuqwInitOptions{
        .app_id = "com.Vehicoule.auqw",
        .app_name = "Auqw",
        .data_dir = null,
        .cache_dir = null,
    };
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &core));
    defer api.auqw_core_destroy(core);

    var response = try expectInvoke(core.?, "{\"id\":\"meta\",\"command\":\"core.get_metadata\",\"params\":{}}");
    defer response.deinit();

    const data = try expectOk(response, "meta");
    try std.testing.expectEqualStrings("com.Vehicoule.auqw", data.get("app_id").?.string);
    try std.testing.expectEqualStrings("Auqw", data.get("app_name").?.string);
    try std.testing.expectEqualStrings(":memory:", data.get("database_path").?.string);
    try std.testing.expectEqual(@as(i64, 2), data.get("schema_version").?.integer);
}

test "migrations are idempotent for file databases" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var data_dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const data_dir_len = try tmp.dir.realPath(std.testing.io, &data_dir_buf);
    const data_dir_z = try allocator.dupeZ(u8, data_dir_buf[0..data_dir_len]);
    defer allocator.free(data_dir_z);

    const options = api.AuqwInitOptions{
        .app_id = "com.Vehicoule.auqw",
        .app_name = "Auqw",
        .data_dir = data_dir_z.ptr,
        .cache_dir = null,
    };

    var first: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &first));
    api.auqw_core_destroy(first);

    var second: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &second));
    defer api.auqw_core_destroy(second);

    var response = try expectInvoke(second.?, "{\"id\":\"meta\",\"command\":\"core.get_metadata\",\"params\":{}}");
    defer response.deinit();
    const data = try expectOk(response, "meta");
    try std.testing.expectEqual(@as(i64, 2), data.get("schema_version").?.integer);
}

test "tracks upsert and list round trip" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var upsert = try expectInvoke(core.?, "{\"id\":\"upsert\",\"command\":\"tracks.upsert\",\"params\":{\"title\":\"Eon\",\"artist\":\"Vela\",\"album\":\"North\",\"duration_ms\":1234}}");
    defer upsert.deinit();
    const track = (try expectOk(upsert, "upsert")).get("track").?.object;
    const track_id = track.get("id").?.string;
    try std.testing.expect(track_id.len >= 32);
    try std.testing.expectEqualStrings("Eon", track.get("title").?.string);

    var list = try expectInvoke(core.?, "{\"id\":\"list\",\"command\":\"tracks.list\",\"params\":{}}");
    defer list.deinit();
    const tracks = (try expectOk(list, "list")).get("tracks").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), tracks.len);
    try std.testing.expectEqualStrings(track_id, tracks[0].object.get("id").?.string);
    try std.testing.expectEqualStrings("Vela", tracks[0].object.get("artist").?.string);
}

test "local files upsert creates idempotent local track" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var first = try expectInvoke(core.?, "{\"id\":\"local-1\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/alpha.mp3\",\"title\":\"Alpha\"}}");
    defer first.deinit();
    const first_data = try expectOk(first, "local-1");
    const first_track = first_data.get("track").?.object;
    const first_local_file = first_data.get("local_file").?.object;
    const first_track_id = first_track.get("id").?.string;
    const first_local_file_id = first_local_file.get("id").?.string;
    try std.testing.expect(first_track_id.len >= 32);
    try std.testing.expect(first_local_file_id.len >= 32);
    try std.testing.expectEqualStrings("Alpha", first_track.get("title").?.string);
    try std.testing.expectEqualStrings("/music/alpha.mp3", first_local_file.get("path").?.string);
    try std.testing.expectEqualStrings(first_track_id, first_local_file.get("track_id").?.string);

    var second = try expectInvoke(core.?, "{\"id\":\"local-2\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/alpha.mp3\",\"title\":\"Alpha Renamed\",\"artist\":\"Vela\",\"duration_ms\":4321}}");
    defer second.deinit();
    const second_data = try expectOk(second, "local-2");
    const second_track = second_data.get("track").?.object;
    const second_local_file = second_data.get("local_file").?.object;
    try std.testing.expectEqualStrings(first_track_id, second_track.get("id").?.string);
    try std.testing.expectEqualStrings(first_local_file_id, second_local_file.get("id").?.string);
    try std.testing.expectEqualStrings("Alpha Renamed", second_track.get("title").?.string);
    try std.testing.expectEqualStrings("Vela", second_track.get("artist").?.string);

    var list = try expectInvoke(core.?, "{\"id\":\"list\",\"command\":\"tracks.list\",\"params\":{}}");
    defer list.deinit();
    const tracks = (try expectOk(list, "list")).get("tracks").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), tracks.len);
    try std.testing.expectEqualStrings(first_track_id, tracks[0].object.get("id").?.string);
    try std.testing.expectEqualStrings("Alpha Renamed", tracks[0].object.get("title").?.string);
}

test "queue commands append duplicate local tracks and return joined items" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var alpha = try expectInvoke(core.?, "{\"id\":\"local-alpha\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/alpha.mp3\",\"title\":\"Alpha\",\"artist\":\"Vela\",\"album\":\"North\",\"duration_ms\":1234}}");
    defer alpha.deinit();
    const alpha_track_id = (try expectOk(alpha, "local-alpha")).get("track").?.object.get("id").?.string;

    var beta = try expectInvoke(core.?, "{\"id\":\"local-beta\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/beta.flac\",\"title\":\"Beta\",\"artist\":\"Orion\",\"album\":\"South\",\"duration_ms\":5678}}");
    defer beta.deinit();
    const beta_track_id = (try expectOk(beta, "local-beta")).get("track").?.object.get("id").?.string;

    const add_alpha_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-alpha\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{alpha_track_id}, 0);
    defer allocator.free(add_alpha_request);
    var add_alpha = try expectInvoke(core.?, add_alpha_request);
    defer add_alpha.deinit();
    const first_item = (try expectOk(add_alpha, "add-alpha")).get("item").?.object;
    const first_queue_id = try allocator.dupe(u8, first_item.get("id").?.string);
    defer allocator.free(first_queue_id);
    try std.testing.expect(first_queue_id.len >= 32);
    try std.testing.expectEqualStrings(alpha_track_id, first_item.get("track_id").?.string);
    try std.testing.expectEqual(@as(i64, 0), first_item.get("position").?.integer);
    try std.testing.expect(first_item.get("added_at").?.string.len > 0);
    try std.testing.expectEqualStrings("Alpha", first_item.get("title").?.string);
    try std.testing.expectEqualStrings("Vela", first_item.get("artist").?.string);
    try std.testing.expectEqualStrings("North", first_item.get("album").?.string);
    try std.testing.expectEqual(@as(i64, 1234), first_item.get("duration_ms").?.integer);
    try std.testing.expectEqualStrings("/music/alpha.mp3", first_item.get("local_path").?.string);

    const add_alpha_again_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-alpha-again\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{alpha_track_id}, 0);
    defer allocator.free(add_alpha_again_request);
    var add_alpha_again = try expectInvoke(core.?, add_alpha_again_request);
    defer add_alpha_again.deinit();
    const second_item = (try expectOk(add_alpha_again, "add-alpha-again")).get("item").?.object;
    const second_queue_id = try allocator.dupe(u8, second_item.get("id").?.string);
    defer allocator.free(second_queue_id);
    try std.testing.expect(!std.mem.eql(u8, first_queue_id, second_queue_id));
    try std.testing.expectEqualStrings(alpha_track_id, second_item.get("track_id").?.string);
    try std.testing.expectEqual(@as(i64, 1), second_item.get("position").?.integer);

    const add_beta_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-beta\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{beta_track_id}, 0);
    defer allocator.free(add_beta_request);
    var add_beta = try expectInvoke(core.?, add_beta_request);
    defer add_beta.deinit();
    const third_item = (try expectOk(add_beta, "add-beta")).get("item").?.object;
    const third_queue_id = try allocator.dupe(u8, third_item.get("id").?.string);
    defer allocator.free(third_queue_id);
    try std.testing.expectEqualStrings(beta_track_id, third_item.get("track_id").?.string);
    try std.testing.expectEqual(@as(i64, 2), third_item.get("position").?.integer);
    try std.testing.expectEqualStrings("/music/beta.flac", third_item.get("local_path").?.string);

    var list = try expectInvoke(core.?, "{\"id\":\"queue-list\",\"command\":\"queue.list\",\"params\":{}}");
    defer list.deinit();
    const listed_items = (try expectOk(list, "queue-list")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 3), listed_items.len);
    try std.testing.expectEqualStrings(first_queue_id, listed_items[0].object.get("id").?.string);
    try std.testing.expectEqualStrings(second_queue_id, listed_items[1].object.get("id").?.string);
    try std.testing.expectEqualStrings(third_queue_id, listed_items[2].object.get("id").?.string);

    const remove_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"queue-remove\",\"command\":\"queue.remove\",\"params\":{{\"id\":\"{s}\"}}}}", .{first_queue_id}, 0);
    defer allocator.free(remove_request);
    var removed = try expectInvoke(core.?, remove_request);
    defer removed.deinit();
    const remaining_items = (try expectOk(removed, "queue-remove")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), remaining_items.len);
    try std.testing.expectEqualStrings(second_queue_id, remaining_items[0].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 1), remaining_items[0].object.get("position").?.integer);
    try std.testing.expectEqualStrings(third_queue_id, remaining_items[1].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 2), remaining_items[1].object.get("position").?.integer);

    var cleared = try expectInvoke(core.?, "{\"id\":\"queue-clear\",\"command\":\"queue.clear\",\"params\":{}}");
    defer cleared.deinit();
    try std.testing.expectEqual(@as(usize, 0), (try expectOk(cleared, "queue-clear")).get("items").?.array.items.len);

    var empty = try expectInvoke(core.?, "{\"id\":\"queue-empty\",\"command\":\"queue.list\",\"params\":{}}");
    defer empty.deinit();
    try std.testing.expectEqual(@as(usize, 0), (try expectOk(empty, "queue-empty")).get("items").?.array.items.len);
}

test "playlists create and list round trip" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var create = try expectInvoke(core.?, "{\"id\":\"create\",\"command\":\"playlists.create\",\"params\":{\"name\":\"Queue\"}}");
    defer create.deinit();
    const playlist_id = (try expectOk(create, "create")).get("playlist").?.object.get("id").?.string;

    var list = try expectInvoke(core.?, "{\"id\":\"list\",\"command\":\"playlists.list\",\"params\":{}}");
    defer list.deinit();
    const playlists = (try expectOk(list, "list")).get("playlists").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), playlists.len);
    try std.testing.expectEqualStrings(playlist_id, playlists[0].object.get("id").?.string);
    try std.testing.expectEqualStrings("Queue", playlists[0].object.get("name").?.string);
}

test "recent tracks and search history list newest first" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var track = try expectInvoke(core.?, "{\"id\":\"upsert\",\"command\":\"tracks.upsert\",\"params\":{\"title\":\"One\"}}");
    defer track.deinit();
    const track_id = (try expectOk(track, "upsert")).get("track").?.object.get("id").?.string;

    const first_recent = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"r1\",\"command\":\"recent.add\",\"params\":{{\"track_id\":\"{s}\",\"played_at\":\"2026-05-28T10:00:00Z\"}}}}", .{track_id}, 0);
    defer allocator.free(first_recent);
    var r1 = try expectInvoke(core.?, first_recent);
    r1.deinit();

    const second_recent = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"r2\",\"command\":\"recent.add\",\"params\":{{\"track_id\":\"{s}\",\"played_at\":\"2026-05-28T11:00:00Z\"}}}}", .{track_id}, 0);
    defer allocator.free(second_recent);
    var r2 = try expectInvoke(core.?, second_recent);
    r2.deinit();

    var recents = try expectInvoke(core.?, "{\"id\":\"recent-list\",\"command\":\"recent.list\",\"params\":{}}");
    defer recents.deinit();
    const recent_items = (try expectOk(recents, "recent-list")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), recent_items.len);
    try std.testing.expectEqualStrings("2026-05-28T11:00:00Z", recent_items[0].object.get("played_at").?.string);

    var s1 = try expectInvoke(core.?, "{\"id\":\"s1\",\"command\":\"search_history.add\",\"params\":{\"query\":\"alpha\",\"searched_at\":\"2026-05-28T10:00:00Z\"}}");
    s1.deinit();
    var s2 = try expectInvoke(core.?, "{\"id\":\"s2\",\"command\":\"search_history.add\",\"params\":{\"query\":\"beta\",\"searched_at\":\"2026-05-28T11:00:00Z\"}}");
    s2.deinit();

    var searches = try expectInvoke(core.?, "{\"id\":\"search-list\",\"command\":\"search_history.list\",\"params\":{}}");
    defer searches.deinit();
    const search_items = (try expectOk(searches, "search-list")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), search_items.len);
    try std.testing.expectEqualStrings("beta", search_items[0].object.get("query").?.string);
}

test "settings set and get round trip" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var set = try expectInvoke(core.?, "{\"id\":\"set\",\"command\":\"settings.set\",\"params\":{\"key\":\"theme\",\"value\":\"dark\"}}");
    set.deinit();

    var get = try expectInvoke(core.?, "{\"id\":\"get\",\"command\":\"settings.get\",\"params\":{\"key\":\"theme\"}}");
    defer get.deinit();
    const setting = (try expectOk(get, "get")).get("setting").?.object;
    try std.testing.expectEqualStrings("theme", setting.get("key").?.string);
    try std.testing.expectEqualStrings("dark", setting.get("value").?.string);
}

test "invalid json and unknown command return command errors" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    try expectErrorInvoke(core.?, "{", error_invalid_json, "invalid_json");
    try expectErrorInvoke(core.?, "{\"id\":\"bad\",\"command\":\"nope\",\"params\":{}}", error_unknown_command, "unknown_command");
}
