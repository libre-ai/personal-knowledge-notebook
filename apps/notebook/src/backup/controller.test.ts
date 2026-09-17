import { describe, expect, test } from "bun:test";
import { NotebookBackupController } from "./controller";
import type { NotebookBackupPersistence } from "./indexed-db";
import { NotebookBackupRefusal, type OpenedBackup, type RestoredBackupMetadata } from "./types";

class FakePersistence implements NotebookBackupPersistence {
  calls: string[] = [];
  encryptedBackup: Uint8Array | undefined;
  stagedEnvelope: Uint8Array | undefined;

  async commitRestore(operationId: string, _metadata: RestoredBackupMetadata): Promise<void> {
    this.calls.push(`commit:${operationId}`);
  }

  async discardRestore(operationId: string): Promise<void> {
    this.calls.push(`discard:${operationId}`);
  }

  async recordEncryptedBackup(envelope: Uint8Array): Promise<void> {
    this.calls.push("record-backup");
    this.encryptedBackup = envelope.slice();
  }

  async recoverInterruptedRestores(): Promise<number> {
    this.calls.push("recover");
    return 2;
  }

  async stageEncryptedRestore(operationId: string, envelope: Uint8Array): Promise<void> {
    this.calls.push(`stage:${operationId}`);
    this.stagedEnvelope = envelope.slice();
  }
}

const deterministicRandom = {
  getRandomValues<T extends ArrayBufferView | null>(value: T): T {
    if (!(value instanceof Uint8Array)) throw new Error("unexpected random view");
    value.fill(0x0a);
    return value;
  },
};

const metadata = {
  digest: "a".repeat(64),
  id: `urn:libre-ai:backup:${"b".repeat(32)}`,
  schemaVersion: "libre-ai.notebook-backup.v2",
} as const;

