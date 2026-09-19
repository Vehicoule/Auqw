//! `cargo run -p auqw-mobile-bindings --bin uniffi-bindgen generate
//!   --library <lib.so> --language kotlin --out-dir <dir>`

fn main() {
    uniffi::uniffi_bindgen_main();
}
