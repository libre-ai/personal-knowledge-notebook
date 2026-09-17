import { describe, expect, test } from "bun:test";
import { NotebookBackupHost, type ProductBackupWorker } from "./operation-host";
import { NotebookBackupRefusal } from "./types";

class FakeWorker implements ProductBackupWorker {
  onerror: ProductBackupWorker["onerror"] = null;
  onmessage: ProductBackupWorker["onmessage"] = null;
  onmessageerror: ProductBackupWorker["onmessageerror"] = null;
  failedPlaintext: Uint8Array | undefined;
  recoveryLength = 0;
  terminated = 0;

  constructor(
    private readonly action:
      | "error"
      | "hostile"
      | "invalid-open"
      | "open-success"
      | "refusal"
      | "seal-success"
      | "silent"
      | "throw",
  ) {}

  postMessage(message: unknown, transfer: ArrayBuffer[]): void {
    if (this.action === "throw") throw new Error("private clone detail");
    const cloned = structuredClone(message, { transfer }) as {
      operation: string;
      recoverySecret: Uint8Array;
      requestId: number;
    };
    this.recoveryLength = cloned.recoverySecret.length;
    if (this.action === "silent") return;
    queueMicrotask(() => {
      if (this.action === "error") {
        this.onerror?.(new ErrorEvent("error"));
      } else if (this.action === "hostile") {
        const data = Object.create(null, {
          requestId: {
            get() {
              throw new Error("private accessor detail");
            },
          },
        });
        this.onmessage?.(new MessageEvent("message", { data }));
      } else if (this.action === "refusal") {
        this.onmessage?.(
          new MessageEvent("message", {
            data: { code: "authentication-failed", requestId: cloned.requestId, tag: "err" },
          }),
        );
      } else if (this.action === "invalid-open") {
        this.failedPlaintext = new Uint8Array([5, 6, 7]);
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              digest: "invalid",
              id: `urn:libre-ai:backup:${"b".repeat(32)}`,
              plaintext: this.failedPlaintext,
              requestId: cloned.requestId,
              schemaVersion: "libre-ai.notebook-backup.v2",
              tag: "open-ok",
            },
          }),
        );
      } else if (this.action === "seal-success") {
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              envelope: new TextEncoder().encode('{"schemaVersion":"test"}'),
              requestId: cloned.requestId,
              tag: "seal-ok",
            },
          }),
        );
      } else {
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              digest: "a".repeat(64),
              id: `urn:libre-ai:backup:${"b".repeat(32)}`,
              plaintext: new Uint8Array([7, 8, 9]),
              requestId: cloned.requestId,
              schemaVersion: "libre-ai.notebook-backup.v2",
              tag: "open-ok",
            },
          }),
        );
      }
    });
  }

  terminate(): void {
    this.terminated += 1;
  }
}

const deterministicRandom = {
  next: 0,
  getRandomValues<T extends ArrayBufferView | null>(value: T): T {
    if (!(value instanceof Uint8Array)) throw new Error("unexpected random view");
    for (let index = 0; index < value.length; index += 1) {
      value[index] = this.next & 0xff;
      this.next += 1;
    }
    return value;
  },
};

async function refusal(action: Promise<unknown>): Promise<NotebookBackupRefusal> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(NotebookBackupRefusal);
    return error as NotebookBackupRefusal;
  }
  throw new Error("expected backup refusal");
}

