import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { transpileBytes } from "@bytecodealliance/jco-transpile";
import { componentNew, componentWit } from "@bytecodealliance/jco-transpile/wasm-tools";

const qualificationDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(qualificationDirectory, "../../..");
const outputDirectory = resolve(repositoryRoot, "target/notebook-core-v2-qualification");
const wasmBuildConfigurationPath = resolve(repositoryRoot, ".cargo/config.toml");
const forbiddenRustBuildEnvironment = Object.keys(process.env).filter(
  (name) =>
    Boolean(process.env[name]) &&
    ([
      "CARGO_BUILD_RUSTC",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "CARGO_BUILD_RUSTFLAGS",
      "CARGO_ENCODED_RUSTFLAGS",
      "CARGO_INCREMENTAL",
      "CARGO_TARGET_DIR",
      "RUSTC",
      "RUSTC_BOOTSTRAP",
      "RUSTC_WRAPPER",
      "RUSTC_WORKSPACE_WRAPPER",
      "RUSTFLAGS",
    ].includes(name) ||
      name.startsWith("CARGO_PROFILE_RELEASE_") ||
      name.startsWith("CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_")),
);
if (forbiddenRustBuildEnvironment.length > 0) {
  throw new Error(
    `Notebook qualification forbids external Rust build controls: ${forbiddenRustBuildEnvironment.join(", ")}`,
  );
}
const coreModule = resolve(
  repositoryRoot,
  "target/wasm32-unknown-unknown/release/libre_ai_notebook_core.wasm",
);
const componentPath = resolve(outputDirectory, "notebook-core.component.wasm");
const internalFaultTargetDirectory = resolve(
  repositoryRoot,
  "target/notebook-core-v2-internal-fault-build",
);
const internalFaultCoreModule = resolve(
  internalFaultTargetDirectory,
  "wasm32-unknown-unknown/release/libre_ai_notebook_core.wasm",
);
const internalFaultComponentPath = resolve(
  outputDirectory,
  "notebook-core.internal-fault.component.wasm",
);
const toolchain = JSON.parse(
  await readFile(resolve(repositoryRoot, "toolchains/notebook-qualification.json"), "utf8"),
) as {
  node: {
    version: string;
    platforms: Record<string, { executableSha256: string }>;
  };
};
const nodePlatform = `${process.platform}-${process.arch}`;
const nodeAsset = toolchain.node.platforms[nodePlatform];
if (
  !nodeAsset ||
  process.versions.node !== toolchain.node.version ||
  sha256(new Uint8Array(await readFile(process.execPath))) !== nodeAsset.executableSha256
) {
  throw new Error("Notebook qualification requires the pinned Node executable");
}
const trapModules = [
  {
    exportName: "libre-ai:notebook-core/api@2.0.0#canonicalize-context",
    name: "notebook-core.trap-canonicalize.core.wasm",
  },
  {
    exportName: "libre-ai:notebook-core/api@2.0.0#open-backup",
    name: "notebook-core.trap-open.core.wasm",
  },
  {
    exportName: "libre-ai:notebook-core/api@2.0.0#seal-backup",
    name: "notebook-core.trap-seal.core.wasm",
  },
] as const;

function run(command: string, arguments_: string[], environment: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`qualification command failed: ${command}`);
  }
}

function safeOutputPath(name: string): string {
  const output = resolve(outputDirectory, "generated", name);
  const relativePath = relative(resolve(outputDirectory, "generated"), output);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error("transpiler emitted an unsafe path");
  }
  return output;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

run("cargo", [
  "build",
  "--locked",
  "-p",
  "libre-ai-notebook-core",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
]);
run(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "libre-ai-notebook-core",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--features",
    "qualification-faults",
  ],
  { CARGO_TARGET_DIR: internalFaultTargetDirectory },
);
await rm(outputDirectory, { force: true, recursive: true });
await mkdir(resolve(outputDirectory, "generated"), { recursive: true });

