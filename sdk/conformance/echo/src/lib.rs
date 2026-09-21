//! Conformance guest: returns `{"type":"done","result":<step input>}`.
//!
//! The response embeds the raw step message verbatim as the `result`
//! value (the step input is already JSON), which lets a host test assert
//! the message crossed the ABI intact without this guest needing a JSON
//! dependency.
//!
//! Rebuild: `cargo build --target wasm32-unknown-unknown --release -p
//! auqw-conformance-echo`, then copy `target/wasm32-unknown-unknown/
//! release/auqw_conformance_echo.wasm` next to this source as `echo.wasm`.

use core::alloc::Layout;
use core::slice;

const PREFIX: &[u8] = b"{\"type\":\"done\",\"result\":";
const SUFFIX: &[u8] = b"}";

/// ABI-required allocator: hands out heap bytes for the host to fill.
///
/// The buffer is never freed; the instance is discarded after each
/// invocation, so the leak is bounded by the step budget.
#[no_mangle]
pub extern "C" fn alloc(len: u32) -> u32 {
    // `alloc` with a zero-sized layout is UB; a 0 request gets a 1-byte
    // buffer it never writes through (same guard as the SDK `__alloc`).
    let Ok(layout) = Layout::from_size_align((len as usize).max(1), 1) else {
        return 0;
    };
    // SAFETY: `layout` has nonzero size by construction; the returned
    // pointer is a valid guest-owned buffer of `len` bytes.
    unsafe { std::alloc::alloc(layout) as u32 }
}

/// ABI-required step entry.
///
/// # Safety
/// Relies on the ABI contract: `ptr`/`len` describe a readable buffer the
/// host wrote into this guest's linear memory.
#[no_mangle]
pub extern "C" fn handle(ptr: u32, len: u32) -> u64 {
    // SAFETY: per the ABI, `ptr..ptr+len` is initialized guest memory
    // owned by this module.
    let input = unsafe { slice::from_raw_parts(ptr as *const u8, len as usize) };
    let mut out = Vec::with_capacity(PREFIX.len() + input.len() + SUFFIX.len());
    out.extend_from_slice(PREFIX);
    out.extend_from_slice(input);
    out.extend_from_slice(SUFFIX);
    let out_ptr = out.as_ptr() as u64;
    let out_len = out.len() as u64;
    // Leak the response buffer: it must stay valid until the next
    // `handle`/`alloc` call, and the instance dies with the invocation.
    core::mem::forget(out);
    (out_ptr << 32) | out_len
}
