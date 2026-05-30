const std = @import("std");
const errors = @import("../errors.zig");

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

pub fn makeSuccess(allocator: std.mem.Allocator, id: []const u8, data: anytype) errors.CoreError![]u8 {
    return std.json.Stringify.valueAlloc(allocator, .{
        .id = id,
        .ok = true,
        .data = data,
    }, .{}) catch return error.AllocationFailed;
}
