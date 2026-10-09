// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// Dependency policy gate (decision Y43, 2026-10-09): executes this
// repository's own `deny.toml` against its committed Cargo graph(s) with
// cargo-deny — advisories, bans, licenses and sources — from the required
// check.
//
// Why the binary is fetched here rather than taken from PATH: the required
// check runs inside the source composition, whose runner installs Bun, Node
// and Rust but no cargo-deny, and the composition workflow is not this
// repository's to change. Why it is pinned by archive sha256 and not resolved
// with `cargo install`: `cargo install` resolves against a mutable registry
// and would silently change the enforcing binary between two runs of the same
// commit (same pin and same digests as the fleet template
// `reusable-dependency-policy.yml`). The cached archive is re-hashed on every
// run, so the cache is never trusted beyond its digest.
//
// Why advisories block here although the fleet template only reports them:
// Y43 makes advisories part of the required verdict. The verdict therefore
// depends on the RustSec database of the day; an accepted risk is recorded as
// a dated waiver in `deny.toml` under docs/security/ADVISORY-WAIVER-POLICY.md
// (project-governance), never as a silent exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const CARGO_DENY_VERSION = "0.19.5";

export interface CargoDenyArchive {
  readonly triple: string;
  readonly url: string;
  readonly sha256: string;
}

// Digests measured on the release archives and cross-checked against the
// `.sha256` files published with release 0.19.5.
const ARCHIVE_DIGESTS: Readonly<Record<string, { triple: string; sha256: string }>> = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    sha256: "0cf28e019edb3708ba9755b8c822864ee6d6175d6fc167956972e78ea9ff0be3",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    sha256: "36102b6ab83a546036ada57526227317a7827e1788ce39ac6df1c9102b86fa10",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    sha256: "f23d2b4e343a54af3d925b557294c8c9d00dacb7bb98663f995a4427efebe1db",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    sha256: "5ea64ae09959b5fe1072d898f95caaa89b374678ba6728d5e9ed1366745479b0",
  },
};

const ARCHIVE_BYTE_LIMIT = 64 * 1024 * 1024;

export function archiveFor(platform: string, arch: string): CargoDenyArchive {
  const entry = ARCHIVE_DIGESTS[`${platform}-${arch}`];
  if (entry === undefined) {
    throw new Error(`No pinned cargo-deny ${CARGO_DENY_VERSION} archive for ${platform}-${arch}`);
  }
  return {
    triple: entry.triple,
    sha256: entry.sha256,
    url: `https://github.com/EmbarkStudios/cargo-deny/releases/download/${CARGO_DENY_VERSION}/cargo-deny-${CARGO_DENY_VERSION}-${entry.triple}.tar.gz`,
  };
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyDigest(bytes: Uint8Array, expected: string): void {
  const actual = sha256Of(bytes);
  if (actual !== expected) {
    throw new Error(`cargo-deny archive digest mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Number of `[[package]]` entries in a Cargo.lock — the volume the gate examined. */
export function countLockedPackages(lockText: string): number {
  return lockText.split("\n").filter((line) => line.trim() === "[[package]]").length;
}

export interface Arguments {
  readonly root: string;
  readonly manifests: readonly string[];
}

export function parseArguments(argv: readonly string[], defaultRoot: string): Arguments {
  let root = defaultRoot;
  const manifests: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith("--root=")) {
      root = resolve(argument.slice("--root=".length));
    } else if (argument.startsWith("--manifest-path=")) {
      const manifest = argument.slice("--manifest-path=".length);
      if (manifest === "" || isAbsolute(manifest) || manifest.split(/[\\/]/).includes("..")) {
        throw new Error(`--manifest-path must be repository-relative: ${manifest}`);
      }
      manifests.push(manifest);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { root, manifests: manifests.length === 0 ? ["Cargo.toml"] : manifests };
}

function readRequired(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // An unreadable declared source is a failure, never an empty pass.
    throw new Error(`UNREADABLE ${label} (${path}): ${(error as Error).message}`);
  }
}

function cacheDirectory(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "libre-ai", "cargo-deny", CARGO_DENY_VERSION);
}

async function obtainArchive(archive: CargoDenyArchive): Promise<Uint8Array> {
  const cached = join(
    cacheDirectory(),
    `cargo-deny-${CARGO_DENY_VERSION}-${archive.triple}.tar.gz`,
  );
  if (existsSync(cached)) {
    const bytes = new Uint8Array(readFileSync(cached));
    if (sha256Of(bytes) === archive.sha256) return bytes;
    rmSync(cached, { force: true });
  }
  const response = await fetch(archive.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Cannot download ${archive.url}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > ARCHIVE_BYTE_LIMIT) {
    throw new Error(`cargo-deny archive exceeds ${ARCHIVE_BYTE_LIMIT} bytes`);
  }
  verifyDigest(bytes, archive.sha256);
  mkdirSync(dirname(cached), { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, cached);
  return bytes;
}

function run(command: string, args: readonly string[], cwd: string): number {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { root, manifests } = parseArguments(argv, resolve(import.meta.dir, "..", ".."));
  const config = join(root, "deny.toml");
  readRequired(config, "deny.toml");
  let lockedPackages = 0;
  for (const manifest of manifests) {
    const manifestPath = join(root, manifest);
    readRequired(manifestPath, manifest);
    const lock = join(dirname(manifestPath), "Cargo.lock");
    lockedPackages += countLockedPackages(readRequired(lock, `${dirname(manifest)}/Cargo.lock`));
  }

  const archive = archiveFor(process.platform, process.arch);
  const bytes = await obtainArchive(archive);
  const scratch = mkdtempSync(join(tmpdir(), "cargo-deny-"));
  try {
    const tarball = join(scratch, "cargo-deny.tar.gz");
    writeFileSync(tarball, bytes);
    if (run("tar", ["-xzf", tarball, "-C", scratch], scratch) !== 0) {
      throw new Error("Cannot extract the cargo-deny archive");
    }
    const binary = join(
      scratch,
      `cargo-deny-${CARGO_DENY_VERSION}-${archive.triple}`,
      "cargo-deny",
    );
    const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
    if (version.status !== 0 || version.stdout.trim() !== `cargo-deny ${CARGO_DENY_VERSION}`) {
      throw new Error(
        `Unexpected cargo-deny binary: ${version.stdout ?? ""}${version.stderr ?? ""}`,
      );
    }

    for (const manifest of manifests) {
      console.log(`cargo-deny ${CARGO_DENY_VERSION} check: ${manifest} with deny.toml`);
      const status = run(
        binary,
        [
          "--locked",
          "--color",
          "never",
          "--manifest-path",
          join(root, manifest),
          "--workspace",
          "check",
          "--config",
          config,
          "--show-stats",
          "advisories",
          "bans",
          "licenses",
          "sources",
        ],
        root,
      );
      if (status !== 0) {
        console.error(`Dependency policy FAILED for ${manifest} (cargo-deny exit ${status}).`);
        return 1;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    `Dependency policy verified: advisories, bans, licenses and sources hold for ` +
      `${manifests.length} manifest(s), ${lockedPackages} locked package(s) inspected ` +
      `(cargo-deny ${CARGO_DENY_VERSION}, archive sha256 ${archive.sha256}).`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
