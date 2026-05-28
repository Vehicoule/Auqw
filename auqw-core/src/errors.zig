pub const ok: c_int = 0;
pub const invalid_argument: c_int = 1;
pub const allocation_failed: c_int = 2;
pub const database: c_int = 3;
pub const invalid_json: c_int = 4;
pub const unknown_command: c_int = 5;
pub const internal: c_int = 6;

pub const CoreError = error{
    AllocationFailed,
    Database,
    InvalidJson,
    UnknownCommand,
    Internal,
};

pub fn codeFor(err: CoreError) c_int {
    return switch (err) {
        error.AllocationFailed => allocation_failed,
        error.Database => database,
        error.InvalidJson => invalid_json,
        error.UnknownCommand => unknown_command,
        error.Internal => internal,
    };
}

pub fn jsonCode(err: CoreError) []const u8 {
    return switch (err) {
        error.AllocationFailed => "allocation_failed",
        error.Database => "database",
        error.InvalidJson => "invalid_json",
        error.UnknownCommand => "unknown_command",
        error.Internal => "internal",
    };
}

pub fn message(err: CoreError) []const u8 {
    return switch (err) {
        error.AllocationFailed => "Allocation failed",
        error.Database => "Database error",
        error.InvalidJson => "Invalid request JSON",
        error.UnknownCommand => "Unknown command",
        error.Internal => "Internal error",
    };
}
