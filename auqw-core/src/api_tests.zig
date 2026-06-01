const std = @import("std");
const api = @import("api.zig");
const sqlite = @import("sqlite.zig");

const allocator = std.testing.allocator;
const error_ok: c_int = 0;
const error_database: c_int = 3;
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
    try std.testing.expectEqual(@as(i64, 6), data.get("schema_version").?.integer);
}

test "schema v6 migration is idempotent for existing v3 databases" {
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

    {
        var db = try sqlite.Database.open(allocator, data_dir_buf[0..data_dir_len]);
        defer db.close();
        try db.exec(
            \\CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
            \\INSERT INTO schema_migrations(version) VALUES (1), (2), (3);
            \\CREATE TABLE tracks (
            \\    id TEXT PRIMARY KEY,
            \\    provider TEXT,
            \\    provider_track_id TEXT,
            \\    title TEXT NOT NULL,
            \\    artist TEXT,
            \\    album TEXT,
            \\    duration_ms INTEGER,
            \\    artwork_url TEXT,
            \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            \\);
            \\CREATE UNIQUE INDEX idx_tracks_provider_identity ON tracks(provider, provider_track_id) WHERE provider IS NOT NULL AND provider_track_id IS NOT NULL;
            \\CREATE TABLE cached_artwork (
            \\    id TEXT PRIMARY KEY,
            \\    track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
            \\    source_url TEXT,
            \\    cache_path TEXT NOT NULL,
            \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            \\);
            \\CREATE TABLE downloads (
            \\    id TEXT PRIMARY KEY,
            \\    track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
            \\    state TEXT NOT NULL,
            \\    target_path TEXT,
            \\    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            \\    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            \\);
        );
    }

    var first: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &first));
    api.auqw_core_destroy(first);

    var second: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &second));
    defer api.auqw_core_destroy(second);

    var response = try expectInvoke(second.?, "{\"id\":\"meta\",\"command\":\"core.get_metadata\",\"params\":{}}");
    defer response.deinit();
    const data = try expectOk(response, "meta");
    try std.testing.expectEqual(@as(i64, 6), data.get("schema_version").?.integer);

    var track = try expectInvoke(second.?, "{\"id\":\"track\",\"command\":\"tracks.upsert\",\"params\":{\"id\":\"alpha\",\"provider\":\"fake\",\"provider_track_id\":\"alpha\",\"title\":\"Alpha\",\"metadata_cached_at\":\"2026-05-30T10:00:00Z\"}}");
    defer track.deinit();
    const track_object = (try expectOk(track, "track")).get("track").?.object;
    try std.testing.expectEqualStrings("2026-05-30T10:00:00Z", track_object.get("metadata_cached_at").?.string);

    var download = try expectInvoke(second.?, "{\"id\":\"download\",\"command\":\"downloads.queue\",\"params\":{\"track_id\":\"alpha\",\"target_path\":\"/tmp/alpha.m4a\"}}");
    defer download.deinit();
    const download_object = (try expectOk(download, "download")).get("download").?.object;
    try std.testing.expectEqual(@as(i64, 0), download_object.get("bytes_received").?.integer);
    try std.testing.expect(download_object.get("bytes_total").? == .null);
    try std.testing.expect(download_object.get("mime_type").? == .null);
    try std.testing.expect(download_object.get("stream_kind").? == .null);
}

test "playback get starts stopped" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var response = try expectInvoke(core.?, "{\"id\":\"playback-get\",\"command\":\"playback.get\",\"params\":{}}");
    defer response.deinit();
    const playback = (try expectOk(response, "playback-get")).get("playback").?.object;
    try std.testing.expectEqualStrings("stopped", playback.get("state").?.string);
    try std.testing.expect(playback.get("queue_item_id").? == .null);
    try std.testing.expect(playback.get("track_id").? == .null);
    try std.testing.expect(playback.get("position_ms").? == .null);
    try std.testing.expect(playback.get("duration_ms").? == .null);
    try std.testing.expect(playback.get("error_message").? == .null);
}

