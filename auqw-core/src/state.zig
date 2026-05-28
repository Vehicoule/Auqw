const std = @import("std");
const migrations = @import("migrations.zig");
const sqlite = @import("sqlite.zig");

pub const CreateOptions = struct {
    app_id: ?[]const u8,
    app_name: ?[]const u8,
    data_dir: ?[]const u8,
    cache_dir: ?[]const u8,
};

pub const AppState = struct {
    allocator: std.mem.Allocator,
    app_id: [:0]u8,
    app_name: [:0]u8,
    data_dir: ?[:0]u8,
    cache_dir: ?[:0]u8,
    db: sqlite.Database,

    pub fn create(allocator: std.mem.Allocator, options: CreateOptions) !*AppState {
        const state = try allocator.create(AppState);
        errdefer allocator.destroy(state);

        const app_id = try allocator.dupeZ(u8, options.app_id orelse "com.Vehicoule.auqw");
        errdefer allocator.free(app_id);
        const app_name = try allocator.dupeZ(u8, options.app_name orelse "Auqw");
        errdefer allocator.free(app_name);
        const data_dir = if (options.data_dir) |value| try allocator.dupeZ(u8, value) else null;
        errdefer if (data_dir) |value| allocator.free(value);
        const cache_dir = if (options.cache_dir) |value| try allocator.dupeZ(u8, value) else null;
        errdefer if (cache_dir) |value| allocator.free(value);

        var db = try sqlite.Database.open(allocator, if (data_dir) |value| value[0..value.len] else null);
        errdefer db.close();
        try migrations.run(&db);

        state.* = .{
            .allocator = allocator,
            .app_id = app_id,
            .app_name = app_name,
            .data_dir = data_dir,
            .cache_dir = cache_dir,
            .db = db,
        };
        return state;
    }

    pub fn deinit(self: *AppState) void {
        self.db.close();
        self.allocator.free(self.app_id);
        self.allocator.free(self.app_name);
        if (self.data_dir) |value| self.allocator.free(value);
        if (self.cache_dir) |value| self.allocator.free(value);
        const allocator = self.allocator;
        allocator.destroy(self);
    }
};
