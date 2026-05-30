const errors = @import("../errors.zig");
const migrations = @import("../migrations.zig");
const AppState = @import("../state.zig").AppState;
const responses = @import("responses.zig");

pub fn getMetadata(state: *AppState, id: []const u8) errors.CoreError![]u8 {
    const version = migrations.currentVersion(&state.db) catch return error.Database;
    return responses.makeSuccess(state.allocator, id, .{
        .app_id = state.app_id[0..state.app_id.len],
        .app_name = state.app_name[0..state.app_name.len],
        .database_path = state.db.path[0..state.db.path.len],
        .schema_version = version,
    });
}