describe("Notebook product backup operation host", () => {
  test("creates fresh material, transfers plaintext ownership and terminates the worker", async () => {
    deterministicRandom.next = 0;
    const worker = new FakeWorker("seal-success");
    const plaintext = new Uint8Array([1, 2, 3]);
    const host = new NotebookBackupHost({
      randomSource: deterministicRandom,
      workerFactory: () => worker,
    });

    const created = await host.createBackup(plaintext);

    expect(plaintext.byteLength).toBe(0);
    expect(created.recoveryCode).toMatch(/^[a-f0-9]{32}$/);
    expect(new TextDecoder().decode(created.envelope)).toContain("schemaVersion");
    expect(worker.recoveryLength).toBe(16);
    expect(worker.terminated).toBe(1);
  });

  test("releases opened plaintext only to the consumer and wipes it afterwards", async () => {
    const worker = new FakeWorker("open-success");
    const host = new NotebookBackupHost({ workerFactory: () => worker });
    const envelope = new Uint8Array([1, 2, 3]);
    let consumed: Uint8Array | undefined;

    const restored = await host.openBackupForUse(envelope, "00".repeat(16), (opened) => {
      consumed = opened.plaintext;
      expect([...opened.plaintext]).toEqual([7, 8, 9]);
      return "accepted";
    });

    expect(restored.result).toBe("accepted");
    expect(restored.metadata.digest).toBe("a".repeat(64));
    expect(consumed && [...consumed]).toEqual([0, 0, 0]);
    expect(envelope.byteLength).toBe(0);
    expect(worker.terminated).toBe(1);
  });

  test("wipes plaintext received in a malformed worker response", async () => {
    const worker = new FakeWorker("invalid-open");
    const host = new NotebookBackupHost({ workerFactory: () => worker });
    const error = await refusal(
      host.openBackupForUse(new Uint8Array([1]), "00".repeat(16), () => undefined),
    );

    expect(error.code).toBe("internal-failure");
    expect(worker.failedPlaintext && [...worker.failedPlaintext]).toEqual([0, 0, 0]);
    expect(worker.terminated).toBe(1);
  });

  test("keeps malformed recovery attempts on the closed worker path", async () => {
    const worker = new FakeWorker("refusal");
    const host = new NotebookBackupHost({ workerFactory: () => worker });
    const error = await refusal(
      host.openBackupForUse(new Uint8Array([1]), "NOT-A-CODE", () => undefined),
    );

    expect(error.code).toBe("authentication-failed");
    expect(error.message).toBe("Backup authentication failed.");
    expect(worker.recoveryLength).toBe(15);
    expect(worker.terminated).toBe(1);
  });

  test("terminates on timeout, worker failure and hostile response", async () => {
    for (const action of ["silent", "error", "hostile"] as const) {
      const worker = new FakeWorker(action);
      const host = new NotebookBackupHost({ timeoutMs: 1, workerFactory: () => worker });
      const error = await refusal(host.createBackup(new Uint8Array([1])));
      expect(["internal-failure", "resource-limit-exceeded"]).toContain(error.code);
      expect(worker.terminated).toBe(1);
    }
  });

  test("wipes input when worker creation fails", async () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const host = new NotebookBackupHost({
      workerFactory() {
        throw new Error("private worker startup detail");
      },
    });
    const error = await refusal(host.createBackup(plaintext));

    expect(error.code).toBe("internal-failure");
    expect([...plaintext]).toEqual([0, 0, 0]);
  });

  test("wipes input and terminates when transfer fails", async () => {
    const worker = new FakeWorker("throw");
    const host = new NotebookBackupHost({ workerFactory: () => worker });
    const plaintext = new Uint8Array([1, 2, 3]);
    const error = await refusal(host.createBackup(plaintext));

    expect(error.code).toBe("internal-failure");
    expect([...plaintext]).toEqual([0, 0, 0]);
    expect(worker.terminated).toBe(1);
  });

  test("rejects a shared backing buffer instead of transferring unrelated bytes", async () => {
    const backing = new Uint8Array([9, 1, 2, 9]);
    const subview = backing.subarray(1, 3);
    const host = new NotebookBackupHost({ workerFactory: () => new FakeWorker("seal-success") });
    const error = await refusal(host.createBackup(subview));

    expect(error.code).toBe("resource-limit-exceeded");
    expect([...backing]).toEqual([9, 0, 0, 9]);
  });
});
