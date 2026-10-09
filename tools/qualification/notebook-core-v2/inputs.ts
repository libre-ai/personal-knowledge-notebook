import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Inputs of the Notebook core v2 qualification harness that nothing else
 * verifies: the golden-vector fixture (canonical in the contracts authority),
 * the release profile that makes the wasm build reproducible, and the scripts
 * the documentation tells a reader to run.
 */

export class QualificationInputError extends Error {
  override readonly name = "QualificationInputError";
}

// The families and sizes the harness README promises: ten backup refusals,
// twelve Context refusals, eight numeric and six resource boundaries. A family
// that changes size means a golden vector moved; that is a stop to report to
// the contracts authority, never a number to edit here.
export const EXPECTED_VECTOR_COUNTS = {
  backupMutations: 10,
  contextMutations: 12,
  numericCases: 8,
  resourceCases: 6,
} as const;

export type VectorInventory = {
  backupGolden: 1;
  backupMutations: number;
  contextGolden: 1;
  contextMutations: number;
  numericCases: number;
  path: string;
  resourceCases: number;
  sha256: string;
  total: number;
};

const AUTHORITY_FIXTURE =
  "node_modules/@libre-ai/contracts-authority/contracts/fixtures/notebook-core-v2/golden-vectors.v1.json";

/** The fixture is consumed from the pinned authority, never copied into this repository. */
export function goldenVectorsPath(repositoryRoot: string): string {
  return join(repositoryRoot, AUTHORITY_FIXTURE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): void {
  if (!isRecord(value)) throw new QualificationInputError(`${label}: missing or not an object`);
}

function requireCount(value: unknown, label: string, expected: number): number {
  if (!Array.isArray(value)) {
    throw new QualificationInputError(`${label}: missing or not an array`);
  }
  if (value.length !== expected) {
    throw new QualificationInputError(`${label}: expected ${expected}, found ${value.length}`);
  }
  return value.length;
}

/**
 * Reads and counts the golden vectors. An absent, unreadable or reshaped
 * fixture is an error: a missing source must never read as "zero vectors, nothing
 * to check".
 */
export function inventoryGoldenVectors(path: string): VectorInventory {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new QualificationInputError(
      `golden vectors unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new QualificationInputError(`golden vectors at ${path} are not valid JSON`);
  }
  requireRecord(parsed, "golden vectors");
  const root = parsed as Record<string, unknown>;
  requireRecord(root.golden, "golden");
  requireRecord(root.contextCanonicalization, "contextCanonicalization");
  const context = root.contextCanonicalization as Record<string, unknown>;
  requireRecord(context.golden, "contextCanonicalization.golden");

  const backupMutations = requireCount(
    root.mutations,
    "mutations",
    EXPECTED_VECTOR_COUNTS.backupMutations,
  );
  const contextMutations = requireCount(
    context.mutations,
    "contextCanonicalization.mutations",
    EXPECTED_VECTOR_COUNTS.contextMutations,
  );
  const numericCases = requireCount(
    context.numericCases,
    "contextCanonicalization.numericCases",
    EXPECTED_VECTOR_COUNTS.numericCases,
  );
  const resourceCases = requireCount(
    context.resourceCases,
    "contextCanonicalization.resourceCases",
    EXPECTED_VECTOR_COUNTS.resourceCases,
  );

  return {
    backupGolden: 1,
    backupMutations,
    contextGolden: 1,
    contextMutations,
    numericCases,
    path,
    resourceCases,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    total: 2 + backupMutations + contextMutations + numericCases + resourceCases,
  };
}

export type CitedScript = { cwd: string; script: string };

/** `bun run [--cwd <dir>] <script>` invocations written in a document, in first-seen order. */
export function citedScripts(text: string): CitedScript[] {
  const seen = new Set<string>();
  const cited: CitedScript[] = [];
  for (const match of text.matchAll(/\bbun run(?: --cwd (\S+))? ([a-z][\w:-]*)/g)) {
    const cwd = match[1] ?? ".";
    const script = match[2] ?? "";
    const key = `${cwd}\u0000${script}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cited.push({ cwd, script });
  }
  return cited;
}

/** Cited scripts whose workspace does not declare them. A workspace with no manifest declares nothing. */
export function undeclaredScripts(
  cited: CitedScript[],
  declared: Map<string, Set<string>>,
): CitedScript[] {
  return cited.filter(({ cwd, script }) => !(declared.get(cwd)?.has(script) ?? false));
}

const REQUIRED_RELEASE_PROFILE = {
  "codegen-units": 1,
  lto: true,
  panic: "abort",
  strip: true,
} as const;

/**
 * The qualified core fingerprint is only reproducible with the optimized,
 * stripped release profile. Without `strip` the module keeps a `name` section
 * whose symbol hashes follow the checkout path, so the same source yields a
 * different fingerprint at every location.
 */
export function assertReleaseProfile(cargoToml: string): void {
  let manifest: unknown;
  try {
    manifest = Bun.TOML.parse(cargoToml);
  } catch {
    throw new QualificationInputError("Cargo.toml is not valid TOML");
  }
  const profile =
    isRecord(manifest) && isRecord(manifest.profile) ? manifest.profile.release : null;
  if (!isRecord(profile)) {
    throw new QualificationInputError("Cargo.toml declares no [profile.release]");
  }
  for (const [key, expected] of Object.entries(REQUIRED_RELEASE_PROFILE)) {
    if (profile[key] !== expected) {
      throw new QualificationInputError(
        `[profile.release] ${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(profile[key])}`,
      );
    }
  }
}
