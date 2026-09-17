export type NotebookEvidenceMode = "physical-evidence" | "vm-diagnostic";

export type NotebookHardwareResources = {
  architecture: string;
  hardwareModel: string;
  hypervisorPresent: boolean;
  logicalCpu: number;
  memoryBytes: number;
  operatingSystem: string;
  processor: string;
};

export type NotebookEvidenceEnvironment = {
  mode: NotebookEvidenceMode;
  promotable: boolean;
  virtualizationDetected: boolean;
  virtualizationSignals: string[];
};

export type NotebookBrowserProcessFaultPolicy = {
  optionalDiagnostics: Array<"browser-process-oom">;
  requiredEvidence: Array<
    | "abrupt-process-termination-recovery"
    | "process-crash-recovery"
    | "no-partial-artifact"
    | "same-profile-recovery"
    | "fresh-worker-after-recovery"
  >;
  unsafeHostExhaustionForbidden: true;
};

export type NotebookResourceClass = {
  architecture: string;
  evidenceStatus:
    | "community-evidence-requested"
    | "pending-real-hardware-qualification"
    | "qualified-reference-5190972"
    | "qualified-reference-96934a8";
  id: string;
  label: string;
  maximumLogicalCpuExclusive: number | null;
  maximumPhysicalMemoryBytesExclusive: number | null;
  minimumLogicalCpu: number;
  minimumPhysicalMemoryBytes: number;
  operatingSystem: string;
  purpose:
    | "community-observation"
    | "minimum-product-candidate"
    | "mainstream-product-target"
    | "qualification-reference";
};

export type NotebookResourceClassManifest = {
  browserProcessFaultPolicy: NotebookBrowserProcessFaultPolicy;
  classes: NotebookResourceClass[];
  defaultQualificationClassId: string;
  minimumProductCandidateClassId: string;
  productStorageQuotaCandidateBytes: number;
  requiredBrowserCapabilities: string[];
  schemaVersion: "libre-ai.notebook-resource-classes.v2";
};

const REQUIRED_BROWSER_PROCESS_FAULT_EVIDENCE = [
  "abrupt-process-termination-recovery",
  "process-crash-recovery",
  "no-partial-artifact",
  "same-profile-recovery",
  "fresh-worker-after-recovery",
] as const;
const OPTIONAL_BROWSER_PROCESS_DIAGNOSTICS = ["browser-process-oom"] as const;
const BROWSER_PROCESS_FAULT_POLICY_KEYS = [
  "optionalDiagnostics",
  "requiredEvidence",
  "unsafeHostExhaustionForbidden",
] as const;
const CLASS_KEYS = [
  "architecture",
  "evidenceStatus",
  "id",
  "label",
  "maximumLogicalCpuExclusive",
  "maximumPhysicalMemoryBytesExclusive",
  "minimumLogicalCpu",
  "minimumPhysicalMemoryBytes",
  "operatingSystem",
  "purpose",
] as const;
const MANIFEST_KEYS = [
  "browserProcessFaultPolicy",
  "classes",
  "defaultQualificationClassId",
  "minimumProductCandidateClassId",
  "productStorageQuotaCandidateBytes",
  "requiredBrowserCapabilities",
  "schemaVersion",
] as const;
const EVIDENCE_STATUSES = new Set([
  "community-evidence-requested",
  "pending-real-hardware-qualification",
  "qualified-reference-5190972",
  "qualified-reference-96934a8",
]);
const PURPOSES = new Set([
  "community-observation",
  "minimum-product-candidate",
  "mainstream-product-target",
  "qualification-reference",
]);

