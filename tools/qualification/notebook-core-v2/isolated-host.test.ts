import { describe, expect, test } from "bun:test";
import { NotebookHostRefusal } from "./host";
import { type QualificationWorker, runIsolatedOperation } from "./isolated-host";

class FakeWorker implements QualificationWorker {
  onerror: QualificationWorker["onerror"] = null;
  onmessage: QualificationWorker["onmessage"] = null;
  onmessageerror: QualificationWorker["onmessageerror"] = null;
  terminated = 0;

  constructor(
    private readonly action:
      | { kind: "error" }
      | { code: string; kind: "refusal" }
      | { kind: "silent" }
      | { kind: "success" }
      | { kind: "throw" }
      | { kind: "invalid" }
      | { kind: "hostile" },
  ) {}

  postMessage(message: unknown, transfer: ArrayBuffer[]): void {
    if (this.action.kind === "throw") throw new Error("private clone detail");
    const requestId = (message as { requestId: number }).requestId;
    structuredClone(message, { transfer });
    if (this.action.kind === "silent") return;
    queueMicrotask(() => {
      if (this.action.kind === "error") {
        this.onerror?.(new ErrorEvent("error"));
      } else if (this.action.kind === "refusal") {
        this.onmessage?.(
          new MessageEvent("message", {
            data: { code: this.action.code, requestId, tag: "err" },
          }),
        );
      } else if (this.action.kind === "invalid") {
        this.onmessage?.(
          new MessageEvent("message", {
            data: { privateDiagnostic: "must not escape", requestId, tag: "ok" },
          }),
        );
      } else if (this.action.kind === "hostile") {
        const data = Object.create(null, {
          requestId: {
            get() {
              throw new Error("private response accessor detail");
            },
          },
        });
        this.onmessage?.(new MessageEvent("message", { data }));
      } else {
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              outputLength: 7,
              outputSha256: "a".repeat(64),
              requestId,
              tag: "ok",
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

async function refusal(promise: Promise<unknown>): Promise<NotebookHostRefusal> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NotebookHostRefusal);
    return error as NotebookHostRefusal;
  }
  throw new Error("expected isolated host refusal");
}

describe("Notebook isolated qualification host", () => {
  test("transfers ownership and terminates the worker after success", async () => {
    const document = new Uint8Array([1, 2, 3]);
    const worker = new FakeWorker({ kind: "success" });
    const result = await runIsolatedOperation(
      { document, kind: "canonicalize" },
      { workerFactory: () => worker },
    );

    expect(result).toEqual({ outputLength: 7, outputSha256: "a".repeat(64) });
    expect(document.byteLength).toBe(0);
    expect(worker.terminated).toBe(1);
  });

  test("maps worker refusals without reflecting diagnostics", async () => {
    const worker = new FakeWorker({ code: "authentication-failed", kind: "refusal" });
    const error = await refusal(
      runIsolatedOperation(
        { envelope: new Uint8Array([1]), kind: "open-digest", recoverySecret: new Uint8Array(16) },
        { workerFactory: () => worker },
      ),
    );

    expect(error.code).toBe("authentication-failed");
    expect(error.message).toBe("Backup authentication failed.");
    expect(worker.terminated).toBe(1);
  });

  test("fails closed for worker errors and malformed responses", async () => {
    for (const action of [{ kind: "error" }, { kind: "invalid" }, { kind: "hostile" }] as const) {
      const worker = new FakeWorker(action);
      const error = await refusal(
        runIsolatedOperation(
          { document: new Uint8Array([1]), kind: "canonicalize" },
          { workerFactory: () => worker },
        ),
      );
      expect(error.code).toBe("internal-failure");
      expect(error.message).toBe("Backup operation failed.");
      expect(error.message).not.toContain("privateDiagnostic");
      expect(worker.terminated).toBe(1);
    }
  });

  test("terminates a hung worker at the closed resource timeout", async () => {
    const worker = new FakeWorker({ kind: "silent" });
    const error = await refusal(
      runIsolatedOperation(
        { document: new Uint8Array([1]), kind: "canonicalize" },
        { timeoutMs: 1, workerFactory: () => worker },
      ),
    );

    expect(error.code).toBe("resource-limit-exceeded");
    expect(error.message).toBe("Backup operation unavailable.");
    expect(worker.terminated).toBe(1);
  });

  test("wipes inputs and terminates when transfer fails", async () => {
    const document = new Uint8Array([1, 2, 3]);
    const worker = new FakeWorker({ kind: "throw" });
    const error = await refusal(
      runIsolatedOperation({ document, kind: "canonicalize" }, { workerFactory: () => worker }),
    );

    expect(error.code).toBe("internal-failure");
    expect([...document]).toEqual([0, 0, 0]);
    expect(worker.terminated).toBe(1);
  });

  test("wipes inputs if worker creation fails", async () => {
    const document = new Uint8Array([1, 2, 3]);
    const error = await refusal(
      runIsolatedOperation(
        { document, kind: "canonicalize" },
        {
          workerFactory() {
            throw new Error("private worker startup detail");
          },
        },
      ),
    );

    expect(error.code).toBe("internal-failure");
    expect([...document]).toEqual([0, 0, 0]);
  });
});
