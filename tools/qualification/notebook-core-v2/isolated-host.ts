import { type ErrorCode, NotebookHostRefusal, type SealBackupRequest } from "./host";

export type QualificationFault =
  | "none"
  | "oom"
  | "trap"
  | "hang"
  | "internal-oom"
  | "internal-panic"
  | "internal-serde-oom"
  | "internal-jcs-oom"
  | "internal-argon2-oom";

export type IsolatedOperation =
  | { kind: "canonicalize"; document: Uint8Array }
  | { kind: "seal"; request: SealBackupRequest; recoverySecret: Uint8Array }
  | { kind: "open-digest"; envelope: Uint8Array; recoverySecret: Uint8Array };

export type IsolatedResult = {
  outputLength: number;
  outputSha256: string;
};

type WorkerRequest = {
  fault: QualificationFault;
  operation: IsolatedOperation;
  requestId: number;
};

type WorkerResponse =
  | ({ requestId: number; tag: "ok" } & IsolatedResult)
  | { code: ErrorCode; requestId: number; tag: "err" };

export type QualificationWorker = {
  onerror: ((event: ErrorEvent) => unknown) | null;
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null;
  postMessage(message: WorkerRequest, transfer: ArrayBuffer[]): void;
  terminate(): void;
};

type IsolationOptions = {
  fault?: QualificationFault;
  timeoutMs?: number;
  workerFactory?: () => QualificationWorker;
};

const ERROR_CODES = new Set<ErrorCode>([
  "invalid-document",
  "invalid-seal-request",
  "invalid-envelope",
  "unsupported-version",
  "resource-limit-exceeded",
  "authentication-failed",
  "internal-failure",
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
let nextRequestId = 1;

export function runIsolatedOperation(
  operation: IsolatedOperation,
  options: IsolationOptions = {},
): Promise<IsolatedResult> {
  const ownedViews = operationViews(operation);
  const requestId = nextRequestId;
  nextRequestId = nextRequestId === Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;

  let worker: QualificationWorker;
  try {
    worker = (options.workerFactory ?? defaultWorkerFactory)();
  } catch {
    wipeViews(ownedViews);
    return Promise.reject(new NotebookHostRefusal("internal-failure"));
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    worker.terminate();
    wipeViews(ownedViews);
    return Promise.reject(new NotebookHostRefusal("internal-failure"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: IsolatedResult | NotebookHostRefusal): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (result instanceof NotebookHostRefusal) reject(result);
      else resolve(result);
    };
    const timeout = setTimeout(
      () => finish(new NotebookHostRefusal("resource-limit-exceeded")),
      timeoutMs,
    );

    worker.onmessage = (event) => {
      let response: WorkerResponse | null;
      try {
        response = decodeResponse(event.data, requestId);
      } catch {
        response = null;
      }
      if (response === null) {
        finish(new NotebookHostRefusal("internal-failure"));
      } else if (response.tag === "err") {
        finish(new NotebookHostRefusal(response.code));
      } else {
        finish({ outputLength: response.outputLength, outputSha256: response.outputSha256 });
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new NotebookHostRefusal("internal-failure"));
    };
    worker.onmessageerror = () => finish(new NotebookHostRefusal("internal-failure"));

    try {
      const transfer = transferableBuffers(ownedViews);
      worker.postMessage({ fault: options.fault ?? "none", operation, requestId }, transfer);
    } catch {
      finish(new NotebookHostRefusal("internal-failure"));
    } finally {
      wipeViews(ownedViews);
    }
  });
}

function defaultWorkerFactory(): QualificationWorker {
  return new Worker(new URL("./fault-worker.js", import.meta.url), {
    name: "notebook-core-v2-qualification",
    type: "module",
  }) as QualificationWorker;
}

function operationViews(operation: IsolatedOperation): Uint8Array[] {
  switch (operation.kind) {
    case "canonicalize":
      return [operation.document];
    case "seal":
      return [
        operation.request.kdf.salt,
        operation.request.nonce,
        operation.request.plaintext,
        operation.recoverySecret,
      ];
    case "open-digest":
      return [operation.envelope, operation.recoverySecret];
  }
}

function transferableBuffers(views: Uint8Array[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const view of views) {
    if (!(view instanceof Uint8Array) || !(view.buffer instanceof ArrayBuffer)) {
      throw new NotebookHostRefusal("internal-failure");
    }
    buffers.add(view.buffer);
  }
  return [...buffers];
}

function wipeViews(views: Uint8Array[]): void {
  for (const view of views) {
    try {
      view.fill(0);
    } catch {
      // A successfully transferred ArrayBuffer is detached and owned by the worker.
    }
  }
}

function decodeResponse(value: unknown, requestId: number): WorkerResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.requestId !== requestId) return null;
  if (record.tag === "err") {
    if (
      Object.keys(record).length !== 3 ||
      typeof record.code !== "string" ||
      !ERROR_CODES.has(record.code as ErrorCode)
    ) {
      return null;
    }
    return record as WorkerResponse;
  }
  if (
    record.tag !== "ok" ||
    Object.keys(record).length !== 4 ||
    !Number.isSafeInteger(record.outputLength) ||
    (record.outputLength as number) < 0 ||
    typeof record.outputSha256 !== "string" ||
    !SHA256_HEX.test(record.outputSha256)
  ) {
    return null;
  }
  return record as WorkerResponse;
}
