# Notebook Core v2 — experimental Gate B engine

Pure Rust/WASM implementation of the locked authorities in
`contracts/wit/notebook-core-v2/`, the v2 schemas, and the catalogued golden vectors.

## Boundary

- no module or component imports, randomness, clock, network, storage, environment, or logging;
- opaque backup/context/block IDs, the 16-byte salt, and the 12-byte nonce are explicit host inputs;
- recovery secret is exactly 16 CSPRNG bytes decoded from `libre-ai.recovery-secret-code.v1`;
- Argon2id v19 derives a transient 32-byte AES key using caller-owned zeroized memory;
- AES-256-GCM uses a 16-byte tag and the exact locked AAD/digest preimages;
- one-shot plaintext and Context content are capped at 16 MiB; hostile raw inputs are capped at 22,370,044 bytes;
- Context v2 enforces export-scoped IDs, graph closure, binary64/JCS, depth 64, 100,000 JSON nodes, and 16,384 total links;
- WebAssembly linear memory has an explicit 512 MiB maximum verified from the built module;
- wasm32 requires SIMD128 for the pinned SHA-256 backend, while AES-256 uses the vendored RustCrypto
  constant-time `fixslice64` implementation selected by the audited one-line backend patch;
- large envelope strings are borrowed during open, ciphertext is decoded only after KDF memory is
  released, and seal emits the exact canonical envelope without duplicate Base64/JCS buffers;
- only the closed WIT `error-code` crosses the boundary;
- recovery secrets, derived keys, AES/GHASH state, Argon2 memory, failed plaintexts, and owned Context copies are zeroized on ordinary returns.

The disabled-by-default `qualification-faults` feature exists only to build a separate ignored harness artifact. Reserved public fixture ID suffixes trigger a panic, a 600 MiB allocator request against the 512 MiB WASM cap, or a fail-next-allocation point at the `serde_json`, JCS, and Argon2id boundaries. Because valid envelopes now parse with borrowed strings and no heap allocation, the non-shipping `serde_json` fault uses an explicit owned-string parser probe before the production parse. Its `GlobalAlloc` wrapper is the only handwritten unsafe module and is compiled solely for WASM with that feature. The normal release artifact is built without this feature, the qualification build is checked for identical WIT exports and zero imports, and neither generated module is committed.

## Status

Experimental Gate B input only. It is not a user backup producer and must not process personal data,
be wired to a product host, or be released until Gate B and the project release gates approve the
exact engine/component/host commit.