const coreBytes = new Uint8Array(await readFile(coreModule));
const componentBytes = await componentNew(coreBytes);
const wit = await componentWit(componentBytes);
if (!wit.includes("export libre-ai:notebook-core/api@2.0.0;") || wit.includes("import ")) {
  throw new Error("component WIT surface is not the closed Notebook API");
}
await writeFile(componentPath, componentBytes);
await writeFile(resolve(outputDirectory, "component.wit"), wit);
run("cargo", [
  "run",
  "--locked",
  "-p",
  "libre-ai-notebook-core",
  "--example",
  "check_wasm_imports",
  "--",
  coreModule,
  componentPath,
]);

const transpiled = await transpileBytes(componentBytes, {
  emitTypescriptDeclarations: true,
  instantiation: "async",
  name: "notebook-core",
  nodejsCompat: false,
  strict: true,
  wasiShim: false,
});
if (transpiled.imports.length !== 0) throw new Error("transpiled component has imports");
const expectedExports = new Set(["api:instance", "libre-ai:notebook-core/api@2.0.0:instance"]);
const actualExports = new Set(transpiled.exports.map(([name, kind]) => `${name}:${kind}`));
if (
  actualExports.size !== expectedExports.size ||
  [...expectedExports].some((value) => !actualExports.has(value))
) {
  throw new Error("transpiled component exports do not match the locked API");
}

for (const [name, bytes] of Object.entries(transpiled.files)) {
  const output = safeOutputPath(name);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
}

const internalFaultCoreBytes = new Uint8Array(await readFile(internalFaultCoreModule));
const internalFaultComponentBytes = await componentNew(internalFaultCoreBytes);
const internalFaultWit = await componentWit(internalFaultComponentBytes);
if (internalFaultWit !== wit) {
  throw new Error("qualification fault component changed the locked WIT surface");
}
await writeFile(internalFaultComponentPath, internalFaultComponentBytes);
run("cargo", [
  "run",
  "--locked",
  "-p",
  "libre-ai-notebook-core",
  "--example",
  "check_wasm_imports",
  "--",
  internalFaultCoreModule,
  internalFaultComponentPath,
]);
const internalFaultTranspiled = await transpileBytes(internalFaultComponentBytes, {
  emitTypescriptDeclarations: false,
  instantiation: "async",
  name: "notebook-core-internal-fault",
  nodejsCompat: false,
  strict: true,
  wasiShim: false,
});
if (internalFaultTranspiled.imports.length !== 0) {
  throw new Error("qualification fault component has imports");
}
const internalFaultExports = new Set(
  internalFaultTranspiled.exports.map(([name, kind]) => `${name}:${kind}`),
);
if (
  internalFaultExports.size !== expectedExports.size ||
  [...expectedExports].some((value) => !internalFaultExports.has(value))
) {
  throw new Error("qualification fault component exports do not match the locked API");
}
for (const [name, bytes] of Object.entries(internalFaultTranspiled.files)) {
  const output = safeOutputPath(name);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
}

const transpiledCorePath = resolve(outputDirectory, "generated/notebook-core.core.wasm");
const transpiledCore = new WebAssembly.Module(await readFile(transpiledCorePath));
if (WebAssembly.Module.imports(transpiledCore).length !== 0) {
  throw new Error("transpiled core module has imports");
}
const internalFaultTranspiledCorePath = resolve(
  outputDirectory,
  "generated/notebook-core-internal-fault.core.wasm",
);
const internalFaultTranspiledCore = new WebAssembly.Module(
  await readFile(internalFaultTranspiledCorePath),
);
if (WebAssembly.Module.imports(internalFaultTranspiledCore).length !== 0) {
  throw new Error("qualification fault transpiled core module has imports");
}

for (const trap of trapModules) {
  run("cargo", [
    "run",
    "--quiet",
    "--locked",
    "-p",
    "libre-ai-notebook-core",
    "--example",
    "inject_wasm_trap",
    "--",
    transpiledCorePath,
    trap.exportName,
    safeOutputPath(trap.name),
  ]);
}

