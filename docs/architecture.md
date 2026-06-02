# Auqw Architecture Notes

## Identity

- Product name: `Auqw`
- App id: `com.Vehicoule.auqw`
- Executable: `auqw`
- Core library: `libauqw_core`

## Current Boundary

```text
QML window
  -> C++ CoreController
  -> C++ CoreBridge
  -> C ABI
  -> Zig Auqw core
```

Zig owns durable core state. Qt/C++ owns UI and platform lifecycle.

## C ABI Rules

- Keep ABI typed and small.
- Use opaque handles for state.
- Return explicit integer error codes.
- Keep Qt and C++ headers out of Zig.
- Keep Zig internals out of QML.
- Add JSON only for rich payloads after a typed function owns the command.

## Maintainability Rules

- Prefer readable names over abbreviations.
- Prefer one responsibility per file.
- Keep bridge code boring and explicit.
- Do not add provider, playback, database, or cache logic to hello-world.
- Add performance shortcuts only after measurement.

## Efficiency Rules

- Avoid generic string dispatch in hot paths.
- Keep allocations visible at ABI boundaries.
- Build for static linking first so mobile packaging stays predictable.
- Profile before optimizing.
