# Notebook Core v2 — qualification-only browser host

This harness is not a product host and must use only the public deterministic fixtures. It builds the
exact locked Rust component, transpiles it to browser-executable ES modules, and runs the closed WIT
API in Chromium, Firefox, and WebKit without external requests.

Covered:

- exact backup and Context golden outputs through the real component ABI;
- ten backup refusals plus twelve Context refusals, eight numeric cases, and six replayable resource boundaries;
- static host messages and no plaintext release on every backup refusal;
- strict lowercase 32-hex recovery decoding while invalid 15/17-byte attempts still traverse the component anti-oracle path;
- fresh Web Crypto IDs, salt, nonce, and recovery bytes with an executable uniqueness sample;
- best-effort wiping of host-owned recovery, plaintext, opened plaintext, and Context input buffers;
- ownership transfer to a one-operation worker, closed worker protocol, mandatory termination on success, refusal, startup/clone error, malformed response, trap, OOM, or timeout;
- validated trap copies of each real ABI export, plus real `memory.grow` failure beyond the 512 MiB cap after ABI input copies, across all three operations and browsers;
- a separate, non-shipping `qualification-faults` component that triggers a Rust panic and a real 600 MiB allocator request against the 512 MiB WASM cap on each ABI operation, plus fail-next-allocation points at `serde_json` parsing, JCS output reservation, and Argon2id matrix reservation, in each applicable operation and browser;
- 20 measured iterations after two warm-ups for the locked 16 MiB producer and maximum KDF profiles, including operation and disposable-worker p50/p95, summed linear-memory high-water marks, RSS deltas across every process from the exact pinned browser cache under a cross-worktree exclusive lock, and four anti-oracle refusal distributions;
- strict matching of the physical host against the selected 8 GiB constrained, 16–24 GiB mainstream, or 32+ GiB reference class before measurement; every report binds the class bounds and resource-manifest SHA-256;
- browser-resource preflight for secure context, Worker, `ArrayBuffer` transfer, Web Crypto, IndexedDB and at least 512 MiB of available qualification-origin quota; successful component execution proves SIMD128 support;
- an engine-qualified import-free module lifecycle: Firefox compiles once per page and structured-clones into each worker, while Chromium/WebKit compile inside every worker to limit sharing to the engine that requires it; both paths instantiate anew per operation, include compilation in RSS, and account for it in every end-to-end sample;
- indexed byte-for-byte verification of the public 16 MiB `0x5a` open result against its precomputed SHA-256, avoiding both a qualification-only digest copy and WebKit's per-byte iterator allocations; mandatory host termination on every worker outcome;
- required SIMD128 instructions, zero component/core imports and no WASI shim; no storage, logs, telemetry, or external network; the host clock is used only for deadlines and qualification timing;
- generated artifacts and raw measurements confined to ignored `target/notebook-core-v2-qualification/`;
- a separate exact-product-host campaign that sends `SIGKILL` during seal and `SIGABRT` during staged restore to the pinned browser process group, relaunches the same persistent profile, and verifies no partial download/receipt, encrypted-stage cleanup, and fresh workers after restart;
- product-host quota guards covering a below-floor preflight and a qualification-injected IndexedDB transaction abort, with no partial record/download and a successful clean restart. The injected abort is not credited as physical disk exhaustion;
- a macOS arm64-only exact-product-host storage campaign on a disposable 6 GiB sparse APFS image: it records an OS `ENOSPC`, refuses a public deterministic 16 MiB restore during IndexedDB staging before any worker starts, preserves the prior product state after relaunching the same profile, then proves successful restore and backup after the filler is removed.

Run with the pinned Bun environment, the manifest-matching Node executable, and locally installed Playwright browsers. Supplying the archive directory additionally verifies all four downloaded archives before execution:

```sh
export NOTEBOOK_QUALIFICATION_NODE=/path/to/node-26.5.0/bin/node
export NOTEBOOK_QUALIFICATION_ARCHIVE_DIR=/path/to/verified-archives
export NOTEBOOK_QUALIFICATION_DEVICE_CLASS=desktop-arm64-high-memory-reference
export NOTEBOOK_QUALIFICATION_EVIDENCE_MODE=physical-evidence
bun run qualify:notebook-core-v2:host
bun run qualify:notebook-product-host:faults
bun run qualify:notebook-product-host:storage
bun run qualify:notebook-core-v2:performance
```

