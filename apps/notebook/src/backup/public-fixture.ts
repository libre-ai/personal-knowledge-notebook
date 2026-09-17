import { NotebookBackupRefusal, type OpenedBackup } from "./types";

const PUBLIC_FIXTURE = new TextEncoder().encode(
  '{"blocks":[],"schemaVersion":"libre-ai.notebook-product-host-fixture.v1"}',
);

export function createPublicNotebookSnapshot(): Uint8Array {
  return PUBLIC_FIXTURE.slice();
}

export function consumePublicNotebookSnapshot(opened: OpenedBackup): void {
  const plaintext = opened.plaintext;
  if (plaintext.length !== PUBLIC_FIXTURE.length) {
    throw new NotebookBackupRefusal("invalid-envelope");
  }
  for (let index = 0; index < plaintext.length; index += 1) {
    if (plaintext[index] !== PUBLIC_FIXTURE[index]) {
      throw new NotebookBackupRefusal("invalid-envelope");
    }
  }
}