test "playback load queue item joins local display fields" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var local = try expectInvoke(core.?, "{\"id\":\"local\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/alpha.mp3\",\"title\":\"Alpha\",\"artist\":\"Vela\",\"album\":\"North\",\"duration_ms\":1234}}");
    defer local.deinit();
    const track_id = (try expectOk(local, "local")).get("track").?.object.get("id").?.string;

    const add_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{track_id}, 0);
    defer allocator.free(add_request);
    var add = try expectInvoke(core.?, add_request);
    defer add.deinit();
    const queue_id = (try expectOk(add, "add")).get("item").?.object.get("id").?.string;

    const load_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"load\",\"command\":\"playback.load_queue_item\",\"params\":{{\"id\":\"{s}\"}}}}", .{queue_id}, 0);
    defer allocator.free(load_request);
    var load = try expectInvoke(core.?, load_request);
    defer load.deinit();
    const load_data = try expectOk(load, "load");
    const playback = load_data.get("playback").?.object;
    const item = load_data.get("item").?.object;

    try std.testing.expectEqualStrings("loading", playback.get("state").?.string);
    try std.testing.expectEqualStrings(queue_id, playback.get("queue_item_id").?.string);
    try std.testing.expectEqualStrings(track_id, playback.get("track_id").?.string);
    try std.testing.expectEqualStrings("Alpha", playback.get("title").?.string);
    try std.testing.expectEqualStrings("Vela", playback.get("artist").?.string);
    try std.testing.expectEqualStrings("North", playback.get("album").?.string);
    try std.testing.expectEqual(@as(i64, 1234), playback.get("duration_ms").?.integer);
    try std.testing.expectEqualStrings("/music/alpha.mp3", playback.get("local_path").?.string);
    try std.testing.expect(playback.get("error_message").? == .null);
    try std.testing.expectEqualStrings(queue_id, item.get("id").?.string);
}

test "playback update persists playing paused stopped and error" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var local = try expectInvoke(core.?, "{\"id\":\"local\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/beta.flac\",\"title\":\"Beta\",\"duration_ms\":5000}}");
    defer local.deinit();
    const track_id = (try expectOk(local, "local")).get("track").?.object.get("id").?.string;

    const add_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{track_id}, 0);
    defer allocator.free(add_request);
    var add = try expectInvoke(core.?, add_request);
    defer add.deinit();
    const queue_id = (try expectOk(add, "add")).get("item").?.object.get("id").?.string;

    const load_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"load\",\"command\":\"playback.load_queue_item\",\"params\":{{\"id\":\"{s}\"}}}}", .{queue_id}, 0);
    defer allocator.free(load_request);
    var load = try expectInvoke(core.?, load_request);
    load.deinit();

    var playing = try expectInvoke(core.?, "{\"id\":\"playing\",\"command\":\"playback.update\",\"params\":{\"state\":\"playing\",\"position_ms\":250,\"duration_ms\":5000}}");
    defer playing.deinit();
    var playback = (try expectOk(playing, "playing")).get("playback").?.object;
    try std.testing.expectEqualStrings("playing", playback.get("state").?.string);
    try std.testing.expectEqual(@as(i64, 250), playback.get("position_ms").?.integer);
    try std.testing.expectEqual(@as(i64, 5000), playback.get("duration_ms").?.integer);
    try std.testing.expect(playback.get("error_message").? == .null);

    var paused = try expectInvoke(core.?, "{\"id\":\"paused\",\"command\":\"playback.update\",\"params\":{\"state\":\"paused\",\"position_ms\":300}}");
    defer paused.deinit();
    playback = (try expectOk(paused, "paused")).get("playback").?.object;
    try std.testing.expectEqualStrings("paused", playback.get("state").?.string);
    try std.testing.expectEqual(@as(i64, 300), playback.get("position_ms").?.integer);
    try std.testing.expectEqual(@as(i64, 5000), playback.get("duration_ms").?.integer);

    var stopped = try expectInvoke(core.?, "{\"id\":\"stopped\",\"command\":\"playback.update\",\"params\":{\"state\":\"stopped\",\"position_ms\":0}}");
    defer stopped.deinit();
    playback = (try expectOk(stopped, "stopped")).get("playback").?.object;
    try std.testing.expectEqualStrings("stopped", playback.get("state").?.string);
    try std.testing.expectEqual(@as(i64, 0), playback.get("position_ms").?.integer);
    try std.testing.expectEqualStrings(queue_id, playback.get("queue_item_id").?.string);

    var failed = try expectInvoke(core.?, "{\"id\":\"error\",\"command\":\"playback.update\",\"params\":{\"state\":\"error\",\"error_message\":\"decoder failed\"}}");
    defer failed.deinit();
    playback = (try expectOk(failed, "error")).get("playback").?.object;
    try std.testing.expectEqualStrings("error", playback.get("state").?.string);
    try std.testing.expectEqualStrings("decoder failed", playback.get("error_message").?.string);
}

