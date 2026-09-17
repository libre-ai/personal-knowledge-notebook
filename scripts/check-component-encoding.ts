/**
 * Component-encoding gate: the locked wasm32 core module must be accepted by
 * BOTH decoders that read its `component-type` metadata.
 *
 * `wit-bindgen` (Rust, runtime boundary) embeds the WIT world into the core
 * module through `wit-component`; the qualification harness
 * (tools/qualification/notebook-core-v2/build.ts) then encodes the component
 * with the wasm-tools build vendored inside `@bytecodealliance/jco-transpile`.
 * Those two pins move independently (Dependabot bumps the crates, the npm
 * package carries its own wasm-tools), so a crate bump can produce metadata the
 * JS-side decoder refuses — and no unit test compiles wasm32, so `cargo test`
 * stays green while the harness breaks. This script is the proof that closes
 * that gap: build the exact locked module, run the same `componentNew` /
 * `componentWit` / `transpileBytes` calls the harness runs, and cross-check the
 * jco-built component with the Rust decoder (`check_wasm_imports`).
 *
 * Deliberately not the full qualification build: no pinned-Node checksum, no
 * fault artifact, no browser bundles — those are Gate B evidence, this is a
 * merge gate.
 *
 * Run it under Node (`bun run check:component`, CI job "Rust quality"), not
 * `bun scripts/...`: jco's preview2 shim spawns a worker on import that Bun
 * rejects (`process.binding("tcp_wrap")`) after the library has already
 * succeeded, which turns every verdict into exit code 1.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { transpileBytes } from "@bytecodealliance/jco-transpile";
import { componentNew, componentWit } from "@bytecodealliance/jco-transpile/wasm-tools";

const repositoryRoot = process.cwd();
const outputDirectory = resolve(repositoryRoot, "target/component-encoding");
const coreModulePath = resolve(
  repositoryRoot,
  "target/wasm32-unknown-unknown/release/libre_ai_notebook_core.wasm",
);
const componentPath = resolve(outputDirectory, "notebook-core.component.wasm");
const expectedExportLine = "export libre-ai:notebook-core/api@2.0.0;";
const expectedTranspiledExports = new Set([
  "api:instance",
  "libre-ai:notebook-core/api@2.0.0:instance",
]);

function run(command: string, arguments_: string[]): void {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`component-encoding command failed: ${command} ${arguments_.join(" ")}`);
  }
}

const transpilerManifest = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "node_modules/@bytecodealliance/jco-transpile/package.json"),
    "utf8",
  ),
) as { version: string };

run("cargo", [
  "build",
  "--locked",
  "-p",
  "libre-ai-notebook-core",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
]);
await mkdir(outputDirectory, { recursive: true });

const coreBytes = new Uint8Array(await readFile(coreModulePath));
// JS-side decoder (wasm-tools vendored by jco-transpile) reads the
// wit-bindgen metadata and encodes the component.
const componentBytes = await componentNew(coreBytes);
const wit = await componentWit(componentBytes);
if (!wit.includes(expectedExportLine) || wit.includes("import ")) {
  throw new Error(`component WIT surface is not the closed Notebook API:\n${wit}`);
}
await writeFile(componentPath, componentBytes);

// Rust-side decoder (pinned wasmparser/wit-component) validates the component
// jco produced: SIMD128, zero imports at both levels, 512 MiB cap, locked export.
run("cargo", [
  "run",
  "--locked",
  "-p",
  "libre-ai-notebook-core",
  "--example",
  "check_wasm_imports",
  "--",
  coreModulePath,
  componentPath,
]);

const transpiled = await transpileBytes(componentBytes, {
  emitTypescriptDeclarations: false,
  instantiation: "async",
  name: "notebook-core",
  nodejsCompat: false,
  strict: true,
  wasiShim: false,
});
if (transpiled.imports.length !== 0) {
  throw new Error(`transpiled component has imports: ${JSON.stringify(transpiled.imports)}`);
}
const actualExports = new Set(transpiled.exports.map(([name, kind]) => `${name}:${kind}`));
if (
  actualExports.size !== expectedTranspiledExports.size ||
  [...expectedTranspiledExports].some((value) => !actualExports.has(value))
) {
  throw new Error(
    `transpiled component exports do not match the locked API: ${[...actualExports].join(", ")}`,
  );
}
const transpiledCore = transpiled.files["notebook-core.core.wasm"];
if (transpiledCore === undefined) {
  throw new Error("transpiler did not emit notebook-core.core.wasm");
}
if (WebAssembly.Module.imports(new WebAssembly.Module(transpiledCore)).length !== 0) {
  throw new Error("transpiled core module has imports");
}

console.log(
  `Component encoding verified: jco-transpile ${transpilerManifest.version}, core ${coreBytes.length} bytes, component ${componentBytes.length} bytes, exports ${[...actualExports].sort().join(" ")}`,
);