const browserBundles = [
  ["benchmark-worker.ts", "benchmark-worker.js"],
  ["fault-worker.ts", "fault-worker.js"],
  ["host.ts", "host.js"],
  ["isolated-host.ts", "isolated-host.js"],
] as const;
for (const [source, output] of browserBundles) {
  run("bun", [
    "build",
    resolve(qualificationDirectory, source),
    "--target=browser",
    "--format=esm",
    `--outfile=${resolve(outputDirectory, "generated", output)}`,
  ]);
}
await writeFile(
  resolve(outputDirectory, "index.html"),
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Notebook Core qualification</title><body>qualification-only</body></html>\n',
);

const qualificationFiles = [
  ...Object.keys(transpiled.files),
  ...Object.keys(internalFaultTranspiled.files),
  ...trapModules.map(({ name }) => name),
  ...browserBundles.map(([, output]) => output),
];
const generated = Object.fromEntries(
  await Promise.all(
    qualificationFiles.sort().map(async (name) => {
      const bytes = await readFile(safeOutputPath(name));
      return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
    }),
  ),
);
const wasmBuildConfiguration = new Uint8Array(await readFile(wasmBuildConfigurationPath));
// Bind this local build to its inputs rather than transferring a historical binary attestation.
async function sourceDigests(path: string): Promise<Array<{ path: string; sha256: string }>> {
  const absolute = resolve(repositoryRoot, path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error("Build provenance refuses symbolic links");
  if (info.isDirectory()) {
    const entries = (await readdir(absolute)).sort();
    return (await Promise.all(entries.map((entry) => sourceDigests(`${path}/${entry}`)))).flat();
  }
  if (!info.isFile()) throw new Error("Build provenance requires regular files");
  return [{ path, sha256: sha256(new Uint8Array(await readFile(absolute))) }];
}
const inputPaths = [
  "package.json",
  "bun.lock",
  "vendored/wit/notebook-core-v2",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo/config.toml",
  "crates/notebook-core",
  "third_party/rustcrypto-aes-0.8.4",
  "tools/qualification/notebook-core-v2",
  "toolchains/notebook-qualification.json",
  "apps/notebook/scripts/build.ts",
];
const inputFiles = (await Promise.all(inputPaths.map(sourceDigests))).flat();
const rustVersion = spawnSync("rustc", ["--version"], { cwd: repositoryRoot, encoding: "utf8" });
if (rustVersion.status !== 0) throw new Error("Cannot observe the Rust compiler version");
const manifest = {
  buildProvenance: {
    inputFiles,
    node: { version: process.versions.node, executableSha256: nodeAsset.executableSha256 },
    rust: rustVersion.stdout.trim(),
    closedWitSha256: sha256(new TextEncoder().encode(wit)),
    coreImports: WebAssembly.Module.imports(transpiledCore).length,
  },
  component: { bytes: componentBytes.length, sha256: sha256(componentBytes) },
  coreModule: { bytes: coreBytes.length, sha256: sha256(coreBytes) },
  internalFaultComponent: {
    bytes: internalFaultComponentBytes.length,
    sha256: sha256(internalFaultComponentBytes),
  },
  internalFaultCoreModule: {
    bytes: internalFaultCoreBytes.length,
    sha256: sha256(internalFaultCoreBytes),
  },
  generated,
  schemaVersion: "libre-ai.notebook-core-v2-qualification-manifest.v1",
  transpiler: "@bytecodealliance/jco-transpile@0.4.2",
  wasmBuildConfiguration: {
    path: ".cargo/config.toml",
    requiredTargetFeature: "simd128",
    sha256: sha256(wasmBuildConfiguration),
  },
};
await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`);

console.log(
  `Notebook browser harness built: component=${manifest.component.sha256} core=${manifest.coreModule.sha256} node=${process.versions.node}`,
);