test "playback load handles missing, unresolved, and provider queue items" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    try expectErrorInvoke(core.?, "{\"id\":\"missing\",\"command\":\"playback.load_queue_item\",\"params\":{\"id\":\"missing\"}}", error_database, "database");

    var unresolved = try expectInvoke(core.?, "{\"id\":\"unresolved\",\"command\":\"tracks.upsert\",\"params\":{\"title\":\"No Source\"}}");
    defer unresolved.deinit();
    const unresolved_track_id = (try expectOk(unresolved, "unresolved")).get("track").?.object.get("id").?.string;

    const unresolved_add_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-unresolved\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{unresolved_track_id}, 0);
    defer allocator.free(unresolved_add_request);
    var unresolved_add = try expectInvoke(core.?, unresolved_add_request);
    defer unresolved_add.deinit();
    const unresolved_queue_id = (try expectOk(unresolved_add, "add-unresolved")).get("item").?.object.get("id").?.string;

    const unresolved_load_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"load-unresolved\",\"command\":\"playback.load_queue_item\",\"params\":{{\"id\":\"{s}\"}}}}", .{unresolved_queue_id}, 0);
    defer allocator.free(unresolved_load_request);
    var unresolved_load = try expectInvoke(core.?, unresolved_load_request);
    defer unresolved_load.deinit();
    var playback = (try expectOk(unresolved_load, "load-unresolved")).get("playback").?.object;
    try std.testing.expectEqualStrings("error", playback.get("state").?.string);
    try std.testing.expectEqualStrings("Queue item has no local file", playback.get("error_message").?.string);

    var remote = try expectInvoke(core.?, "{\"id\":\"remote\",\"command\":\"tracks.upsert\",\"params\":{\"title\":\"Stream Only\",\"provider\":\"remote\",\"provider_track_id\":\"42\"}}");
    defer remote.deinit();
    const remote_track = (try expectOk(remote, "remote")).get("track").?.object;
    const track_id = remote_track.get("id").?.string;
    try std.testing.expectEqualStrings("remote", remote_track.get("provider").?.string);
    try std.testing.expectEqualStrings("42", remote_track.get("provider_track_id").?.string);

    var tracks_list = try expectInvoke(core.?, "{\"id\":\"tracks-list\",\"command\":\"tracks.list\",\"params\":{}}");
    defer tracks_list.deinit();
    const listed_tracks = (try expectOk(tracks_list, "tracks-list")).get("tracks").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), listed_tracks.len);
    try std.testing.expectEqualStrings("remote", listed_tracks[1].object.get("provider").?.string);
    try std.testing.expectEqualStrings("42", listed_tracks[1].object.get("provider_track_id").?.string);

    const add_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-remote\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{track_id}, 0);
    defer allocator.free(add_request);
    var add = try expectInvoke(core.?, add_request);
    defer add.deinit();
    const remote_item = (try expectOk(add, "add-remote")).get("item").?.object;
    const queue_id = remote_item.get("id").?.string;
    try std.testing.expectEqualStrings("remote", remote_item.get("provider").?.string);
    try std.testing.expectEqualStrings("42", remote_item.get("provider_track_id").?.string);

    var queue_list = try expectInvoke(core.?, "{\"id\":\"queue-list\",\"command\":\"queue.list\",\"params\":{}}");
    defer queue_list.deinit();
    const listed_items = (try expectOk(queue_list, "queue-list")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), listed_items.len);
    try std.testing.expectEqualStrings("remote", listed_items[1].object.get("provider").?.string);
    try std.testing.expectEqualStrings("42", listed_items[1].object.get("provider_track_id").?.string);

    const load_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"load-remote\",\"command\":\"playback.load_queue_item\",\"params\":{{\"id\":\"{s}\"}}}}", .{queue_id}, 0);
    defer allocator.free(load_request);
    var load = try expectInvoke(core.?, load_request);
    defer load.deinit();
    playback = (try expectOk(load, "load-remote")).get("playback").?.object;
    const loaded_item = (try expectOk(load, "load-remote")).get("item").?.object;
    try std.testing.expectEqualStrings("loading", playback.get("state").?.string);
    try std.testing.expectEqualStrings(queue_id, playback.get("queue_item_id").?.string);
    try std.testing.expect(playback.get("local_path").? == .null);
    try std.testing.expect(playback.get("error_message").? == .null);
    try std.testing.expectEqualStrings("remote", loaded_item.get("provider").?.string);
    try std.testing.expectEqualStrings("42", loaded_item.get("provider_track_id").?.string);
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

