import { closedBackupRefusal } from "./material";
import { NotebookBackupRefusal } from "./types";

export const NOTEBOOK_STORAGE_QUOTA_FLOOR_BYTES = 536_870_912;

export async function verifyNotebookBackupRuntime(): Promise<void> {
  try {
    const source = new Uint8Array([0x5a]);
    const transferred = structuredClone(source, { transfer: [source.buffer] });
    const estimate = await navigator.storage.estimate();
    if (
      !isSecureContext ||
      typeof Worker !== "function" ||
      typeof indexedDB !== "object" ||
      typeof crypto?.getRandomValues !== "function" ||
      typeof estimate.quota !== "number" ||
      typeof estimate.usage !== "number" ||
      !Number.isFinite(estimate.quota) ||
      !Number.isFinite(estimate.usage) ||
      Math.max(0, estimate.quota - estimate.usage) < NOTEBOOK_STORAGE_QUOTA_FLOOR_BYTES ||
      source.byteLength !== 0 ||
      transferred.byteLength !== 1 ||
      transferred[0] !== 0x5a
    ) {
      throw new NotebookBackupRefusal("resource-limit-exceeded");
    }
  } catch (error) {
    throw closedBackupRefusal(error);
  }
}
