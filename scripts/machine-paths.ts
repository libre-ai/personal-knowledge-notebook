// Machine-path hygiene for built Rust artifacts (owner decision Y40, 2026-10-09).
//
// rustc writes the source path of every panic location into the artifact. For a
// dependency that path is absolute (`$CARGO_HOME/registry/src/...`), so without a
// remap the builder's home directory, hence the user name, ships inside the
// artifact and the same commit yields a different fingerprint on every machine.
// `trim-paths` is not stable in Cargo 1.97, so recipes pass `--remap-path-prefix`
// themselves, and every recipe scans what it produced: the scan, not the exit
// code of the build, is the proof.
//
// This file is duplicated per repository on purpose: sharing it would go through
// the pinned governance package, and its pins are not this change's to move.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PathRemap {
  readonly from: string;
  readonly to: string;
}

export interface MachinePathNeedle {
  // The label is what gets printed: the value itself is a machine path.
  readonly label: string;
  readonly value: string;
}

export interface MachinePathFinding {
  readonly artifact: string;
  readonly label: string;
  readonly count: number;
}

export interface MachinePathScan {
  readonly artifacts: number;
  readonly bytes: number;
  readonly needles: number;
  readonly findings: readonly MachinePathFinding[];
}

export interface MachinePathContext {
  readonly repositoryRoot: string;
  readonly home: string;
  readonly cargoHome: string;
  readonly rustupHome: string;
}

// Remap targets are fixed strings so that two machines produce the same bytes.
export const REMAP_TARGETS = { home: "~", repository: ".", rustup: "/rustup", cargo: "/cargo" };

function withRealPath(path: string): string[] {
  try {
    const real = realpathSync(path);
    return real === path ? [path] : [path, real];
  } catch {
    // A prefix that does not exist on this machine cannot appear in the artifact.
    return [path];
  }
}

export function machinePathContext(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): MachinePathContext {
  const resolvedHome = resolve(home);
  if (resolvedHome === "/" || resolvedHome.length < 2) {
    throw new Error("Machine-path remap refuses a root home directory");
  }
  return {
    repositoryRoot: resolve(repositoryRoot),
    home: resolvedHome,
    cargoHome: resolve(environment.CARGO_HOME || join(resolvedHome, ".cargo")),
    rustupHome: resolve(environment.RUSTUP_HOME || join(resolvedHome, ".rustup")),
  };
}

export function machinePathRemaps(context: MachinePathContext): PathRemap[] {
  // rustc applies the last matching prefix, so the most specific prefixes come last.
  const ordered: Array<[string, string]> = [
    [context.home, REMAP_TARGETS.home],
    [context.repositoryRoot, REMAP_TARGETS.repository],
    [context.rustupHome, REMAP_TARGETS.rustup],
    [context.cargoHome, REMAP_TARGETS.cargo],
  ];
  const remaps: PathRemap[] = [];
  for (const [from, to] of ordered) {
    for (const variant of withRealPath(from)) {
      // rustc splits FROM=TO on the last `=`; a prefix holding one is ambiguous.
      if (variant.includes("=")) throw new Error("Machine-path remap refuses a path with '='");
      remaps.push({ from: variant, to });
    }
  }
  return remaps;
}

export function remapRustflags(remaps: readonly PathRemap[]): string[] {
  return remaps.map(({ from, to }) => `--remap-path-prefix=${from}=${to}`);
}

// A `--config` value for cargo: arrays from `--config` are appended to the
// rustflags of the configuration files instead of replacing them.
export function remapConfigArgument(key: string, remaps: readonly PathRemap[]): string {
  return `${key}=${JSON.stringify(remapRustflags(remaps))}`;
}

// RUSTFLAGS and its siblings replace configuration rustflags wholesale: the
// remap would be dropped without a sound, so a recipe refuses to run under them.
export function rustflagOverrides(environment: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(environment)
    .filter(
      (name) =>
        Boolean(environment[name]) &&
        (name === "RUSTFLAGS" ||
          name === "CARGO_ENCODED_RUSTFLAGS" ||
          name === "CARGO_BUILD_RUSTFLAGS" ||
          /^CARGO_TARGET_[A-Z0-9_]+_RUSTFLAGS$/.test(name)),
    )
    .sort();
}

export function machinePathNeedles(context: MachinePathContext): MachinePathNeedle[] {
  const candidates: MachinePathNeedle[] = [
    { label: "/Users/", value: "/Users/" },
    { label: "/home/", value: "/home/" },
    { label: ".cargo/registry", value: ".cargo/registry" },
    { label: ".rustup", value: ".rustup" },
    ...withRealPath(context.home).map((value) => ({ label: "HOME", value })),
    ...withRealPath(context.cargoHome).map((value) => ({ label: "CARGO_HOME", value })),
    ...withRealPath(context.rustupHome).map((value) => ({ label: "RUSTUP_HOME", value })),
    ...withRealPath(context.repositoryRoot).map((value) => ({ label: "repository root", value })),
  ];
  const seen = new Set<string>();
  return candidates.filter(({ value }) => !seen.has(value) && Boolean(seen.add(value)));
}

export function countOccurrences(haystack: Uint8Array, needle: string): number {
  const bytes = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
  const pattern = Buffer.from(needle, "utf8");
  if (pattern.length === 0) throw new Error("empty machine-path needle");
  let count = 0;
  let index = bytes.indexOf(pattern);
  while (index !== -1) {
    count += 1;
    index = bytes.indexOf(pattern, index + pattern.length);
  }
  return count;
}

export function scanBytes(
  artifacts: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
  needles: readonly MachinePathNeedle[],
): MachinePathScan {
  if (artifacts.length === 0) throw new Error("machine-path scan examined no artifact");
  if (needles.length === 0) throw new Error("machine-path scan has no needle");
  const findings: MachinePathFinding[] = [];
  let bytes = 0;
  for (const artifact of artifacts) {
    // An empty artifact is an unreadable source, never a clean one.
    if (artifact.bytes.byteLength === 0) {
      throw new Error(`machine-path scan read an empty artifact: ${artifact.name}`);
    }
    bytes += artifact.bytes.byteLength;
    for (const needle of needles) {
      const count = countOccurrences(artifact.bytes, needle.value);
      if (count > 0) findings.push({ artifact: artifact.name, label: needle.label, count });
    }
  }
  return { artifacts: artifacts.length, bytes, needles: needles.length, findings };
}

export async function assertNoMachinePaths(
  context: MachinePathContext,
  artifactPaths: readonly string[],
  displayName: (path: string) => string = (path) => path,
): Promise<MachinePathScan> {
  const artifacts = await Promise.all(
    artifactPaths.map(async (path) => ({
      name: displayName(path),
      bytes: new Uint8Array(await readFile(path)),
    })),
  );
  const scan = scanBytes(artifacts, machinePathNeedles(context));
  console.log(
    `machine-path scan: ${scan.artifacts} artifact(s), ${scan.bytes} byte(s), ${scan.needles} needle(s) examined, ${scan.findings.reduce((total, finding) => total + finding.count, 0)} needle hit(s)`,
  );
  if (scan.findings.length > 0) {
    for (const finding of scan.findings) {
      console.error(`  ${finding.artifact}: ${finding.count} x ${finding.label}`);
    }
    throw new Error("built artifacts embed machine paths");
  }
  return scan;
}
