// Builds the native release binaries of this workspace with the machine-path
// remap of owner decision Y40, then fails if any of them still embeds a machine
// path. The Notebook core WASM is built and scanned by its own audited recipe
// (tools/qualification/notebook-core-v2/build.ts).

import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoMachinePaths,
  machinePathContext,
  machinePathRemaps,
  remapConfigArgument,
  rustflagOverrides,
} from "./machine-paths";

// Release binaries of this workspace; `cargo metadata` would also list test fixtures.
const RELEASE_BINARIES = [{ package: "p02-worker", binary: "p02-worker" }] as const;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overrides = rustflagOverrides();
if (overrides.length > 0) {
  throw new Error(
    `Release build refuses rustflag overrides that would drop the path remap: ${overrides.join(", ")}`,
  );
}
const context = machinePathContext(repositoryRoot);
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    ...RELEASE_BINARIES.flatMap(({ package: name, binary }) => ["-p", name, "--bin", binary]),
    "--config",
    remapConfigArgument("build.rustflags", machinePathRemaps(context)),
  ],
  { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  throw new Error("release build failed");
}
const targetDirectory = resolve(repositoryRoot, "target/release");
await assertNoMachinePaths(
  context,
  RELEASE_BINARIES.map(({ binary }) => resolve(targetDirectory, binary)),
  (path) => relative(repositoryRoot, path),
);
