const std = @import("std");

fn configureCoreModule(b: *std.Build, module: *std.Build.Module, android_ndk_root: ?[]const u8) void {
    module.addIncludePath(b.path("vendor"));
    if (android_ndk_root) |root| {
        const sysroot = b.pathJoin(&.{ root, "toolchains/llvm/prebuilt/linux-x86_64/sysroot" });
        module.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{ sysroot, "usr/include" }) });
        module.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{ sysroot, "usr/include/aarch64-linux-android" }) });
    }
    module.addCMacro("SQLITE_THREADSAFE", "1");
    module.addCMacro("SQLITE_OMIT_LOAD_EXTENSION", "1");
    module.addCMacro("SQLITE_DQS", "0");
    module.addCSourceFile(.{
        .file = b.path("vendor/sqlite3.c"),
        .flags = &.{
            "-std=c99",
            "-DSQLITE_THREADSAFE=1",
            "-DSQLITE_OMIT_LOAD_EXTENSION=1",
            "-DSQLITE_DQS=0",
        },
    });
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const android_ndk_root = b.option([]const u8, "android_ndk_root", "Android NDK root for vendored C dependencies");

    const core_module = b.createModule(.{
        .root_source_file = b.path("src/api.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
        .sanitize_c = .off,
    });
    configureCoreModule(b, core_module, android_ndk_root);

    const core_library = b.addLibrary(.{
        .name = "auqw_core",
        .root_module = core_module,
        .linkage = .static,
    });
    core_library.bundle_compiler_rt = true;
    b.installArtifact(core_library);

    const test_module = b.createModule(.{
        .root_source_file = b.path("src/api_tests.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .sanitize_c = .off,
    });
    configureCoreModule(b, test_module, android_ndk_root);

    const core_tests = b.addTest(.{
        .root_module = test_module,
    });
    const run_core_tests = b.addRunArtifact(core_tests);

    const test_step = b.step("test", "Run Auqw core tests");
    test_step.dependOn(&run_core_tests.step);
}
