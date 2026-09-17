# Local wasm32 backend selection patch

This directory is the complete source of the permissively licensed RustCrypto
`aes 0.8.4` crate, vendored from the crates.io archive:

- archive SHA-256: `b169f7a6d4742236a0a00c541b845991d0ac43e546831af1249753ab4c3aa3a0`;
- upstream repository: `https://github.com/RustCrypto/block-ciphers`;
- upstream commit: `f2dbee516b4d0cf4cb4f3045d09e35b5fd80087b`;
- licences: MIT OR Apache-2.0, both retained next to the source.

The only cryptographic source change is in `src/soft.rs`: wasm32 selects the
existing upstream `fixslice64.rs` constant-time backend instead of
`fixslice32.rs`. WebAssembly supports deterministic i64 operations even though
its pointers remain 32-bit. Native targets retain the exact upstream selection.
No table lookup, data-dependent branch, algorithm, key schedule, unsafe block,
or zeroization behavior is added or changed.

`Cargo.toml` is the upstream human-authored manifest plus Rust 1.97 `check-cfg`
declarations for the three existing upstream configuration names. `Cargo.toml`
at the workspace root pins this path through `[patch.crates-io]`; no network or
alternate binary backend is used at build or runtime.

Qualification requirements for every update:

1. diff all `src/` files against the archived crate and allow only the backend
   selector above;
2. run the locked AES-GCM golden vectors and all hostile mutations natively and
   through the three browser engines;
3. verify zero imports, the 512 MiB maximum, reproducible WASM bytes, strict
   Clippy, `cargo deny`, and both retained licences;
4. rerun the 20-iteration browser performance matrix. The patch must be removed
   if correctness, constant-time source structure, zeroization, or budgets
   regress.

The faster `aes-wasm` alternative was explicitly rejected: its bundled Zig
source sets `side_channels_mitigations = .none`. `ring` was also rejected for
this boundary because its private expanded AEAD key has no zeroizing `Drop`.
