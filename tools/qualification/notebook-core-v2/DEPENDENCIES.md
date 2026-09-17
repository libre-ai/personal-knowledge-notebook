# Qualification dependency decision

## Accepted for this harness

`@bytecodealliance/jco-transpile 0.4.2` is pinned exactly in `bun.lock` with integrity
`sha512-45aeQsUSJsrru1FY1EU47T6kREUkQ7QC1EwIqb5Vi3yakrl6cyqOTRG005k/BWq/fNR0i0n3QtTZQRoF4fi88g==`.
It is Apache-2.0 with LLVM exception, open source under the Bytecode Alliance, and implements the open
WebAssembly Component Model. It runs locally at build time, receives only the public compiled module,
and is absent from product/browser runtime output. `bun audit` reports no advisory.

Its vendored wasm-tools (wit-component 0.251.0) is an older decoder than the `wit-component` the
workspace's `wit-bindgen` embeds metadata with, and the two pins move independently. The CI job
"Rust quality" therefore runs `scripts/check-component-encoding.ts` on every pull request: it builds
the locked wasm32 module and runs this package's own `componentNew` / `componentWit` /
`transpileBytes` over it, so a crate bump the JS-side decoder refuses is red before merge rather than
discovered at the next qualification run.

Its preview shims share the same permissive licence but are not imported into the generated component:
the build sets `wasiShim: false`, requires an empty transpiler import list, and verifies the generated
core module has zero imports. Binaryen/OXC are build-only transitive packages; optimization and
minification are disabled. Fault-module generation reuses the already pinned Rust `wasmparser`
without adding a dependency; each modified module is validated before browser execution and remains
under ignored `target/`.

The existing `@playwright/test 1.61.1` dependency executes local Chromium, Firefox, and WebKit. The harness blocks every non-loopback request and uses only public deterministic fixtures. `toolchains/notebook-qualification.json` pins the Playwright descriptor plus the official Chromium 149/revision 1228, Firefox 151/revision 1532, and WebKit 26.5/revision 2311 archives and installed executables for Darwin arm64. `check-toolchain.ts` verifies the installed files on every run and verifies archive SHA-256 values when `NOTEBOOK_QUALIFICATION_ARCHIVE_DIR` is supplied.

## Rejected alternative

The full `@bytecodealliance/jco 1.25.2` CLI was tested and rejected before commit. It includes unused
componentization toolchains and reached `decompress <=4.2.1`, affected by critical archive traversal
advisory `GHSA-mp2f-45pm-3cg9`. The dependency and its lock changes were removed; the minimal
transpiler has no reported vulnerability.

## Residual toolchain limits

The transpiler currently requires Node for its worker implementation because the pinned Bun can emit a spurious `process.binding("tcp_wrap")` worker error after successful library execution. Node 26.5.0 for Darwin arm64 is now pinned by official archive URL, archive SHA-256, and installed executable SHA-256 in the qualification manifest. It remains qualification-only rather than a repository-wide runtime. Generated component artifacts are rebuilt twice and compared and are never committed. Archive verification and raw browser evidence must be retained with each immutable Gate B review; the manifest alone is not proof that a reviewer possessed the archives.