test "artwork cache commands round trip" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var track_response = try expectInvoke(core.?, "{\"id\":\"track\",\"command\":\"tracks.upsert\",\"params\":{\"id\":\"track-alpha\",\"title\":\"Alpha\",\"artwork_url\":\"https://img.example/alpha.jpg\",\"metadata_cached_at\":\"2026-05-30T10:00:00Z\"}}");
    defer track_response.deinit();
    const track = (try expectOk(track_response, "track")).get("track").?.object;
    try std.testing.expectEqualStrings("2026-05-30T10:00:00Z", track.get("metadata_cached_at").?.string);

    var upsert = try expectInvoke(core.?, "{\"id\":\"art-upsert\",\"command\":\"cache.artwork.upsert\",\"params\":{\"track_id\":\"track-alpha\",\"source_url\":\"https://img.example/alpha.jpg\",\"cache_path\":\"/cache/artwork/alpha.jpg\"}}");
    defer upsert.deinit();
    const artwork = (try expectOk(upsert, "art-upsert")).get("artwork").?.object;
    const artwork_id = artwork.get("id").?.string;
    try std.testing.expect(artwork_id.len >= 32);
    try std.testing.expectEqualStrings("track-alpha", artwork.get("track_id").?.string);
    try std.testing.expectEqualStrings("https://img.example/alpha.jpg", artwork.get("source_url").?.string);
    try std.testing.expectEqualStrings("/cache/artwork/alpha.jpg", artwork.get("cache_path").?.string);

    var list = try expectInvoke(core.?, "{\"id\":\"art-list\",\"command\":\"cache.artwork.list\",\"params\":{}}");
    defer list.deinit();
    const listed = (try expectOk(list, "art-list")).get("artwork").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), listed.len);
    try std.testing.expectEqualStrings(artwork_id, listed[0].object.get("id").?.string);

    const remove_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"art-remove\",\"command\":\"cache.artwork.remove\",\"params\":{{\"id\":\"{s}\"}}}}", .{artwork_id}, 0);
    defer allocator.free(remove_request);
    var removed = try expectInvoke(core.?, remove_request);
    defer removed.deinit();
    const removed_artwork = (try expectOk(removed, "art-remove")).get("artwork").?.object;
    try std.testing.expectEqualStrings("/cache/artwork/alpha.jpg", removed_artwork.get("cache_path").?.string);

    var empty = try expectInvoke(core.?, "{\"id\":\"art-empty\",\"command\":\"cache.artwork.list\",\"params\":{}}");
    defer empty.deinit();
    try std.testing.expectEqual(@as(usize, 0), (try expectOk(empty, "art-empty")).get("artwork").?.array.items.len);
}

