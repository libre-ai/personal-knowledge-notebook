import {
  closedBackupRefusal,
  decodeRecoveryAttempt,
  encodeRecoveryCode,
  freshBackupId,
  freshBytes,
  type RandomSource,
} from "./material";
import {
  type CreatedBackup,
  NotebookBackupRefusal,
  type NotebookCoreErrorCode,
  type OpenedBackup,
  type RestoredBackupMetadata,
  type SealBackupRequest,
} from "./types";

const MAX_ENVELOPE_BYTES = 22_370_044;
const MAX_PLAINTEXT_BYTES = 16_777_216;
const ERROR_CODES = new Set<NotebookCoreErrorCode>([
  "invalid-document",
  "invalid-seal-request",
  "invalid-envelope",
  "unsupported-version",
  "resource-limit-exceeded",
  "authentication-failed",
  "internal-failure",
]);
const BACKUP_ID = /^urn:libre-ai:backup:[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
let nextRequestId = 1;

export type ProductBackupWorker = {
  onerror: ((event: ErrorEvent) => unknown) | null;
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null;
  postMessage(message: WorkerRequest, transfer: ArrayBuffer[]): void;
  terminate(): void;
};

type WorkerRequest =
  | {
      operation: "seal";
      recoverySecret: Uint8Array;
      request: SealBackupRequest;
      requestId: number;
    }
  | {
      envelope: Uint8Array;
      operation: "open";
      recoverySecret: Uint8Array;
      requestId: number;
    };

type WorkerResponse =
  | { code: NotebookCoreErrorCode; requestId: number; tag: "err" }
  | { envelope: Uint8Array; requestId: number; tag: "seal-ok" }
  | {
      digest: string;
      id: string;
      plaintext: Uint8Array;
      requestId: number;
      schemaVersion: string;
      tag: "open-ok";
    };

export type NotebookBackupHostOptions = {
  randomSource?: RandomSource;
  timeoutMs?: number;
  workerFactory?: () => ProductBackupWorker;
};

export class NotebookBackupHost {
  readonly #randomSource: RandomSource;
  readonly #timeoutMs: number;
  readonly #workerFactory: () => ProductBackupWorker;

  constructor(options: NotebookBackupHostOptions = {}) {
    this.#randomSource = options.randomSource ?? globalThis.crypto;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 300_000
    ) {
      throw new NotebookBackupRefusal("internal-failure");
    }
  }

  async createBackup(plaintext: Uint8Array): Promise<CreatedBackup> {
    assertOwnedBytes(plaintext, 1, MAX_PLAINTEXT_BYTES);
    const ownedViews: Uint8Array[] = [plaintext];
    try {
      const recoverySecret = freshBytes(16, this.#randomSource);
      ownedViews.push(recoverySecret);
      const salt = freshBytes(16, this.#randomSource);
      ownedViews.push(salt);
      const nonce = freshBytes(12, this.#randomSource);
      ownedViews.push(nonce);
      const recoveryCode = encodeRecoveryCode(recoverySecret);
      const request: SealBackupRequest = {
        cipher: "aes-256-gcm",
        id: freshBackupId(this.#randomSource),
        kdf: {
          algorithm: "argon2id",
          iterations: 3,
          memoryKib: 65_536,
          outputLengthBytes: 32,
          parallelism: 1,
          salt,
          version: 19,
        },
        nonce,
        plaintext,
        schemaVersion: "libre-ai.notebook-backup-seal-request.v2",
      };
      const response = await this.#run(
        { operation: "seal", recoverySecret, request, requestId: takeRequestId() },
        ownedViews,
      );
      if (response.tag !== "seal-ok") throw new NotebookBackupRefusal("internal-failure");
      return { envelope: response.envelope, recoveryCode };
    } catch (error) {
      throw closedBackupRefusal(error);
    } finally {
      wipeViews(ownedViews);
    }
  }

  async openBackupForUse<Result>(
    envelope: Uint8Array,
    recoveryCode: string,
    consume: (opened: OpenedBackup) => Result | Promise<Result>,
  ): Promise<{ metadata: RestoredBackupMetadata; result: Result }> {
    assertOwnedBytes(envelope, 1, MAX_ENVELOPE_BYTES);
    const recoverySecret = decodeRecoveryAttempt(recoveryCode);
    const ownedViews = [envelope, recoverySecret];
    let plaintext: Uint8Array | undefined;
    try {
      const response = await this.#run(
        { envelope, operation: "open", recoverySecret, requestId: takeRequestId() },
        ownedViews,
      );
      if (response.tag !== "open-ok") throw new NotebookBackupRefusal("internal-failure");
      plaintext = response.plaintext;
      const opened: OpenedBackup = {
        digest: response.digest,
        id: response.id,
        plaintext,
        schemaVersion: response.schemaVersion,
      };
      const result = await consume(opened);
      return {
        metadata: {
          digest: opened.digest,
          id: opened.id,
          schemaVersion: opened.schemaVersion,
        },
        result,
      };
    } catch (error) {
      throw closedBackupRefusal(error);
    } finally {
      plaintext?.fill(0);
      wipeViews(ownedViews);
    }
  }

  #run(request: WorkerRequest, ownedViews: Uint8Array[]): Promise<WorkerResponse> {
    let worker: ProductBackupWorker;
    try {
      worker = this.#workerFactory();
    } catch (error) {
      wipeViews(ownedViews);
      return Promise.reject(closedBackupRefusal(error));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: WorkerResponse | NotebookBackupRefusal): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        try {
          worker.terminate();
        } catch {
          // Logical termination was attempted; no private error crosses this boundary.
        }
        if (result instanceof NotebookBackupRefusal) reject(result);
        else resolve(result);
      };
      const timeout = setTimeout(
        () => finish(new NotebookBackupRefusal("resource-limit-exceeded")),
        this.#timeoutMs,
      );

      worker.onmessage = (event) => {
        try {
          const response = decodeWorkerResponse(event.data, request.requestId);
          finish(response.tag === "err" ? new NotebookBackupRefusal(response.code) : response);
        } catch (error) {
          finish(closedBackupRefusal(error));
        }
      };
      worker.onerror = (event) => {
        try {
          event.preventDefault();
        } catch {
          // The error is closed below even if the browser event is hostile.
        }
        finish(new NotebookBackupRefusal("internal-failure"));
      };
      worker.onmessageerror = () => finish(new NotebookBackupRefusal("internal-failure"));

      try {
        worker.postMessage(request, transferableBuffers(ownedViews));
      } catch (error) {
        finish(closedBackupRefusal(error));
      } finally {
        wipeViews(ownedViews);
      }
    });
  }
}