For a real 8 GiB host, select `desktop-arm64-constrained-8gib`; for a real 16 or 24 GiB host, select `desktop-arm64-mainstream-16gib`. The checker refuses a high-memory machine claiming either class. `physical-evidence` also refuses known virtualization signals from `kern.hv_vmm_present`, `hw.model`, or the processor description.

A macOS guest with 8 or 16 GiB assigned is useful for early diagnostics. Inside the guest, use the corresponding device class and run `bun run diagnose:notebook-core-v2:performance:vm`. VM reports carry `evidenceMode: "vm-diagnostic"`, `promotableEvidence: false`, and can only end in `diagnostic-budgets-pass` or `reject`; they can never emit `qualification-budgets-pass`. Detection is defense in depth: an explicit VM mode remains non-promotable even if the guest hides its virtualization. Software throttling, hosted CI and VMs never replace physical evidence.

The public contribution protocol is documented in [`CONTRIBUTING-DEVICE-QUALIFICATION.md`](CONTRIBUTING-DEVICE-QUALIFICATION.md).

`toolchains/notebook-qualification.json` pins the Node and Playwright versions, platform, archive URLs, archive SHA-256 values, installed executable SHA-256 values, browser revisions, and Playwright descriptor hash. `toolchains/notebook-resource-classes.json` defines the hardware ranges, required browser capabilities, 512 MiB product-storage-quota candidate and evidence status. The build also rejects external Rust flags, target overrides, release-profile overrides, wrappers, and target directories; `.cargo/config.toml` and its recorded SHA-256 are the sole SIMD build configuration. The performance summarizer deliberately exits non-zero after writing the complete matrix when any locked budget is exceeded. The 30-minute Playwright test envelope only prevents suite-level false timeouts; every operation retains its 30-second deadline and every anti-oracle attempt its 15-second deadline, while the locked 5/10-second p95 budgets remain unchanged.

The transpiler is the minimal audited `@bytecodealliance/jco-transpile` package, not the full `jco`
CLI: the full package was rejected because its unused componentization dependency reached a critical
archive-extraction advisory. The transpiler is local build tooling under Apache-2.0 with LLVM
exception; the Component Model remains an open boundary and no generated binding is committed.

The Firefox-only compiled module cache is immutable and capability-free; reusing it does not reuse linear memory or an instance. Chromium and WebKit receive no compiled module from the page. Trap and internal-fault campaigns continue to use their dedicated disposable workers and artifacts rather than this performance cache.

The core fault harness proves the qualification-host policy and disposable-instance recovery with injected traps, a Rust panic, a real Rust allocator failure at the linear-memory cap, controlled allocation refusal at the `serde_json`/JCS/Argon2id boundaries, and hangs. The `serde_json` failpoint aborts inside the first allocation of an explicit qualification-only owned-string parse. This probe remains necessary because valid production envelopes now deserialize through borrowed strings without heap allocation. The fallible JCS and Argon2id reservations return `resource-limit-exceeded`. The product-host fault campaign uses the pinned Playwright 1.61 internal kill channel only because its implementation is audited to issue `SIGKILL` to the spawned process group; its separate crash path resolves the same pinned internal process and sends `SIGABRT` to that group. Absence or drift of either internal boundary fails the campaign closed. It does **not** induce browser-process OOM, turn an injected IndexedDB abort into evidence of physical disk exhaustion, or prove physical memory erasure. ADR-0007 classifies real browser-process OOM as an optional diagnostic and forbids exhausting host RAM or swap; it does not rename these injected signals.

The APFS campaign is the separate physical-disk-exhaustion proof. It fails rather than skips outside macOS arm64 or when the host cannot retain an 8 GiB free-space reserve. The 6 GiB sparse image bounds the test; the 16 MiB pressure envelope contains only repeated public `0x5a` bytes and is intentionally not parsed because encrypted staging precedes the worker boundary. The report preserves the APFS `ENOSPC` errno, browser quota estimate, live-inspection availability, restart and cleanup outcome. This proves product behavior under local `ENOSPC`; it does not qualify a hardware class, validate the browser's quota estimate, or authorize user data.

The resource manifest requires only the physically qualified 32+ GiB arm64 class for the current Gate B scope. The 8 GiB and 16–24 GiB classes remain optional community observations and are not claimed as supported without their own reviewed evidence. Its process-fault policy requires abrupt-termination/crash recovery, no partial artifact, same-profile recovery and a fresh worker; browser-process OOM is an optional diagnostic and unsafe host exhaustion is forbidden. Gate B is approved on immutable candidate `9ee3f8d` after separate exact-product-host architecture, security, cryptography, privacy and performance reviews; activation, user data and release remain separately gated.
