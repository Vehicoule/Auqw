//! Conformance guest: `handle` spins forever.
//!
//! Exists to prove that host fuel budgeting traps a CPU-bound guest. The
//! host never gets far enough to care about memory, so `alloc` returns a
//! fixed pointer.
//!
//! Rebuild: `cargo build --target wasm32-unknown-unknown --release -p
//! auqw-conformance-spin`, then copy `target/wasm32-unknown-unknown/
//! release/auqw_conformance_spin.wasm` next to this source as `spin.wasm`.

/// ABI-required allocator. The input is never read, so a fixed bump
/// pointer suffices.
///
/// # Safety
/// None required: no dereference happens in this guest.
#[no_mangle]
pub extern "C" fn alloc(_len: u32) -> u32 {
    1024
}

/// ABI-required step entry: loops forever; only fuel exhaustion stops it.
#[no_mangle]
pub extern "C" fn handle(_ptr: u32, _len: u32) -> u64 {
    #[allow(clippy::empty_loop)]
    loop {}
}