test "download commands cover M6 states and stream metadata" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var track_response = try expectInvoke(core.?, "{\"id\":\"track\",\"command\":\"tracks.upsert\",\"params\":{\"id\":\"track-alpha\",\"provider\":\"fake\",\"provider_track_id\":\"alpha\",\"title\":\"Alpha\"}}");
    defer track_response.deinit();
    _ = try expectOk(track_response, "track");

    var queued = try expectInvoke(core.?, "{\"id\":\"download-queue\",\"command\":\"downloads.queue\",\"params\":{\"track_id\":\"track-alpha\",\"target_path\":\"/downloads/alpha.m4a\"}}");
    defer queued.deinit();
    var download = (try expectOk(queued, "download-queue")).get("download").?.object;
    const download_id = download.get("id").?.string;
    try std.testing.expect(download_id.len >= 32);
    try std.testing.expectEqualStrings("queued", download.get("state").?.string);
    try std.testing.expectEqual(@as(i64, 0), download.get("progress").?.integer);
    try std.testing.expectEqual(@as(i64, 0), download.get("bytes_received").?.integer);
    try std.testing.expect(download.get("bytes_total").? == .null);
    try std.testing.expect(download.get("mime_type").? == .null);
    try std.testing.expect(download.get("stream_kind").? == .null);

    const states = [_][]const u8{ "resolving", "downloading", "verifying", "completed", "failed", "cancelled" };
    for (states, 0..) |state_name, index| {
        const progress: i64 = if (std.mem.eql(u8, state_name, "completed")) 100 else @intCast((index + 1) * 10);
        const update_request = try std.fmt.allocPrintSentinel(
            allocator,
            "{{\"id\":\"download-update\",\"command\":\"downloads.update\",\"params\":{{\"id\":\"{s}\",\"state\":\"{s}\",\"progress\":{},\"bytes_received\":{},\"bytes_total\":4096,\"mime_type\":\"audio/webm\",\"stream_kind\":\"headered_direct\",\"error_text\":\"err-{s}\"}}}}",
            .{ download_id, state_name, progress, @as(i64, @intCast(index + 1)) * 512, state_name },
            0,
        );
        defer allocator.free(update_request);
        var updated = try expectInvoke(core.?, update_request);
        defer updated.deinit();
        download = (try expectOk(updated, "download-update")).get("download").?.object;
        try std.testing.expectEqualStrings(state_name, download.get("state").?.string);
        try std.testing.expectEqual(progress, download.get("progress").?.integer);
        try std.testing.expectEqual(@as(i64, @intCast(index + 1)) * 512, download.get("bytes_received").?.integer);
        try std.testing.expectEqual(@as(i64, 4096), download.get("bytes_total").?.integer);
        try std.testing.expectEqualStrings("audio/webm", download.get("mime_type").?.string);
        try std.testing.expectEqualStrings("headered_direct", download.get("stream_kind").?.string);
        const expected_error = try std.fmt.allocPrint(allocator, "err-{s}", .{state_name});
        defer allocator.free(expected_error);
        try std.testing.expectEqualStrings(expected_error, download.get("error_text").?.string);
    }

    const invalid_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"download-invalid\",\"command\":\"downloads.update\",\"params\":{{\"id\":\"{s}\",\"state\":\"paused\"}}}}", .{download_id}, 0);
    defer allocator.free(invalid_request);
    try expectErrorInvoke(core.?, invalid_request, error_invalid_json, "invalid_json");

    var list = try expectInvoke(core.?, "{\"id\":\"download-list\",\"command\":\"downloads.list\",\"params\":{}}");
    defer list.deinit();
    const listed = (try expectOk(list, "download-list")).get("downloads").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), listed.len);
    try std.testing.expectEqualStrings(download_id, listed[0].object.get("id").?.string);

    const remove_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"download-remove\",\"command\":\"downloads.remove\",\"params\":{{\"id\":\"{s}\"}}}}", .{download_id}, 0);
    defer allocator.free(remove_request);
    var removed = try expectInvoke(core.?, remove_request);
    defer removed.deinit();
    const removed_download = (try expectOk(removed, "download-remove")).get("download").?.object;
    try std.testing.expectEqualStrings("/downloads/alpha.m4a", removed_download.get("target_path").?.string);

    var empty = try expectInvoke(core.?, "{\"id\":\"download-empty\",\"command\":\"downloads.list\",\"params\":{}}");
    defer empty.deinit();
    try std.testing.expectEqual(@as(usize, 0), (try expectOk(empty, "download-empty")).get("downloads").?.array.items.len);
}

test "storage download directory setting persists across reopen" {
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
    var set = try expectInvoke(first.?, "{\"id\":\"storage-set\",\"command\":\"settings.set\",\"params\":{\"key\":\"storage.download_dir\",\"value\":\"/downloads/music\"}}");
    defer set.deinit();
    try std.testing.expectEqualStrings("/downloads/music", (try expectOk(set, "storage-set")).get("setting").?.object.get("value").?.string);
    api.auqw_core_destroy(first);

    var second: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &second));
    defer api.auqw_core_destroy(second);

    var get = try expectInvoke(second.?, "{\"id\":\"storage-get\",\"command\":\"settings.get\",\"params\":{\"key\":\"storage.download_dir\"}}");
    defer get.deinit();
    try std.testing.expectEqualStrings("/downloads/music", (try expectOk(get, "storage-get")).get("setting").?.object.get("value").?.string);
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