function defaultWorkerFactory(): ProductBackupWorker {
  return new Worker("/assets/notebook-core-worker.js", {
    name: "notebook-core-v2-product-operation",
    type: "module",
  }) as ProductBackupWorker;
}

function decodeWorkerResponse(value: unknown, requestId: number): WorkerResponse {
  if (typeof value !== "object" || value === null) {
    throw new NotebookBackupRefusal("internal-failure");
  }
  const record = value as Record<string, unknown>;
  try {
    if (Reflect.get(record, "requestId") !== requestId) {
      throw new NotebookBackupRefusal("internal-failure");
    }
    const tag = Reflect.get(record, "tag");
    if (tag === "err") {
      const code = Reflect.get(record, "code");
      if (
        Object.keys(record).length !== 3 ||
        typeof code !== "string" ||
        !ERROR_CODES.has(code as NotebookCoreErrorCode)
      ) {
        throw new NotebookBackupRefusal("internal-failure");
      }
      return { code: code as NotebookCoreErrorCode, requestId, tag };
    }
    if (tag === "seal-ok") {
      const envelope = Reflect.get(record, "envelope");
      if (Object.keys(record).length !== 3 || !(envelope instanceof Uint8Array)) {
        throw new NotebookBackupRefusal("internal-failure");
      }
      assertOwnedBytes(envelope, 1, MAX_ENVELOPE_BYTES);
      return { envelope, requestId, tag };
    }
    if (tag === "open-ok") {
      const plaintext = Reflect.get(record, "plaintext");
      const id = Reflect.get(record, "id");
      const digest = Reflect.get(record, "digest");
      const schemaVersion = Reflect.get(record, "schemaVersion");
      if (
        Object.keys(record).length !== 6 ||
        !(plaintext instanceof Uint8Array) ||
        typeof id !== "string" ||
        !BACKUP_ID.test(id) ||
        typeof digest !== "string" ||
        !DIGEST.test(digest) ||
        schemaVersion !== "libre-ai.notebook-backup.v2"
      ) {
        throw new NotebookBackupRefusal("internal-failure");
      }
      assertOwnedBytes(plaintext, 1, MAX_PLAINTEXT_BYTES);
      return { digest, id, plaintext, requestId, schemaVersion, tag };
    }
    throw new NotebookBackupRefusal("internal-failure");
  } catch (error) {
    wipeReflectedResponse(record);
    throw error;
  }
}

function wipeReflectedResponse(record: Record<string, unknown>): void {
  for (const key of ["plaintext", "envelope"] as const) {
    try {
      const value = Reflect.get(record, key);
      if (value instanceof Uint8Array) value.fill(0);
    } catch {
      // Hostile accessors or detached buffers remain a closed failure.
    }
  }
}

function assertOwnedBytes(value: Uint8Array, minimum: number, maximum: number): void {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteOffset !== 0 ||
    value.byteLength !== value.buffer.byteLength ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    try {
      value.fill(0);
    } catch {
      // Invalid or detached input remains a closed refusal.
    }
    throw new NotebookBackupRefusal("resource-limit-exceeded");
  }
}

function transferableBuffers(views: Uint8Array[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const view of views) {
    assertOwnedBytes(view, 1, MAX_ENVELOPE_BYTES);
    buffers.add(view.buffer as ArrayBuffer);
  }
  return [...buffers];
}

function wipeViews(views: Uint8Array[]): void {
  for (const view of views) {
    try {
      view.fill(0);
    } catch {
      // Successful transfer detaches the buffer and moves ownership to the worker.
    }
  }
}

function takeRequestId(): number {
  const requestId = nextRequestId;
  nextRequestId = nextRequestId === Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  return requestId;
}
