import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { performanceEvidenceVerdict } from "./resource-class";

const root = resolve(import.meta.dir, "../../..");
const outputDirectory = resolve(root, "target/notebook-core-v2-qualification");
const browsers = ["chromium", "firefox", "webkit"] as const;
const reports: Record<string, unknown> = {};
const sources: Record<string, { path: string; sha256: string }> = {};
let commit: string | undefined;
let componentSha256: string | undefined;
let deviceClass: string | undefined;
let evidenceMode: string | undefined;
let promotableEvidence: boolean | undefined;
let resourceClassManifestSha256: string | undefined;
const violations: string[] = [];

for (const browser of browsers) {
  const path = resolve(outputDirectory, `performance-${browser}.json`);
  const bytes = await readFile(path);
  const report = JSON.parse(bytes.toString("utf8")) as {
    browserName: string;
    commit: string;
    componentSha256: string;
    deviceClass: string;
    evidenceMode: "physical-evidence" | "vm-diagnostic";
    promotableEvidence: boolean;
    resourceClassManifestSha256: string;
    virtualizationDetected: boolean;
    virtualizationSignals: string[];
    profiles: Array<{
      browserPeakRssDeltaBytes: number;
      memoryBudgetBytes: number;
      name: string;
      open: { endToEndP95Ms: number };
      p95BudgetMs: number;
      seal: { endToEndP95Ms: number };
    }>;
  };
  if (
    report.browserName !== browser ||
    (commit !== undefined && report.commit !== commit) ||
    (componentSha256 !== undefined && report.componentSha256 !== componentSha256) ||
    (deviceClass !== undefined && report.deviceClass !== deviceClass) ||
    (evidenceMode !== undefined && report.evidenceMode !== evidenceMode) ||
    (promotableEvidence !== undefined && report.promotableEvidence !== promotableEvidence) ||
    (resourceClassManifestSha256 !== undefined &&
      report.resourceClassManifestSha256 !== resourceClassManifestSha256)
  ) {
    throw new Error(`Inconsistent ${browser} performance evidence`);
  }
  if (
    report.evidenceMode === "physical-evidence" &&
    (report.virtualizationDetected || report.virtualizationSignals.length > 0)
  ) {
    throw new Error(`Virtualized ${browser} report cannot be physical evidence`);
  }
  for (const profile of report.profiles) {
    if (profile.seal.endToEndP95Ms > profile.p95BudgetMs) {
      violations.push(`${browser}/${profile.name}/seal-p95`);
    }
    if (profile.open.endToEndP95Ms > profile.p95BudgetMs) {
      violations.push(`${browser}/${profile.name}/open-p95`);
    }
    if (profile.browserPeakRssDeltaBytes > profile.memoryBudgetBytes) {
      violations.push(`${browser}/${profile.name}/browser-peak-rss-delta`);
    }
  }
  commit = report.commit;
  componentSha256 = report.componentSha256;
  deviceClass = report.deviceClass;
  evidenceMode = report.evidenceMode;
  promotableEvidence = report.promotableEvidence;
  resourceClassManifestSha256 = report.resourceClassManifestSha256;
  reports[browser] = report;
  sources[browser] = {
    path: `target/notebook-core-v2-qualification/performance-${browser}.json`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const verdict = performanceEvidenceVerdict(
  evidenceMode,
  promotableEvidence,
  violations.length === 0,
);
const summary = {
  browsers: reports,
  commit,
  componentSha256,
  deviceClass,
  evidenceMode,
  promotableEvidence,
  resourceClassManifestSha256,
  schemaVersion: "libre-ai.notebook-core-v2-browser-performance-matrix.v2",
  sources,
  verdict,
  violations,
};
await writeFile(
  resolve(outputDirectory, "performance-summary.json"),
  `${JSON.stringify(summary)}\n`,
);
console.log(
  `Notebook performance matrix: verdict=${summary.verdict} class=${deviceClass} commit=${commit} component=${componentSha256}`,
);
if (violations.length > 0) {
  console.error(`Performance budget violations: ${violations.join(", ")}`);
  process.exitCode = 1;
}