test "queue move reorders items and compacts positions" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var alpha = try expectInvoke(core.?, "{\"id\":\"local-alpha\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/alpha.mp3\",\"title\":\"Alpha\"}}");
    defer alpha.deinit();
    const alpha_track_id = (try expectOk(alpha, "local-alpha")).get("track").?.object.get("id").?.string;

    var beta = try expectInvoke(core.?, "{\"id\":\"local-beta\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/beta.flac\",\"title\":\"Beta\"}}");
    defer beta.deinit();
    const beta_track_id = (try expectOk(beta, "local-beta")).get("track").?.object.get("id").?.string;

    var gamma = try expectInvoke(core.?, "{\"id\":\"local-gamma\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/gamma.wav\",\"title\":\"Gamma\"}}");
    defer gamma.deinit();
    const gamma_track_id = (try expectOk(gamma, "local-gamma")).get("track").?.object.get("id").?.string;

    const add_alpha_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-alpha\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{alpha_track_id}, 0);
    defer allocator.free(add_alpha_request);
    var add_alpha = try expectInvoke(core.?, add_alpha_request);
    defer add_alpha.deinit();
    const alpha_queue_id = try allocator.dupe(u8, (try expectOk(add_alpha, "add-alpha")).get("item").?.object.get("id").?.string);
    defer allocator.free(alpha_queue_id);

    const add_beta_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-beta\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{beta_track_id}, 0);
    defer allocator.free(add_beta_request);
    var add_beta = try expectInvoke(core.?, add_beta_request);
    defer add_beta.deinit();
    const beta_queue_id = try allocator.dupe(u8, (try expectOk(add_beta, "add-beta")).get("item").?.object.get("id").?.string);
    defer allocator.free(beta_queue_id);

    const add_gamma_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-gamma\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{gamma_track_id}, 0);
    defer allocator.free(add_gamma_request);
    var add_gamma = try expectInvoke(core.?, add_gamma_request);
    defer add_gamma.deinit();
    const gamma_queue_id = try allocator.dupe(u8, (try expectOk(add_gamma, "add-gamma")).get("item").?.object.get("id").?.string);
    defer allocator.free(gamma_queue_id);

    const move_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"queue-move\",\"command\":\"queue.move\",\"params\":{{\"id\":\"{s}\",\"to_index\":0}}}}", .{gamma_queue_id}, 0);
    defer allocator.free(move_request);
    var moved = try expectInvoke(core.?, move_request);
    defer moved.deinit();
    const moved_items = (try expectOk(moved, "queue-move")).get("items").?.array.items;

    try std.testing.expectEqual(@as(usize, 3), moved_items.len);
    try std.testing.expectEqualStrings(gamma_queue_id, moved_items[0].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 0), moved_items[0].object.get("position").?.integer);
    try std.testing.expectEqualStrings(alpha_queue_id, moved_items[1].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 1), moved_items[1].object.get("position").?.integer);
    try std.testing.expectEqualStrings(beta_queue_id, moved_items[2].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 2), moved_items[2].object.get("position").?.integer);
}

test "playback options default update and persist" {
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

    var defaults = try expectInvoke(first.?, "{\"id\":\"options-default\",\"command\":\"playback.options.get\",\"params\":{}}");
    defer defaults.deinit();
    var options_object = (try expectOk(defaults, "options-default")).get("options").?.object;
    try std.testing.expectEqualStrings("off", options_object.get("repeat_mode").?.string);
    try std.testing.expectEqual(false, options_object.get("shuffle_enabled").?.bool);

    var updated = try expectInvoke(first.?, "{\"id\":\"options-update\",\"command\":\"playback.options.update\",\"params\":{\"repeat_mode\":\"all\",\"shuffle_enabled\":true}}");
    defer updated.deinit();
    options_object = (try expectOk(updated, "options-update")).get("options").?.object;
    try std.testing.expectEqualStrings("all", options_object.get("repeat_mode").?.string);
    try std.testing.expectEqual(true, options_object.get("shuffle_enabled").?.bool);
    api.auqw_core_destroy(first);

    var second: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &second));
    defer api.auqw_core_destroy(second);

    var persisted = try expectInvoke(second.?, "{\"id\":\"options-persisted\",\"command\":\"playback.options.get\",\"params\":{}}");
    defer persisted.deinit();
    options_object = (try expectOk(persisted, "options-persisted")).get("options").?.object;
    try std.testing.expectEqualStrings("all", options_object.get("repeat_mode").?.string);
    try std.testing.expectEqual(true, options_object.get("shuffle_enabled").?.bool);
}