export function parseResourceClassManifest(value: unknown): NotebookResourceClassManifest {
  const manifest = record(value, "resource class manifest");
  exactKeys(manifest, MANIFEST_KEYS, "resource class manifest");
  if (manifest.schemaVersion !== "libre-ai.notebook-resource-classes.v2") {
    throw new Error("unsupported Notebook resource class manifest");
  }
  const browserProcessFaultPolicy = parseBrowserProcessFaultPolicy(
    manifest.browserProcessFaultPolicy,
  );
  const classes = array(manifest.classes, "resource classes").map((entry) => parseClass(entry));
  if (classes.length < 1) throw new Error("Notebook resource classes are empty");
  const ids = new Set(classes.map(({ id }) => id));
  if (ids.size !== classes.length) throw new Error("duplicate Notebook resource class id");

  const defaultQualificationClassId = nonemptyString(
    manifest.defaultQualificationClassId,
    "default qualification class",
  );
  const minimumProductCandidateClassId = nonemptyString(
    manifest.minimumProductCandidateClassId,
    "minimum product candidate class",
  );
  if (!ids.has(defaultQualificationClassId) || !ids.has(minimumProductCandidateClassId)) {
    throw new Error("Notebook resource class reference is unresolved");
  }
  const minimumClass = classes.find(({ id }) => id === minimumProductCandidateClassId);
  if (minimumClass?.purpose !== "minimum-product-candidate") {
    throw new Error("Notebook minimum product class purpose is invalid");
  }

  const requiredBrowserCapabilities = array(
    manifest.requiredBrowserCapabilities,
    "required browser capabilities",
  ).map((entry) => nonemptyString(entry, "browser capability"));
  if (
    requiredBrowserCapabilities.length < 1 ||
    new Set(requiredBrowserCapabilities).size !== requiredBrowserCapabilities.length
  ) {
    throw new Error("Notebook browser capabilities are empty or duplicated");
  }

  return {
    browserProcessFaultPolicy,
    classes,
    defaultQualificationClassId,
    minimumProductCandidateClassId,
    productStorageQuotaCandidateBytes: positiveInteger(
      manifest.productStorageQuotaCandidateBytes,
      "product storage quota candidate",
    ),
    requiredBrowserCapabilities,
    schemaVersion: "libre-ai.notebook-resource-classes.v2",
  };
}

export function selectEvidenceEnvironment(
  requestedMode: string | undefined,
  hardware: NotebookHardwareResources,
): NotebookEvidenceEnvironment {
  if (requestedMode !== "physical-evidence" && requestedMode !== "vm-diagnostic") {
    throw new Error(
      "NOTEBOOK_QUALIFICATION_EVIDENCE_MODE must be physical-evidence or vm-diagnostic",
    );
  }
  const virtualizationSignals: string[] = [];
  if (hardware.hypervisorPresent) virtualizationSignals.push("kern.hv_vmm_present");
  if (/virtual|vmware|parallels|qemu/i.test(hardware.hardwareModel)) {
    virtualizationSignals.push("hw.model");
  }
  if (/virtual|vmware|parallels|qemu/i.test(hardware.processor)) {
    virtualizationSignals.push("processor");
  }
  const virtualizationDetected = virtualizationSignals.length > 0;
  if (requestedMode === "physical-evidence" && virtualizationDetected) {
    throw new Error("virtualized Notebook host cannot produce physical evidence");
  }
  return {
    mode: requestedMode,
    promotable: requestedMode === "physical-evidence" && !virtualizationDetected,
    virtualizationDetected,
    virtualizationSignals,
  };
}

export function performanceEvidenceVerdict(
  mode: string | undefined,
  promotable: boolean | undefined,
  budgetPass: boolean,
): "diagnostic-budgets-pass" | "qualification-budgets-pass" | "reject" {
  if (mode !== "physical-evidence" && mode !== "vm-diagnostic") {
    throw new Error("Notebook performance evidence mode is missing or invalid");
  }
  if (mode === "physical-evidence" && promotable !== true) {
    throw new Error("Physical Notebook performance evidence is not promotable");
  }
  if (mode === "vm-diagnostic" && promotable !== false) {
    throw new Error("VM Notebook diagnostics must not be promotable");
  }
  if (!budgetPass) return "reject";
  return mode === "physical-evidence" ? "qualification-budgets-pass" : "diagnostic-budgets-pass";
}

export function selectResourceClass(
  manifest: NotebookResourceClassManifest,
  requestedId: string | undefined,
  hardware: NotebookHardwareResources,
): NotebookResourceClass {
  const id = requestedId || manifest.defaultQualificationClassId;
  const selected = manifest.classes.find((candidate) => candidate.id === id);
  if (!selected) throw new Error("unknown Notebook resource class");
  if (
    hardware.operatingSystem !== selected.operatingSystem ||
    hardware.architecture !== selected.architecture
  ) {
    throw new Error("Notebook qualification host platform is outside the selected resource class");
  }
  if (
    !Number.isSafeInteger(hardware.memoryBytes) ||
    hardware.memoryBytes < selected.minimumPhysicalMemoryBytes ||
    (selected.maximumPhysicalMemoryBytesExclusive !== null &&
      hardware.memoryBytes >= selected.maximumPhysicalMemoryBytesExclusive)
  ) {
    throw new Error("Notebook qualification host memory is outside the selected resource class");
  }
  if (
    !Number.isSafeInteger(hardware.logicalCpu) ||
    hardware.logicalCpu < selected.minimumLogicalCpu ||
    (selected.maximumLogicalCpuExclusive !== null &&
      hardware.logicalCpu >= selected.maximumLogicalCpuExclusive)
  ) {
    throw new Error("Notebook qualification host CPU count is outside the selected resource class");
  }
  return selected;
}

