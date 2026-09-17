import { describe, expect, test } from "bun:test";
import { IndexedDbNotebookBackupPersistence } from "./indexed-db";
import { NotebookBackupRefusal } from "./types";

describe("Notebook encrypted persistence boundary", () => {
  test("rejects a partial view before IndexedDB can clone unrelated backing bytes", async () => {
    let opens = 0;
    const factory = {
      open: () => {
        opens += 1;
        throw new Error("must not open");
      },
    } as unknown as IDBFactory;
    const persistence = new IndexedDbNotebookBackupPersistence(factory);
    const backing = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const partialEnvelope = backing.subarray(1, 2);

    const error = await persistence
      .recordEncryptedBackup(partialEnvelope)
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(NotebookBackupRefusal);
    expect((error as NotebookBackupRefusal).code).toBe("resource-limit-exceeded");
    expect([...backing]).toEqual([0xaa, 0, 0xcc]);
    expect(opens).toBe(0);
  });
});
