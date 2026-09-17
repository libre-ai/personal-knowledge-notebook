import { closedBackupRefusal } from "./material";
import type { NotebookCoreApi, SealBackupRequest } from "./types";

const MAX_ENVELOPE_BYTES = 22_370_044;
const MAX_PLAINTEXT_BYTES = 16_777_216;

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

type ComponentModule = {
  instantiate(
    loader: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, never>,
    instantiateCore: (module: WebAssembly.Module) => Promise<WebAssembly.Instance>,
  ): Promise<{ api: NotebookCoreApi }>;
};

type WorkerScope = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};

const scope = globalThis as unknown as WorkerScope;
let handled = false;

scope.onmessage = async (event) => {
  if (handled) throw new Error("product worker accepts exactly one operation");
  handled = true;
  let request: WorkerRequest | undefined;
  try {
    request = decodeRequest(event.data);
    const componentUrl = "/assets/notebook-core.js";
    const component = (await import(componentUrl)) as ComponentModule;
    const root = await component.instantiate(
      async (path) => {
        // check-no-transmission allowlist entry (ADR-0012 D1): `path` comes from the
        // generated WIT-bindgen component loader, not from user or network input, and
        // resolves via `import.meta.url` of this same-origin module to a co-located
        // static .wasm build artifact under /assets/. GET-only, same-origin, carries
        // no user data and no cross-origin target. Any change to this call site must
        // be re-reviewed against that guarantee before it can stay allowlisted.
        const response = await fetch(new URL(path, import.meta.url), { cache: "no-store" });
        if (!response.ok) throw new Error("core module unavailable");
        const module = await WebAssembly.compile(await response.arrayBuffer());
        if (WebAssembly.Module.imports(module).length !== 0) {
          throw new Error("core module imports capabilities");
        }
        return module;
      },
      {},
      async (module) => {
        const instance = await WebAssembly.instantiate(module, {});
        if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
          throw new Error("core memory unavailable");
        }
        return instance;
      },
    );
    execute(root.api, request);
  } catch (error) {
    if (!request) wipeUntrustedRequest(event.data);
    scope.postMessage({
      code: closedBackupRefusal(error).code,
      requestId: request?.requestId ?? 0,
      tag: "err",
    });
  } finally {
    if (request) wipeRequest(request);
  }
};

function execute(api: NotebookCoreApi, request: WorkerRequest): void {
  if (request.operation === "seal") {
    let envelope: Uint8Array | undefined;
    try {
      envelope = api.sealBackup(request.request, request.recoverySecret);
      assertOwnedBytes(envelope, 1, MAX_ENVELOPE_BYTES);
      scope.postMessage({ envelope, requestId: request.requestId, tag: "seal-ok" }, [
        envelope.buffer as ArrayBuffer,
      ]);
    } finally {
      wipeView(envelope);
    }
    return;
  }

  let plaintext: Uint8Array | undefined;
  try {
    const opened = api.openBackup(request.envelope, request.recoverySecret);
    plaintext = opened.plaintext;
    assertOwnedBytes(plaintext, 1, MAX_PLAINTEXT_BYTES);
    scope.postMessage(
      {
        digest: opened.digest,
        id: opened.id,
        plaintext,
        requestId: request.requestId,
        schemaVersion: opened.schemaVersion,
        tag: "open-ok",
      },
      [plaintext.buffer as ArrayBuffer],
    );
  } finally {
    wipeView(plaintext);
  }
}

