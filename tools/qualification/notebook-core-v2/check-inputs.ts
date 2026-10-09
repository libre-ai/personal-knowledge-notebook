import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertReleaseProfile,
  type CitedScript,
  citedScripts,
  goldenVectorsPath,
  inventoryGoldenVectors,
  QualificationInputError,
  undeclaredScripts,
} from "./inputs";
import { parseResourceClassManifest } from "./resource-class";

/**
 * Required gate for the inputs of the Notebook core v2 qualification harness.
 * It runs everywhere (no browser, no pinned hardware) and prints what it
 * examined: a verdict without volume is compatible with having examined nothing.
 */
const root = process.cwd();

function trackedMarkdown(): string[] {
  const listing = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", "*.md"],
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (listing.exitCode !== 0) {
    throw new QualificationInputError("git ls-files failed: the documents cannot be enumerated");
  }
  return listing.stdout.toString().split("\0").filter(Boolean).sort();
}

function declaredScripts(cwd: string): Set<string> {
  const manifest = join(root, cwd, "package.json");
  if (!existsSync(manifest)) return new Set();
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> };
  return new Set(Object.keys(parsed.scripts ?? {}));
}

function run(): string[] {
  const lines: string[] = [];

  const vectors = inventoryGoldenVectors(goldenVectorsPath(root));
  lines.push(
    `golden vectors: ${vectors.total} examined (${vectors.backupGolden} backup golden, ${vectors.contextGolden} Context golden, ${vectors.backupMutations} backup refusals, ${vectors.contextMutations} Context refusals, ${vectors.numericCases} numeric, ${vectors.resourceCases} resource) sha256=${vectors.sha256}`,
  );

  const resourceBytes = readFileSync(join(root, "toolchains/notebook-resource-classes.json"));
  const resources = parseResourceClassManifest(JSON.parse(resourceBytes.toString("utf8")));
  lines.push(
    `resource classes: ${resources.classes.length} parsed sha256=${createHash("sha256").update(resourceBytes).digest("hex")}`,
  );

  assertReleaseProfile(readFileSync(join(root, "Cargo.toml"), "utf8"));
  lines.push("release profile: lto, codegen-units=1, strip, panic=abort");

  const documents = trackedMarkdown();
  const cited: CitedScript[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    for (const citation of citedScripts(readFileSync(join(root, document), "utf8"))) {
      const key = `${citation.cwd}\u0000${citation.script}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cited.push(citation);
    }
  }
  const declared = new Map(
    [...new Set(cited.map(({ cwd }) => cwd))].map((cwd) => [cwd, declaredScripts(cwd)]),
  );
  const missing = undeclaredScripts(cited, declared);
  if (missing.length > 0) {
    throw new QualificationInputError(
      `documented scripts that no package.json declares: ${missing
        .map(({ cwd, script }) => `${cwd === "." ? "" : `${cwd}: `}${script}`)
        .join(", ")}`,
    );
  }
  lines.push(
    `documented scripts: ${cited.length} distinct invocations in ${documents.length} documents, all declared`,
  );
  return lines;
}

try {
  for (const line of run()) console.log(line);
  console.log("Notebook core v2 qualification inputs verified");
} catch (error) {
  console.error(
    error instanceof QualificationInputError
      ? `Notebook core v2 qualification inputs rejected: ${error.message}`
      : error,
  );
  process.exit(1);
}
