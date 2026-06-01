const std = @import("std");

pub const c = @cImport({
    @cInclude("sqlite3.h");
});

pub const DbError = error{
    Database,
    AllocationFailed,
};

pub const Step = enum {
    row,
    done,
};

pub const Database = struct {
    allocator: std.mem.Allocator,
    handle: *c.sqlite3,
    path: [:0]u8,

    pub fn open(allocator: std.mem.Allocator, data_dir: ?[]const u8) DbError!Database {
        const db_path = if (data_dir) |dir|
            std.fmt.allocPrintSentinel(allocator, "{s}/auqw.sqlite3", .{dir}, 0) catch return error.AllocationFailed
        else
            allocator.dupeZ(u8, ":memory:") catch return error.AllocationFailed;
        errdefer allocator.free(db_path);

        var handle: ?*c.sqlite3 = null;
        const flags = c.SQLITE_OPEN_READWRITE | c.SQLITE_OPEN_CREATE | c.SQLITE_OPEN_FULLMUTEX;
        if (c.sqlite3_open_v2(db_path.ptr, &handle, flags, null) != c.SQLITE_OK) {
            if (handle) |value| _ = c.sqlite3_close(value);
            return error.Database;
        }

        const value = handle orelse return error.Database;
        _ = c.sqlite3_busy_timeout(value, 5000);

        return .{
            .allocator = allocator,
            .handle = value,
            .path = db_path,
        };
    }

    pub fn close(self: *Database) void {
        _ = c.sqlite3_close(self.handle);
        self.allocator.free(self.path);
        self.* = undefined;
    }

    pub fn exec(self: *Database, sql: []const u8) DbError!void {
        var message: [*c]u8 = null;
        defer if (message != null) c.sqlite3_free(message);
        if (c.sqlite3_exec(self.handle, sql.ptr, null, null, &message) != c.SQLITE_OK) {
            return error.Database;
        }
    }

    pub fn prepare(self: *Database, sql: []const u8) DbError!Statement {
        var stmt: ?*c.sqlite3_stmt = null;
        const len: c_int = @intCast(sql.len);
        if (c.sqlite3_prepare_v2(self.handle, sql.ptr, len, &stmt, null) != c.SQLITE_OK) {
            return error.Database;
        }

        return .{ .db = self, .handle = stmt orelse return error.Database };
    }

    pub fn lastInsertRowId(self: *Database) i64 {
        return @intCast(c.sqlite3_last_insert_rowid(self.handle));
    }

    pub fn changes(self: *Database) i64 {
        return @intCast(c.sqlite3_changes64(self.handle));
    }
};

pub const Statement = struct {
    db: *Database,
    handle: *c.sqlite3_stmt,

    pub fn finalize(self: *Statement) void {
        _ = c.sqlite3_finalize(self.handle);
        self.* = undefined;
    }

    pub fn bindText(self: *Statement, index: c_int, value: []const u8) DbError!void {
        const len: c_int = @intCast(value.len);
        if (c.sqlite3_bind_text(self.handle, index, value.ptr, len, null) != c.SQLITE_OK) {
            return error.Database;
        }
    }

    pub fn bindOptionalText(self: *Statement, index: c_int, value: ?[]const u8) DbError!void {
        if (value) |text| {
            try self.bindText(index, text);
        } else {
            try self.bindNull(index);
        }
    }

    pub fn bindInt64(self: *Statement, index: c_int, value: i64) DbError!void {
        if (c.sqlite3_bind_int64(self.handle, index, value) != c.SQLITE_OK) {
            return error.Database;
        }
    }

    pub fn bindOptionalInt64(self: *Statement, index: c_int, value: ?i64) DbError!void {
        if (value) |number| {
            try self.bindInt64(index, number);
        } else {
            try self.bindNull(index);
        }
    }

    pub fn bindNull(self: *Statement, index: c_int) DbError!void {
        if (c.sqlite3_bind_null(self.handle, index) != c.SQLITE_OK) {
            return error.Database;
        }
    }

    pub fn step(self: *Statement) DbError!Step {
        return switch (c.sqlite3_step(self.handle)) {
            c.SQLITE_ROW => .row,
            c.SQLITE_DONE => .done,
            else => error.Database,
        };
    }

    pub fn columnText(self: *Statement, allocator: std.mem.Allocator, index: c_int) DbError![]u8 {
        return try self.columnOptionalText(allocator, index) orelse allocator.dupe(u8, "") catch return error.AllocationFailed;
    }

    pub fn columnOptionalText(self: *Statement, allocator: std.mem.Allocator, index: c_int) DbError!?[]u8 {
        const ptr = c.sqlite3_column_text(self.handle, index) orelse return null;
        const len: usize = @intCast(c.sqlite3_column_bytes(self.handle, index));
        return allocator.dupe(u8, ptr[0..len]) catch return error.AllocationFailed;
    }

    pub fn columnOptionalInt64(self: *Statement, index: c_int) ?i64 {
        if (c.sqlite3_column_type(self.handle, index) == c.SQLITE_NULL) return null;
        return @intCast(c.sqlite3_column_int64(self.handle, index));
    }
};