test "queue order survives close and reopen" {
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

    var alpha = try expectInvoke(first.?, "{\"id\":\"local-alpha\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/alpha.mp3\",\"title\":\"Alpha\"}}");
    defer alpha.deinit();
    const alpha_track_id = (try expectOk(alpha, "local-alpha")).get("track").?.object.get("id").?.string;

    var beta = try expectInvoke(first.?, "{\"id\":\"local-beta\",\"command\":\"local_files.upsert\",\"params\":{\"path\":\"/music/beta.flac\",\"title\":\"Beta\"}}");
    defer beta.deinit();
    const beta_track_id = (try expectOk(beta, "local-beta")).get("track").?.object.get("id").?.string;

    const add_alpha_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-alpha\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{alpha_track_id}, 0);
    defer allocator.free(add_alpha_request);
    var add_alpha = try expectInvoke(first.?, add_alpha_request);
    defer add_alpha.deinit();
    const alpha_queue_id = try allocator.dupe(u8, (try expectOk(add_alpha, "add-alpha")).get("item").?.object.get("id").?.string);
    defer allocator.free(alpha_queue_id);

    const add_beta_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"add-beta\",\"command\":\"queue.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{beta_track_id}, 0);
    defer allocator.free(add_beta_request);
    var add_beta = try expectInvoke(first.?, add_beta_request);
    defer add_beta.deinit();
    const beta_queue_id = try allocator.dupe(u8, (try expectOk(add_beta, "add-beta")).get("item").?.object.get("id").?.string);
    defer allocator.free(beta_queue_id);

    const move_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"queue-move\",\"command\":\"queue.move\",\"params\":{{\"id\":\"{s}\",\"to_index\":0}}}}", .{beta_queue_id}, 0);
    defer allocator.free(move_request);
    var moved = try expectInvoke(first.?, move_request);
    moved.deinit();
    api.auqw_core_destroy(first);

    var second: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(&options, &second));
    defer api.auqw_core_destroy(second);

    var list = try expectInvoke(second.?, "{\"id\":\"queue-list\",\"command\":\"queue.list\",\"params\":{}}");
    defer list.deinit();
    const items = (try expectOk(list, "queue-list")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), items.len);
    try std.testing.expectEqualStrings(beta_queue_id, items[0].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 0), items[0].object.get("position").?.integer);
    try std.testing.expectEqualStrings(alpha_queue_id, items[1].object.get("id").?.string);
    try std.testing.expectEqual(@as(i64, 1), items[1].object.get("position").?.integer);
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

    var track = try expectInvoke(core.?, "{\"id\":\"upsert\",\"command\":\"tracks.upsert\",\"params\":{\"title\":\"One\",\"artist\":\"Vela\",\"album\":\"North\",\"duration_ms\":1234,\"artwork_url\":\"https://img.example/one.jpg\"}}");
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
    try std.testing.expectEqualStrings("One", recent_items[0].object.get("title").?.string);
    try std.testing.expectEqualStrings("Vela", recent_items[0].object.get("artist").?.string);
    try std.testing.expectEqualStrings("North", recent_items[0].object.get("album").?.string);
    try std.testing.expectEqual(@as(i64, 1234), recent_items[0].object.get("duration_ms").?.integer);
    try std.testing.expectEqualStrings("https://img.example/one.jpg", recent_items[0].object.get("artwork_url").?.string);

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

