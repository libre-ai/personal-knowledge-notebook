import { NOTEBOOK_BACKUP_FEATURE_ENABLED } from "../backup/feature";

export function assertNotebookBuildMode(value: unknown, expectedEnabled: boolean): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("notebook.build_manifest_invalid");
  }
  const manifest = value as Record<string, unknown>;
  const expected = expectedEnabled ? "gate-b" : "disabled";
  if (
    manifest.schemaVersion !== "libre-ai.notebook-product-build.v1" ||
    manifest.backupFeature !== expected
  ) {
    throw new Error("notebook.build_runtime_gate_mismatch");
  }
}

export async function verifyNotebookBuildMode(manifestPath: string): Promise<void> {
  let value: unknown;
  try {
    value = await Bun.file(manifestPath).json();
  } catch {
    throw new Error("notebook.build_manifest_invalid");
  }
  assertNotebookBuildMode(value, NOTEBOOK_BACKUP_FEATURE_ENABLED);
}
