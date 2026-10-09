// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveFor,
  CARGO_DENY_VERSION,
  countLockedPackages,
  main,
  parseArguments,
  REQUIRED_CHECKS,
  sha256Of,
  verifyDigest,
} from "./check-dependency-policy";

describe("REQUIRED_CHECKS", () => {
  test("keeps the calendar-dependent advisory verdict out of the required check (I-26)", () => {
    expect([...REQUIRED_CHECKS]).toEqual(["bans", "licenses", "sources"]);
  });
});

describe("archiveFor", () => {
  test("pins the CI runner archive to the fleet template digest", () => {
    const archive = archiveFor("linux", "x64");
    expect(archive.triple).toBe("x86_64-unknown-linux-musl");
    expect(archive.sha256).toBe("5ea64ae09959b5fe1072d898f95caaa89b374678ba6728d5e9ed1366745479b0");
    expect(archive.url).toBe(
      `https://github.com/EmbarkStudios/cargo-deny/releases/download/${CARGO_DENY_VERSION}/cargo-deny-${CARGO_DENY_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    );
  });

  test("refuses a platform without a pinned digest", () => {
    expect(() => archiveFor("win32", "x64")).toThrow("No pinned cargo-deny");
  });
});

describe("verifyDigest", () => {
  test("accepts matching bytes and rejects altered bytes", () => {
    const bytes = new TextEncoder().encode("archive");
    expect(() => verifyDigest(bytes, sha256Of(bytes))).not.toThrow();
    expect(() => verifyDigest(new TextEncoder().encode("archivf"), sha256Of(bytes))).toThrow(
      "digest mismatch",
    );
  });
});

describe("countLockedPackages", () => {
  test("counts every [[package]] entry", () => {
    const lock = 'version = 4\n\n[[package]]\nname = "a"\n\n[[package]]\nname = "b"\n';
    expect(countLockedPackages(lock)).toBe(2);
    expect(countLockedPackages("version = 4\n")).toBe(0);
  });
});

describe("parseArguments", () => {
  test("defaults to the root manifest", () => {
    expect(parseArguments([], "/repo")).toEqual({ root: "/repo", manifests: ["Cargo.toml"] });
  });

  test("refuses a manifest outside the repository", () => {
    expect(() => parseArguments(["--manifest-path=../x/Cargo.toml"], "/repo")).toThrow(
      "repository-relative",
    );
    expect(() => parseArguments(["--manifest-path=/x/Cargo.toml"], "/repo")).toThrow(
      "repository-relative",
    );
    expect(() => parseArguments(["--unknown"], "/repo")).toThrow("Unknown argument");
  });
});

describe("main", () => {
  test("fails on a missing deny.toml instead of passing an empty graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "dependency-policy-"));
    try {
      await expect(main([`--root=${root}`])).rejects.toThrow("UNREADABLE deny.toml");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails on a missing Cargo.lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "dependency-policy-"));
    try {
      writeFileSync(join(root, "deny.toml"), "[licenses]\n");
      writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
      await expect(main([`--root=${root}`])).rejects.toThrow("UNREADABLE ./Cargo.lock");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