test "favorites add remove and list joined track fields" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var track = try expectInvoke(core.?, "{\"id\":\"upsert\",\"command\":\"tracks.upsert\",\"params\":{\"provider\":\"ytmusic\",\"provider_track_id\":\"video-alpha\",\"title\":\"Alpha\",\"artist\":\"Mira\",\"album\":\"Wide\",\"duration_ms\":4200,\"artwork_url\":\"https://img.example/alpha.jpg\"}}");
    defer track.deinit();
    const track_id = (try expectOk(track, "upsert")).get("track").?.object.get("id").?.string;

    const add_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"fav-add\",\"command\":\"favorites.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{track_id}, 0);
    defer allocator.free(add_request);
    var add = try expectInvoke(core.?, add_request);
    defer add.deinit();
    const added = (try expectOk(add, "fav-add")).get("item").?.object;
    try std.testing.expectEqualStrings(track_id, added.get("track_id").?.string);
    try std.testing.expectEqualStrings("ytmusic", added.get("provider").?.string);
    try std.testing.expectEqualStrings("video-alpha", added.get("provider_track_id").?.string);
    try std.testing.expectEqualStrings("Alpha", added.get("title").?.string);
    try std.testing.expectEqualStrings("Mira", added.get("artist").?.string);

    var list = try expectInvoke(core.?, "{\"id\":\"fav-list\",\"command\":\"favorites.list\",\"params\":{}}");
    defer list.deinit();
    const favorites = (try expectOk(list, "fav-list")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), favorites.len);
    try std.testing.expectEqualStrings(track_id, favorites[0].object.get("track_id").?.string);
    try std.testing.expectEqualStrings("Alpha", favorites[0].object.get("title").?.string);
    try std.testing.expectEqual(@as(i64, 4200), favorites[0].object.get("duration_ms").?.integer);
    try std.testing.expectEqualStrings("https://img.example/alpha.jpg", favorites[0].object.get("artwork_url").?.string);

    const remove_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"fav-remove\",\"command\":\"favorites.remove\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{track_id}, 0);
    defer allocator.free(remove_request);
    var remove = try expectInvoke(core.?, remove_request);
    defer remove.deinit();
    const remove_data = try expectOk(remove, "fav-remove");
    try std.testing.expectEqual(@as(i64, 1), remove_data.get("removed").?.integer);

    var empty = try expectInvoke(core.?, "{\"id\":\"fav-empty\",\"command\":\"favorites.list\",\"params\":{}}");
    defer empty.deinit();
    const empty_items = (try expectOk(empty, "fav-empty")).get("items").?.array.items;
    try std.testing.expectEqual(@as(usize, 0), empty_items.len);
}

test "clear recent tracks and search history" {
    var core: ?*api.AuqwCore = null;
    try std.testing.expectEqual(error_ok, api.auqw_core_create(null, &core));
    defer api.auqw_core_destroy(core);

    var track = try expectInvoke(core.?, "{\"id\":\"upsert\",\"command\":\"tracks.upsert\",\"params\":{\"title\":\"Clear Me\"}}");
    defer track.deinit();
    const track_id = (try expectOk(track, "upsert")).get("track").?.object.get("id").?.string;

    const recent_request = try std.fmt.allocPrintSentinel(allocator, "{{\"id\":\"recent-add\",\"command\":\"recent.add\",\"params\":{{\"track_id\":\"{s}\"}}}}", .{track_id}, 0);
    defer allocator.free(recent_request);
    var recent_add = try expectInvoke(core.?, recent_request);
    recent_add.deinit();
    var search_add = try expectInvoke(core.?, "{\"id\":\"search-add\",\"command\":\"search_history.add\",\"params\":{\"query\":\"clear me\"}}");
    search_add.deinit();

    var clear_recent = try expectInvoke(core.?, "{\"id\":\"recent-clear\",\"command\":\"recent.clear\",\"params\":{}}");
    defer clear_recent.deinit();
    try std.testing.expectEqual(@as(i64, 1), (try expectOk(clear_recent, "recent-clear")).get("removed").?.integer);

    var clear_search = try expectInvoke(core.?, "{\"id\":\"search-clear\",\"command\":\"search_history.clear\",\"params\":{}}");
    defer clear_search.deinit();
    try std.testing.expectEqual(@as(i64, 1), (try expectOk(clear_search, "search-clear")).get("removed").?.integer);

    var recents = try expectInvoke(core.?, "{\"id\":\"recent-list\",\"command\":\"recent.list\",\"params\":{}}");
    defer recents.deinit();
    try std.testing.expectEqual(@as(usize, 0), (try expectOk(recents, "recent-list")).get("items").?.array.items.len);

    var searches = try expectInvoke(core.?, "{\"id\":\"search-list\",\"command\":\"search_history.list\",\"params\":{}}");
    defer searches.deinit();
    try std.testing.expectEqual(@as(usize, 0), (try expectOk(searches, "search-list")).get("items").?.array.items.len);
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
