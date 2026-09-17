import { closedBackupRefusal } from "./material";
import { NotebookBackupRefusal } from "./types";

export const NOTEBOOK_BACKUP_DOWNLOAD_NAME = "notebook-backup.lai";
const MAX_ENVELOPE_BYTES = 22_370_044;

export async function downloadEncryptedBackup(envelope: Uint8Array): Promise<void> {
  if (
    !(envelope instanceof Uint8Array) ||
    !(envelope.buffer instanceof ArrayBuffer) ||
    envelope.byteOffset !== 0 ||
    envelope.byteLength !== envelope.buffer.byteLength ||
    envelope.byteLength < 1 ||
    envelope.byteLength > MAX_ENVELOPE_BYTES
  ) {
    throw new NotebookBackupRefusal("resource-limit-exceeded");
  }

  let objectUrl: string | undefined;
  let anchor: HTMLAnchorElement | undefined;
  try {
    const blob = new Blob([envelope.buffer as ArrayBuffer], {
      type: "application/vnd.libre-ai.notebook-backup+json",
    });
    objectUrl = URL.createObjectURL(blob);
    anchor = document.createElement("a");
    anchor.download = NOTEBOOK_BACKUP_DOWNLOAD_NAME;
    anchor.href = objectUrl;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } catch (error) {
    throw closedBackupRefusal(error);
  } finally {
    anchor?.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
