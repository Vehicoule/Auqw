const std = @import("std");

const ObjectMap = std.json.ObjectMap;

pub fn paramsObject(root: ObjectMap) !ObjectMap {
    const value = root.get("params") orelse return error.InvalidJson;
    if (value != .object) return error.InvalidJson;
    return value.object;
}

pub fn requiredString(object: ObjectMap, key: []const u8) ![]const u8 {
    return optionalString(object, key) orelse error.InvalidJson;
}

pub fn requiredInt(object: ObjectMap, key: []const u8) !i64 {
    return (try optionalInt(object, key)) orelse error.InvalidJson;
}

pub fn optionalString(object: ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .string => |text| text,
        .null => null,
        else => null,
    };
}

pub fn optionalInt(object: ObjectMap, key: []const u8) !?i64 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .integer => |number| number,
        .null => null,
        else => error.InvalidJson,
    };
}

pub fn optionalBool(object: ObjectMap, key: []const u8) !?bool {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .bool => |boolean| boolean,
        .null => null,
        else => error.InvalidJson,
    };
}
