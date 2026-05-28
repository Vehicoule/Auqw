const std = @import("std");
const sqlite = @import("sqlite.zig");

pub const Track = struct {
    id: []const u8,
    title: []const u8,
    artist: ?[]const u8 = null,
    album: ?[]const u8 = null,
    duration_ms: ?i64 = null,
    artwork_url: ?[]const u8 = null,
    created_at: []const u8,
    updated_at: []const u8,

    pub fn deinit(self: Track, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.title);
        if (self.artist) |value| allocator.free(value);
        if (self.album) |value| allocator.free(value);
        if (self.artwork_url) |value| allocator.free(value);
        allocator.free(self.created_at);
        allocator.free(self.updated_at);
    }
};

pub const LocalFile = struct {
    id: []const u8,
    track_id: []const u8,
    path: []const u8,
    discovered_at: []const u8,

    pub fn deinit(self: LocalFile, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.track_id);
        allocator.free(self.path);
        allocator.free(self.discovered_at);
    }
};

pub const Playlist = struct {
    id: []const u8,
    name: []const u8,
    created_at: []const u8,
    updated_at: []const u8,

    pub fn deinit(self: Playlist, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.name);
        allocator.free(self.created_at);
        allocator.free(self.updated_at);
    }
};

pub const RecentTrack = struct {
    id: []const u8,
    track_id: []const u8,
    played_at: []const u8,
    created_at: []const u8,

    pub fn deinit(self: RecentTrack, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.track_id);
        allocator.free(self.played_at);
        allocator.free(self.created_at);
    }
};

pub const SearchHistoryItem = struct {
    id: []const u8,
    query: []const u8,
    searched_at: []const u8,

    pub fn deinit(self: SearchHistoryItem, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.query);
        allocator.free(self.searched_at);
    }
};

pub const QueueItem = struct {
    id: []const u8,
    track_id: []const u8,
    position: i64,
    added_at: []const u8,
    title: []const u8,
    artist: ?[]const u8 = null,
    album: ?[]const u8 = null,
    duration_ms: ?i64 = null,
    artwork_url: ?[]const u8 = null,
    local_path: ?[]const u8 = null,

    pub fn deinit(self: QueueItem, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.track_id);
        allocator.free(self.added_at);
        allocator.free(self.title);
        if (self.artist) |value| allocator.free(value);
        if (self.album) |value| allocator.free(value);
        if (self.artwork_url) |value| allocator.free(value);
        if (self.local_path) |value| allocator.free(value);
    }
};

pub const Setting = struct {
    key: []const u8,
    value: ?[]const u8,
    updated_at: ?[]const u8,

    pub fn deinit(self: Setting, allocator: std.mem.Allocator) void {
        allocator.free(self.key);
        if (self.value) |value| allocator.free(value);
        if (self.updated_at) |value| allocator.free(value);
    }
};

pub fn generateId(allocator: std.mem.Allocator) ![]u8 {
    var bytes: [16]u8 = undefined;
    sqlite.c.sqlite3_randomness(bytes.len, &bytes);

    const out = try allocator.alloc(u8, 36);
    const hex = "0123456789abcdef";
    var byte_index: usize = 0;
    var out_index: usize = 0;

    while (byte_index < bytes.len) : (byte_index += 1) {
        if (out_index == 8 or out_index == 13 or out_index == 18 or out_index == 23) {
            out[out_index] = '-';
            out_index += 1;
        }
        out[out_index] = hex[bytes[byte_index] >> 4];
        out[out_index + 1] = hex[bytes[byte_index] & 0x0f];
        out_index += 2;
    }

    return out;
}
