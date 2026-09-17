import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type NotebookHardwareResources,
  parseResourceClassManifest,
  performanceEvidenceVerdict,
  selectEvidenceEnvironment,
  selectResourceClass,
} from "./resource-class";

const rawManifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "toolchains/notebook-resource-classes.json"), "utf8"),
) as unknown;
const manifest = parseResourceClassManifest(rawManifest);
const GIB = 1024 ** 3;

function hardware(memoryGib: number, logicalCpu: number): NotebookHardwareResources {
  return {
    architecture: "arm64",
    hardwareModel: "Mac14,2",
    hypervisorPresent: false,
    logicalCpu,
    memoryBytes: memoryGib * GIB,
    operatingSystem: "darwin",
    processor: "public-test-processor",
  };
}

describe("Notebook qualification resource classes", () => {
  test("defines the qualified 32+ GiB reference as the minimum product candidate", () => {
    const selected = selectResourceClass(
      manifest,
      manifest.minimumProductCandidateClassId,
      hardware(36, 14),
    );
    expect(selected.id).toBe("desktop-arm64-high-memory-reference");
    expect(selected.evidenceStatus).toBe("qualified-reference-96934a8");
    expect(selected.purpose).toBe("minimum-product-candidate");
    for (const id of ["desktop-arm64-constrained-8gib", "desktop-arm64-mainstream-16gib"]) {
      const community = manifest.classes.find((candidate) => candidate.id === id);
      expect(community?.evidenceStatus).toBe("community-evidence-requested");
      expect(community?.purpose).toBe("community-observation");
    }
    expect(manifest.productStorageQuotaCandidateBytes).toBe(512 * 1024 ** 2);
  });

  test("requires bounded process recovery while keeping real browser OOM diagnostic-only", () => {
    expect(manifest.browserProcessFaultPolicy).toEqual({
      optionalDiagnostics: ["browser-process-oom"],
      requiredEvidence: [
        "abrupt-process-termination-recovery",
        "process-crash-recovery",
        "no-partial-artifact",
        "same-profile-recovery",
        "fresh-worker-after-recovery",
      ],
      unsafeHostExhaustionForbidden: true,
    });
  });

  test("accepts each observed hardware tier only in its own range", () => {
    expect(
      selectResourceClass(manifest, "desktop-arm64-mainstream-16gib", hardware(16, 8)).id,
    ).toBe("desktop-arm64-mainstream-16gib");
    expect(
      selectResourceClass(manifest, "desktop-arm64-mainstream-16gib", hardware(24, 10)).id,
    ).toBe("desktop-arm64-mainstream-16gib");
    expect(
      selectResourceClass(manifest, "desktop-arm64-high-memory-reference", hardware(32, 12)).id,
    ).toBe("desktop-arm64-high-memory-reference");
    expect(() =>
      selectResourceClass(manifest, "desktop-arm64-constrained-8gib", hardware(12, 8)),
    ).toThrow("memory is outside");
    expect(() =>
      selectResourceClass(manifest, "desktop-arm64-mainstream-16gib", hardware(32, 12)),
    ).toThrow("memory is outside");
    expect(() =>
      selectResourceClass(manifest, "desktop-arm64-constrained-8gib", hardware(36, 14)),
    ).toThrow("memory is outside");
  });

  test("separates promotable physical evidence from VM diagnostics", () => {
    expect(selectEvidenceEnvironment("physical-evidence", hardware(8, 8))).toEqual({
      mode: "physical-evidence",
      promotable: true,
      virtualizationDetected: false,
      virtualizationSignals: [],
    });
    const virtualMachine = {
      ...hardware(8, 8),
      hardwareModel: "VirtualMac2,1",
      hypervisorPresent: true,
    };
    expect(selectEvidenceEnvironment("vm-diagnostic", virtualMachine)).toEqual({
      mode: "vm-diagnostic",
      promotable: false,
      virtualizationDetected: true,
      virtualizationSignals: ["kern.hv_vmm_present", "hw.model"],
    });
    expect(() => selectEvidenceEnvironment("physical-evidence", virtualMachine)).toThrow(
      "cannot produce physical evidence",
    );
    expect(() => selectEvidenceEnvironment(undefined, hardware(8, 8))).toThrow(
      "NOTEBOOK_QUALIFICATION_EVIDENCE_MODE",
    );
  });

  test("keeps explicit VM diagnostics non-promotable when a guest hides virtualization", () => {
    expect(selectEvidenceEnvironment("vm-diagnostic", hardware(8, 8))).toMatchObject({
      mode: "vm-diagnostic",
      promotable: false,
      virtualizationDetected: false,
    });
  });

  test("never emits a qualification verdict for VM diagnostics", () => {
    expect(performanceEvidenceVerdict("vm-diagnostic", false, true)).toBe(
      "diagnostic-budgets-pass",
    );
    expect(performanceEvidenceVerdict("vm-diagnostic", false, false)).toBe("reject");
    expect(performanceEvidenceVerdict("physical-evidence", true, true)).toBe(
      "qualification-budgets-pass",
    );
    expect(() => performanceEvidenceVerdict("vm-diagnostic", true, true)).toThrow(
      "must not be promotable",
    );
  });

  test("fails closed outside memory, CPU, platform, architecture, or known class boundaries", () => {
    expect(() =>
      selectResourceClass(manifest, "desktop-arm64-constrained-8gib", hardware(7, 8)),
    ).toThrow("memory is outside");
    expect(() =>
      selectResourceClass(manifest, "desktop-arm64-constrained-8gib", hardware(8, 7)),
    ).toThrow("CPU count is outside");
    expect(() =>
      selectResourceClass(manifest, "desktop-arm64-constrained-8gib", {
        ...hardware(8, 8),
        operatingSystem: "linux",
      }),
    ).toThrow("platform is outside");
    expect(() =>
      selectResourceClass(manifest, "desktop-arm64-constrained-8gib", {
        ...hardware(8, 8),
        architecture: "x64",
      }),
    ).toThrow("platform is outside");
    expect(() => selectResourceClass(manifest, "unknown", hardware(8, 8))).toThrow(
      "unknown Notebook resource class",
    );
  });

  test("rejects unknown fields, policies, statuses, duplicate classes, and invalid minimums", () => {
    expect(() =>
      parseResourceClassManifest({ ...(rawManifest as object), unexpected: true }),
    ).toThrow("invalid fields");
    const duplicated = structuredClone(rawManifest) as {
      classes: unknown[];
    };
    duplicated.classes.push(structuredClone(duplicated.classes[0]));
    expect(() => parseResourceClassManifest(duplicated)).toThrow("duplicate");
    const unresolved = structuredClone(rawManifest) as {
      minimumProductCandidateClassId: string;
    };
    unresolved.minimumProductCandidateClassId = "desktop-missing";
    expect(() => parseResourceClassManifest(unresolved)).toThrow("unresolved");
    const communityMinimum = structuredClone(rawManifest) as {
      minimumProductCandidateClassId: string;
    };
    communityMinimum.minimumProductCandidateClassId = "desktop-arm64-constrained-8gib";
    expect(() => parseResourceClassManifest(communityMinimum)).toThrow(
      "minimum product class purpose is invalid",
    );
    const unknownStatus = structuredClone(rawManifest) as {
      classes: Array<{ evidenceStatus: string }>;
    };
    if (unknownStatus.classes[0]) unknownStatus.classes[0].evidenceStatus = "self-declared";
    expect(() => parseResourceClassManifest(unknownStatus)).toThrow("status or purpose is invalid");
    const weakenedFaultPolicy = structuredClone(rawManifest) as {
      browserProcessFaultPolicy: {
        requiredEvidence: string[];
        unsafeHostExhaustionForbidden: boolean;
      };
    };
    weakenedFaultPolicy.browserProcessFaultPolicy.requiredEvidence.pop();
    expect(() => parseResourceClassManifest(weakenedFaultPolicy)).toThrow(
      "required browser process fault evidence",
    );
    weakenedFaultPolicy.browserProcessFaultPolicy.requiredEvidence.push(
      "fresh-worker-after-recovery",
    );
    weakenedFaultPolicy.browserProcessFaultPolicy.unsafeHostExhaustionForbidden = false;
    expect(() => parseResourceClassManifest(weakenedFaultPolicy)).toThrow(
      "unsafe Notebook host exhaustion",
    );
  });
});
