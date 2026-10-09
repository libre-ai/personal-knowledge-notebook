import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertReleaseProfile,
  citedScripts,
  EXPECTED_VECTOR_COUNTS,
  goldenVectorsPath,
  inventoryGoldenVectors,
  QualificationInputError,
  undeclaredScripts,
} from "./inputs";

function vectors(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fill = (count: number): unknown[] =>
    Array.from({ length: count }, (_, index) => ({ index }));
  return {
    schemaVersion: "public-test",
    golden: { envelope: {} },
    mutations: fill(EXPECTED_VECTOR_COUNTS.backupMutations),
    contextCanonicalization: {
      golden: { normalized: {} },
      mutations: fill(EXPECTED_VECTOR_COUNTS.contextMutations),
      numericCases: fill(EXPECTED_VECTOR_COUNTS.numericCases),
      resourceCases: fill(EXPECTED_VECTOR_COUNTS.resourceCases),
    },
    ...overrides,
  };
}

function writeVectors(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "nbcore-inputs-")), "golden-vectors.v1.json");
  writeFileSync(path, content);
  return path;
}

describe("golden vector inventory", () => {
  test("resolves the fixture through the pinned contracts authority, not a repository-local copy", () => {
    expect(goldenVectorsPath("/work/repository")).toBe(
      "/work/repository/node_modules/@libre-ai/contracts-authority/contracts/fixtures/notebook-core-v2/golden-vectors.v1.json",
    );
  });

  test("counts every vector family and digests the file", () => {
    const inventory = inventoryGoldenVectors(writeVectors(JSON.stringify(vectors())));
    expect(inventory).toMatchObject({
      backupGolden: 1,
      backupMutations: EXPECTED_VECTOR_COUNTS.backupMutations,
      contextGolden: 1,
      contextMutations: EXPECTED_VECTOR_COUNTS.contextMutations,
      numericCases: EXPECTED_VECTOR_COUNTS.numericCases,
      resourceCases: EXPECTED_VECTOR_COUNTS.resourceCases,
    });
    expect(inventory.total).toBe(
      2 +
        EXPECTED_VECTOR_COUNTS.backupMutations +
        EXPECTED_VECTOR_COUNTS.contextMutations +
        EXPECTED_VECTOR_COUNTS.numericCases +
        EXPECTED_VECTOR_COUNTS.resourceCases,
    );
    expect(inventory.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fails on an absent fixture instead of reporting zero vectors", () => {
    expect(() => inventoryGoldenVectors("/nonexistent/golden-vectors.v1.json")).toThrow(
      QualificationInputError,
    );
  });

  test("fails on an unreadable (non-JSON) fixture", () => {
    expect(() => inventoryGoldenVectors(writeVectors("{ not json"))).toThrow(
      QualificationInputError,
    );
  });

  test("fails when a vector family is missing", () => {
    const broken = vectors();
    delete broken.mutations;
    expect(() => inventoryGoldenVectors(writeVectors(JSON.stringify(broken)))).toThrow(/mutations/);
  });

  test("fails when a vector family changes size: a moved golden vector is a stop, not an adaptation", () => {
    const shrunk = vectors({ mutations: [{ index: 0 }] });
    expect(() => inventoryGoldenVectors(writeVectors(JSON.stringify(shrunk)))).toThrow(
      /mutations: expected 10, found 1/,
    );
  });
});

describe("scripts cited by documentation", () => {
  test("extracts root and workspace-scoped invocations, ignoring prose", () => {
    const text = [
      "Run `bun run qualify:one` then",
      "bun run --cwd apps/notebook build:gate-b",
      "and bun run check.",
      "bun runtime is not a script",
    ].join("\n");
    expect(citedScripts(text)).toEqual([
      { cwd: ".", script: "qualify:one" },
      { cwd: "apps/notebook", script: "build:gate-b" },
      { cwd: ".", script: "check" },
    ]);
  });

  test("reports each cited script that the target package.json does not declare", () => {
    const cited = [
      { cwd: ".", script: "qualify:one" },
      { cwd: ".", script: "check" },
      { cwd: "apps/notebook", script: "build" },
    ];
    const declared = new Map([
      [".", new Set(["check"])],
      ["apps/notebook", new Set(["build"])],
    ]);
    expect(undeclaredScripts(cited, declared)).toEqual([{ cwd: ".", script: "qualify:one" }]);
  });

  test("treats a workspace without a package.json as declaring nothing", () => {
    expect(
      undeclaredScripts([{ cwd: "apps/missing", script: "build" }], new Map([[".", new Set()]])),
    ).toEqual([{ cwd: "apps/missing", script: "build" }]);
  });
});

describe("release profile of the wasm build", () => {
  const profile = [
    "[workspace]",
    'members = ["crates/notebook-core"]',
    "",
    "[profile.release]",
    "lto = true",
    "codegen-units = 1",
    "strip = true",
    'panic = "abort"',
    "",
  ].join("\n");

  test("accepts the profile that reproduces the qualified core", () => {
    expect(() => assertReleaseProfile(profile)).not.toThrow();
  });

  test("refuses an absent profile (the unoptimized build is another binary)", () => {
    expect(() => assertReleaseProfile('[workspace]\nmembers = ["crates/notebook-core"]\n')).toThrow(
      QualificationInputError,
    );
  });

  test("refuses a profile whose value drifted", () => {
    expect(() => assertReleaseProfile(profile.replace("lto = true", "lto = false"))).toThrow(/lto/);
  });
});