describe("Notebook backup controller", () => {
  test("publishes recovery only after persisting and downloading encrypted bytes", async () => {
    const persistence = new FakePersistence();
    const events: string[] = [];
    const plaintext = new Uint8Array([1, 2, 3]);
    const envelope = new Uint8Array([9, 8, 7]);
    const controller = new NotebookBackupController({
      download: async (value) => {
        events.push("download");
        expect([...value]).toEqual([9, 8, 7]);
      },
      host: {
        async createBackup(value) {
          events.push("seal");
          expect(value).toBe(plaintext);
          return { envelope, recoveryCode: "01".repeat(16) };
        },
        async openBackupForUse() {
          throw new Error("not used");
        },
      },
      persistence: {
        ...persistence,
        commitRestore: persistence.commitRestore.bind(persistence),
        discardRestore: persistence.discardRestore.bind(persistence),
        recordEncryptedBackup: async (value) => {
          events.push("persist");
          await persistence.recordEncryptedBackup(value);
        },
        recoverInterruptedRestores: persistence.recoverInterruptedRestores.bind(persistence),
        stageEncryptedRestore: persistence.stageEncryptedRestore.bind(persistence),
      },
      randomSource: deterministicRandom,
      restoreConsumer: () => undefined,
      snapshotProvider: () => plaintext,
    });

    await controller.createBackup((code) => {
      events.push("recovery");
      expect(code).toBe("01".repeat(16));
    });

    expect(events).toEqual(["seal", "persist", "download", "recovery"]);
    expect(persistence.encryptedBackup && [...persistence.encryptedBackup]).toEqual([9, 8, 7]);
    expect([...plaintext]).toEqual([0, 0, 0]);
    expect([...envelope]).toEqual([0, 0, 0]);
  });

  test("does not publish recovery or download after a persistence refusal", async () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const envelope = new Uint8Array([9, 8, 7]);
    let published = false;
    let downloaded = false;
    const controller = new NotebookBackupController({
      download: async () => {
        downloaded = true;
      },
      host: {
        async createBackup() {
          return { envelope, recoveryCode: "01".repeat(16) };
        },
        async openBackupForUse() {
          throw new Error("not used");
        },
      },
      persistence: {
        async commitRestore() {},
        async discardRestore() {},
        async recordEncryptedBackup() {
          throw new NotebookBackupRefusal("resource-limit-exceeded");
        },
        async recoverInterruptedRestores() {
          return 0;
        },
        async stageEncryptedRestore() {},
      },
      restoreConsumer: () => undefined,
      snapshotProvider: () => plaintext,
    });

    await expect(
      controller.createBackup(() => {
        published = true;
      }),
    ).rejects.toMatchObject({ code: "resource-limit-exceeded" });

    expect(published).toBe(false);
    expect(downloaded).toBe(false);
    expect([...plaintext]).toEqual([0, 0, 0]);
    expect([...envelope]).toEqual([0, 0, 0]);
  });

  test("does not publish recovery after a download refusal", async () => {
    const persistence = new FakePersistence();
    const plaintext = new Uint8Array([1, 2, 3]);
    const envelope = new Uint8Array([9, 8, 7]);
    let published = false;
    const controller = new NotebookBackupController({
      download: async () => {
        throw new NotebookBackupRefusal("resource-limit-exceeded");
      },
      host: {
        async createBackup() {
          return { envelope, recoveryCode: "01".repeat(16) };
        },
        async openBackupForUse() {
          throw new Error("not used");
        },
      },
      persistence,
      restoreConsumer: () => undefined,
      snapshotProvider: () => plaintext,
    });

    await expect(
      controller.createBackup(() => {
        published = true;
      }),
    ).rejects.toMatchObject({ code: "resource-limit-exceeded" });

    expect(published).toBe(false);
    expect(persistence.calls).toEqual(["record-backup"]);
    expect(persistence.encryptedBackup && [...persistence.encryptedBackup]).toEqual([9, 8, 7]);
    expect([...plaintext]).toEqual([0, 0, 0]);
    expect([...envelope]).toEqual([0, 0, 0]);
  });

  test("stages only encrypted input and commits after plaintext consumption", async () => {
    const persistence = new FakePersistence();
    const events: string[] = [];
    const plaintext = new Uint8Array([4, 5, 6]);
    const envelope = new Uint8Array([7, 8, 9]);
    const controller = new NotebookBackupController({
      host: {
        async createBackup() {
          throw new Error("not used");
        },
        async openBackupForUse(value, _code, consume) {
          events.push("open");
          value.fill(0);
          const opened: OpenedBackup = { ...metadata, plaintext };
          const result = await consume(opened);
          plaintext.fill(0);
          return { metadata, result };
        },
      },
      persistence: {
        commitRestore: async (id, value) => {
          events.push("commit");
          await persistence.commitRestore(id, value);
        },
        discardRestore: persistence.discardRestore.bind(persistence),
        recordEncryptedBackup: persistence.recordEncryptedBackup.bind(persistence),
        recoverInterruptedRestores: persistence.recoverInterruptedRestores.bind(persistence),
        stageEncryptedRestore: async (id, value) => {
          events.push("stage");
          await persistence.stageEncryptedRestore(id, value);
        },
      },
      randomSource: deterministicRandom,
      restoreConsumer: (opened) => {
        events.push("consume");
        expect([...opened.plaintext]).toEqual([4, 5, 6]);
      },
      snapshotProvider: () => new Uint8Array([1]),
    });

    const restored = await controller.restoreBackup(envelope, "00".repeat(16));

    expect(restored).toEqual(metadata);
    expect(events).toEqual(["stage", "open", "consume", "commit"]);
    expect(persistence.stagedEnvelope && [...persistence.stagedEnvelope]).toEqual([7, 8, 9]);
    expect([...plaintext]).toEqual([0, 0, 0]);
    expect([...envelope]).toEqual([0, 0, 0]);
    expect(persistence.calls.some((call) => call.startsWith("discard:"))).toBe(false);
  });

  test("discards encrypted staging after authentication refusal", async () => {
    const persistence = new FakePersistence();
    const controller = new NotebookBackupController({
      host: {
        async createBackup() {
          throw new Error("not used");
        },
        async openBackupForUse() {
          throw new NotebookBackupRefusal("authentication-failed");
        },
      },
      persistence,
      randomSource: deterministicRandom,
      restoreConsumer: () => undefined,
      snapshotProvider: () => new Uint8Array([1]),
    });

    await expect(controller.restoreBackup(new Uint8Array([1]), "bad")).rejects.toMatchObject({
      code: "authentication-failed",
    });
    expect(persistence.calls[0]).toMatch(/^stage:op_/);
    expect(persistence.calls[1]).toMatch(/^discard:op_/);
  });

  test("delegates startup cleanup of interrupted encrypted staging", async () => {
    const persistence = new FakePersistence();
    const controller = new NotebookBackupController({
      host: {
        async createBackup() {
          throw new Error("not used");
        },
        async openBackupForUse() {
          throw new Error("not used");
        },
      },
      persistence,
      restoreConsumer: () => undefined,
      snapshotProvider: () => new Uint8Array([1]),
    });

    expect(await controller.recoverInterruptedRestores()).toBe(2);
    expect(persistence.calls).toEqual(["recover"]);
  });
});
