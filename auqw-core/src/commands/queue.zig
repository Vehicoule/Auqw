const std = @import("std");
const errors = @import("../errors.zig");
const models = @import("../models.zig");
const sqlite = @import("../sqlite.zig");
const AppState = @import("../state.zig").AppState;
const json = @import("json_helpers.zig");
const responses = @import("responses.zig");

const ObjectMap = std.json.ObjectMap;

pub fn add(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = models.generateId(state.allocator) catch return error.AllocationFailed;
    defer state.allocator.free(item_id);
    const track_id = json.requiredString(params, "track_id") catch return error.InvalidJson;

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
    return responses.makeSuccess(state.allocator, id, .{ .item = item });
}

pub fn list(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const items = listQueue(state) catch return error.Database;
    defer freeQueueItems(state.allocator, items);
    return responses.makeSuccess(state.allocator, id, .{ .items = items });
}

pub fn remove(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = json.requiredString(params, "id") catch return error.InvalidJson;

    var stmt = state.db.prepare("DELETE FROM queue_items WHERE id = ?") catch return error.Database;
    defer stmt.finalize();
    stmt.bindText(1, item_id) catch return error.Database;
    if ((stmt.step() catch return error.Database) != .done) return error.Database;

    return list(state, id);
}

pub fn clear(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    state.db.exec("DELETE FROM queue_items") catch return error.Database;
    return list(state, id);
}

pub fn move(state: *AppState, id: []const u8, params: ObjectMap) errors.CoreError![]u8 {
    const item_id = json.requiredString(params, "id") catch return error.InvalidJson;
    const to_index = json.requiredInt(params, "to_index") catch return error.InvalidJson;

    const items = listQueue(state) catch return error.Database;
    defer freeQueueItems(state.allocator, items);
    if (items.len == 0) return error.Database;

    var from_index: ?usize = null;
    for (items, 0..) |item, index| {
        if (std.mem.eql(u8, item.id, item_id)) {
            from_index = index;
            break;
        }
    }
    const source_index = from_index orelse return error.Database;

    const target_index: usize = if (to_index <= 0)
        0
    else
        @min(@as(usize, @intCast(to_index)), items.len - 1);

    const ordered_ids = state.allocator.alloc([]const u8, items.len) catch return error.AllocationFailed;
    defer state.allocator.free(ordered_ids);

    var write_index: usize = 0;
    for (items, 0..) |item, index| {
        if (index == source_index) {
            continue;
        }
        if (write_index == target_index) {
            ordered_ids[write_index] = items[source_index].id;
            write_index += 1;
        }
        ordered_ids[write_index] = item.id;
        write_index += 1;
    }
    if (write_index == target_index) {
        ordered_ids[write_index] = items[source_index].id;
        write_index += 1;
    }

    state.db.exec("BEGIN IMMEDIATE;") catch return error.Database;
    var committed = false;
    errdefer if (!committed) state.db.exec("ROLLBACK;") catch {};

    for (ordered_ids, 0..) |queue_item_id, index| {
        updateQueueItemPosition(state, queue_item_id, @intCast(index)) catch return error.Database;
    }

    state.db.exec("COMMIT;") catch return error.Database;
    committed = true;

    return list(state, id);
}

pub fn getQueueItemById(state: *AppState, id: []const u8) sqlite.DbError!models.QueueItem {
    var stmt = try state.db.prepare(
        \\SELECT
        \\    queue_items.id,
        \\    queue_items.track_id,
        \\    queue_items.position,
        \\    queue_items.added_at,
        \\    tracks.provider,
        \\    tracks.provider_track_id,
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
        \\    tracks.provider,
        \\    tracks.provider_track_id,
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
        .provider = try stmt.columnOptionalText(allocator, 4),
        .provider_track_id = try stmt.columnOptionalText(allocator, 5),
        .title = try stmt.columnText(allocator, 6),
        .artist = try stmt.columnOptionalText(allocator, 7),
        .album = try stmt.columnOptionalText(allocator, 8),
        .duration_ms = stmt.columnOptionalInt64(9),
        .artwork_url = try stmt.columnOptionalText(allocator, 10),
        .local_path = try stmt.columnOptionalText(allocator, 11),
    };
}

fn updateQueueItemPosition(state: *AppState, item_id: []const u8, position: i64) sqlite.DbError!void {
    var stmt = try state.db.prepare("UPDATE queue_items SET position = ? WHERE id = ?");
    defer stmt.finalize();
    try stmt.bindInt64(1, position);
    try stmt.bindText(2, item_id);
    if ((try stmt.step()) != .done) return error.Database;
}

fn freeQueueItems(allocator: std.mem.Allocator, items: []models.QueueItem) void {
    for (items) |item| item.deinit(allocator);
    allocator.free(items);
}