function parseBrowserProcessFaultPolicy(value: unknown): NotebookBrowserProcessFaultPolicy {
  const policy = record(value, "browser process fault policy");
  exactKeys(policy, BROWSER_PROCESS_FAULT_POLICY_KEYS, "browser process fault policy");
  const requiredEvidence = canonicalStringInventory(
    policy.requiredEvidence,
    REQUIRED_BROWSER_PROCESS_FAULT_EVIDENCE,
    "required browser process fault evidence",
  );
  const optionalDiagnostics = canonicalStringInventory(
    policy.optionalDiagnostics,
    OPTIONAL_BROWSER_PROCESS_DIAGNOSTICS,
    "optional browser process diagnostics",
  );
  if (policy.unsafeHostExhaustionForbidden !== true) {
    throw new Error("unsafe Notebook host exhaustion must remain forbidden");
  }
  return {
    optionalDiagnostics:
      optionalDiagnostics as NotebookBrowserProcessFaultPolicy["optionalDiagnostics"],
    requiredEvidence: requiredEvidence as NotebookBrowserProcessFaultPolicy["requiredEvidence"],
    unsafeHostExhaustionForbidden: true,
  };
}

function parseClass(value: unknown): NotebookResourceClass {
  const candidate = record(value, "resource class");
  exactKeys(candidate, CLASS_KEYS, "resource class");
  const minimumPhysicalMemoryBytes = positiveInteger(
    candidate.minimumPhysicalMemoryBytes,
    "minimum physical memory",
  );
  const maximumPhysicalMemoryBytesExclusive = nullablePositiveInteger(
    candidate.maximumPhysicalMemoryBytesExclusive,
    "maximum physical memory",
  );
  const minimumLogicalCpu = positiveInteger(candidate.minimumLogicalCpu, "minimum logical CPU");
  const maximumLogicalCpuExclusive = nullablePositiveInteger(
    candidate.maximumLogicalCpuExclusive,
    "maximum logical CPU",
  );
  if (
    (maximumPhysicalMemoryBytesExclusive !== null &&
      maximumPhysicalMemoryBytesExclusive <= minimumPhysicalMemoryBytes) ||
    (maximumLogicalCpuExclusive !== null && maximumLogicalCpuExclusive <= minimumLogicalCpu)
  ) {
    throw new Error("Notebook resource class range is empty");
  }
  const evidenceStatus = nonemptyString(candidate.evidenceStatus, "evidence status");
  const purpose = nonemptyString(candidate.purpose, "resource class purpose");
  if (!EVIDENCE_STATUSES.has(evidenceStatus) || !PURPOSES.has(purpose)) {
    throw new Error("Notebook resource class status or purpose is invalid");
  }
  const id = nonemptyString(candidate.id, "resource class id");
  if (!/^desktop-[a-z0-9-]+$/.test(id)) throw new Error("invalid Notebook resource class id");
  return {
    architecture: nonemptyString(candidate.architecture, "resource class architecture"),
    evidenceStatus: evidenceStatus as NotebookResourceClass["evidenceStatus"],
    id,
    label: nonemptyString(candidate.label, "resource class label"),
    maximumLogicalCpuExclusive,
    maximumPhysicalMemoryBytesExclusive,
    minimumLogicalCpu,
    minimumPhysicalMemoryBytes,
    operatingSystem: nonemptyString(candidate.operatingSystem, "resource class operating system"),
    purpose: purpose as NotebookResourceClass["purpose"],
  };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`invalid fields in ${label}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value;
}

function canonicalStringInventory(
  value: unknown,
  expected: readonly string[],
  label: string,
): string[] {
  const actual = array(value, label).map((entry) => nonemptyString(entry, label));
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(`invalid ${label}`);
  }
  return actual;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) throw new Error(`invalid ${label}`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`invalid ${label}`);
  return value as number;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value === null ? null : positiveInteger(value, label);
}