function decodeRequest(value: unknown): WorkerRequest {
  if (typeof value !== "object" || value === null) throw new Error("invalid worker request");
  const record = value as Record<string, unknown>;
  const operation = Reflect.get(record, "operation");
  const requestId = Reflect.get(record, "requestId");
  const recoverySecret = Reflect.get(record, "recoverySecret");
  if (!Number.isSafeInteger(requestId) || !(recoverySecret instanceof Uint8Array)) {
    throw new Error("invalid worker request");
  }
  assertOwnedBytes(recoverySecret, 15, 17);

  if (operation === "open") {
    const envelope = Reflect.get(record, "envelope");
    if (Object.keys(record).length !== 4 || !(envelope instanceof Uint8Array)) {
      throw new Error("invalid worker request");
    }
    assertOwnedBytes(envelope, 1, MAX_ENVELOPE_BYTES);
    return { envelope, operation, recoverySecret, requestId: requestId as number };
  }

  if (operation === "seal") {
    const request = Reflect.get(record, "request");
    if (Object.keys(record).length !== 4 || !isSealRequest(request)) {
      throw new Error("invalid worker request");
    }
    return { operation, recoverySecret, request, requestId: requestId as number };
  }
  throw new Error("invalid worker request");
}

function isSealRequest(value: unknown): value is SealBackupRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  const kdf = Reflect.get(request, "kdf");
  if (typeof kdf !== "object" || kdf === null) return false;
  const parameters = kdf as Record<string, unknown>;
  const salt = Reflect.get(parameters, "salt");
  const nonce = Reflect.get(request, "nonce");
  const plaintext = Reflect.get(request, "plaintext");
  if (
    Object.keys(request).length !== 6 ||
    Object.keys(parameters).length !== 7 ||
    Reflect.get(request, "schemaVersion") !== "libre-ai.notebook-backup-seal-request.v2" ||
    Reflect.get(request, "cipher") !== "aes-256-gcm" ||
    typeof Reflect.get(request, "id") !== "string" ||
    Reflect.get(parameters, "algorithm") !== "argon2id" ||
    Reflect.get(parameters, "version") !== 19 ||
    Reflect.get(parameters, "memoryKib") !== 65_536 ||
    Reflect.get(parameters, "iterations") !== 3 ||
    Reflect.get(parameters, "parallelism") !== 1 ||
    Reflect.get(parameters, "outputLengthBytes") !== 32 ||
    !(salt instanceof Uint8Array) ||
    !(nonce instanceof Uint8Array) ||
    !(plaintext instanceof Uint8Array)
  ) {
    return false;
  }
  assertOwnedBytes(salt, 16, 16);
  assertOwnedBytes(nonce, 12, 12);
  assertOwnedBytes(plaintext, 1, MAX_PLAINTEXT_BYTES);
  return true;
}

function assertOwnedBytes(value: Uint8Array, minimum: number, maximum: number): void {
  if (
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteOffset !== 0 ||
    value.byteLength !== value.buffer.byteLength ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new Error("invalid owned bytes");
  }
}

function wipeUntrustedRequest(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of ["envelope", "recoverySecret"] as const) {
    try {
      const view = Reflect.get(record, key);
      if (view instanceof Uint8Array) wipeView(view);
    } catch {
      // Hostile accessors remain a closed worker failure.
    }
  }
  try {
    const request = Reflect.get(record, "request");
    if (typeof request !== "object" || request === null) return;
    const seal = request as Record<string, unknown>;
    for (const key of ["nonce", "plaintext"] as const) {
      const view = Reflect.get(seal, key);
      if (view instanceof Uint8Array) wipeView(view);
    }
    const kdf = Reflect.get(seal, "kdf");
    if (typeof kdf === "object" && kdf !== null) {
      const salt = Reflect.get(kdf, "salt");
      if (salt instanceof Uint8Array) wipeView(salt);
    }
  } catch {
    // The worker is terminated after its static refusal.
  }
}

function wipeRequest(request: WorkerRequest): void {
  const views =
    request.operation === "seal"
      ? [
          request.request.kdf.salt,
          request.request.nonce,
          request.request.plaintext,
          request.recoverySecret,
        ]
      : [request.envelope, request.recoverySecret];
  for (const view of views) wipeView(view);
}

function wipeView(view: Uint8Array | undefined): void {
  try {
    view?.fill(0);
  } catch {
    // A response transfer detaches the buffer and hands ownership back to the page.
  }
}
