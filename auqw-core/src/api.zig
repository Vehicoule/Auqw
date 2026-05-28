const std = @import("std");
const commands = @import("commands.zig");
const core_errors = @import("errors.zig");
const state = @import("state.zig");

const allocator = std.heap.c_allocator;
const core_magic: u32 = 0x41555157; // AUQW

pub const error_ok: c_int = core_errors.ok;
pub const error_invalid_argument: c_int = core_errors.invalid_argument;
pub const error_allocation_failed: c_int = core_errors.allocation_failed;
pub const error_database: c_int = core_errors.database;
pub const error_invalid_json: c_int = core_errors.invalid_json;
pub const error_unknown_command: c_int = core_errors.unknown_command;
pub const error_internal: c_int = core_errors.internal;

pub const AuqwInitOptions = extern struct {
    app_id: ?[*:0]const u8,
    app_name: ?[*:0]const u8,
    data_dir: ?[*:0]const u8,
    cache_dir: ?[*:0]const u8,
};

pub const AuqwCore = extern struct {
    magic: u32,
    app_state: ?*state.AppState,
};

pub export fn auqw_core_create(options: ?*const AuqwInitOptions, out_core: ?*?*AuqwCore) c_int {
    const output = out_core orelse return error_invalid_argument;
    output.* = null;

    const core = allocator.create(AuqwCore) catch return error_allocation_failed;
    errdefer allocator.destroy(core);

    const create_options = optionsToStateOptions(options);
    const app_state = state.AppState.create(allocator, create_options) catch |err| {
        return switch (err) {
            error.OutOfMemory, error.AllocationFailed => error_allocation_failed,
            error.Database => error_database,
        };
    };

    core.* = .{ .magic = core_magic, .app_state = app_state };
    output.* = core;

    return error_ok;
}

pub export fn auqw_core_destroy(core: ?*AuqwCore) void {
    const value = core orelse return;
    if (value.magic == core_magic) {
        if (value.app_state) |app_state| app_state.deinit();
    }
    value.magic = 0;
    value.app_state = null;
    allocator.destroy(value);
}

pub export fn auqw_core_hello(core: ?*AuqwCore) [*:0]const u8 {
    const value = core orelse return "Auqw Core unavailable";
    if (value.magic != core_magic) return "Auqw Core unavailable";
    return "Hello from Auqw Core";
}

pub export fn auqw_core_invoke_json(
    core: ?*AuqwCore,
    request_json: ?[*:0]const u8,
    out_response_json: ?*?[*:0]u8,
) c_int {
    const output = out_response_json orelse return error_invalid_argument;
    output.* = null;

    const value = core orelse return error_invalid_argument;
    if (value.magic != core_magic) return error_invalid_argument;
    const app_state = value.app_state orelse return error_invalid_argument;
    const request = request_json orelse return error_invalid_argument;

    const response = commands.invoke(app_state, std.mem.span(request)) catch |err| {
        const core_err: core_errors.CoreError = switch (err) {
            error.AllocationFailed => error.AllocationFailed,
            error.Database => error.Database,
            error.InvalidJson => error.InvalidJson,
            error.UnknownCommand => error.UnknownCommand,
            error.Internal => error.Internal,
        };
        const error_response = commands.makeErrorResponse(allocator, "", core_err);
        output.* = toCString(error_response) catch return error_allocation_failed;
        return core_errors.codeFor(core_err);
    };

    output.* = toCString(response) catch return error_allocation_failed;
    return error_ok;
}

pub export fn auqw_free(ptr: ?*anyopaque) void {
    std.c.free(ptr);
}

fn toCString(json: []u8) ![*:0]u8 {
    defer allocator.free(json);
    const response = try allocator.dupeZ(u8, json);
    return response.ptr;
}

fn optionsToStateOptions(options: ?*const AuqwInitOptions) state.CreateOptions {
    const value = options orelse return .{
        .app_id = null,
        .app_name = null,
        .data_dir = null,
        .cache_dir = null,
    };

    return .{
        .app_id = optionalSpan(value.app_id),
        .app_name = optionalSpan(value.app_name),
        .data_dir = optionalSpan(value.data_dir),
        .cache_dir = optionalSpan(value.cache_dir),
    };
}

fn optionalSpan(value: ?[*:0]const u8) ?[]const u8 {
    const ptr = value orelse return null;
    return std.mem.span(ptr);
}

test "core returns hello text for valid handle" {
    var core: ?*AuqwCore = null;
    const options = AuqwInitOptions{
        .app_id = "com.Vehicoule.auqw",
        .app_name = "Auqw",
        .data_dir = null,
        .cache_dir = null,
    };

    try std.testing.expectEqual(@as(c_int, 0), auqw_core_create(&options, &core));
    defer auqw_core_destroy(core);

    const hello = auqw_core_hello(core);
    try std.testing.expectEqualStrings("Hello from Auqw Core", std.mem.span(hello));
}

test "create rejects missing output pointer" {
    try std.testing.expectEqual(@as(c_int, 1), auqw_core_create(null, null));
}
