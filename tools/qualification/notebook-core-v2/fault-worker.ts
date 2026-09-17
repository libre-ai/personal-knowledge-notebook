import type { NotebookCoreApi } from "./host";
import { canonicalizeOwned, closedRefusal, sealOwned } from "./host";
import type { IsolatedOperation, IsolatedResult, QualificationFault } from "./isolated-host";

const ABI_EXPORTS = {
  canonicalize: "libre-ai:notebook-core/api@2.0.0#canonicalize-context",
  "open-digest": "libre-ai:notebook-core/api@2.0.0#open-backup",
  seal: "libre-ai:notebook-core/api@2.0.0#seal-backup",
} as const;
const TRAP_MODULES = {
  canonicalize: "notebook-core.trap-canonicalize.core.wasm",
  "open-digest": "notebook-core.trap-open.core.wasm",
  seal: "notebook-core.trap-seal.core.wasm",
} as const;

type WorkerRequest = {
  fault: QualificationFault;
  operation: IsolatedOperation;
  requestId: number;
};

type ComponentModule = {
  instantiate(
    loader: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, never>,
    instantiateCore?: (module: WebAssembly.Module) => Promise<{ exports: WebAssembly.Exports }>,
  ): Promise<{ api: NotebookCoreApi }>;
};

type WorkerScope = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};

const workerScope = globalThis as unknown as WorkerScope;
let handled = false;

workerScope.onmessage = async (event) => {
  if (handled) throw new Error("qualification worker accepts exactly one operation");
  handled = true;
  const request = decodeRequest(event.data);
  try {
    const result = await execute(request.operation, request.fault);
    workerScope.postMessage({ requestId: request.requestId, tag: "ok", ...result });
  } catch (error) {
    workerScope.postMessage({
      code: closedRefusal(error).code,
      requestId: request.requestId,
      tag: "err",
    });
  } finally {
    wipeOperation(request.operation);
  }
};

async function execute(
  operation: IsolatedOperation,
  fault: QualificationFault,
): Promise<IsolatedResult> {
  const internalFault = fault.startsWith("internal-");
  const componentUrl = internalFault ? "./notebook-core-internal-fault.js" : "./notebook-core.js";
  const component = (await import(componentUrl)) as ComponentModule;
  const coreName = internalFault
    ? "notebook-core-internal-fault.core.wasm"
    : fault === "trap"
      ? TRAP_MODULES[operation.kind]
      : "notebook-core.core.wasm";
  const root = await component.instantiate(
    async () => {
      const response = await fetch(new URL(coreName, import.meta.url), { cache: "no-store" });
      if (!response.ok) throw new Error("qualification core module unavailable");
      const module = await WebAssembly.compile(await response.arrayBuffer());
      if (WebAssembly.Module.imports(module).length !== 0) {
        throw new Error("qualification core module has imports");
      }
      return module;
    },
    {},
    fault === "oom" || fault === "hang"
      ? (module) => instantiateWithFault(module, ABI_EXPORTS[operation.kind], fault)
      : undefined,
  );

  switch (operation.kind) {
    case "canonicalize": {
      const output = canonicalizeOwned(root.api, operation.document);
      try {
        return await summarize(output);
      } finally {
        output.fill(0);
      }
    }
    case "seal": {
      const output = sealOwned(root.api, operation.request, operation.recoverySecret);
      try {
        return await summarize(output);
      } finally {
        output.fill(0);
      }
    }
    case "open-digest": {
      let plaintext: Uint8Array | undefined;
      try {
        const opened = root.api.openBackup(operation.envelope, operation.recoverySecret);
        plaintext = opened.plaintext;
        return await summarize(plaintext);
      } finally {
        plaintext?.fill(0);
        operation.recoverySecret.fill(0);
        operation.envelope.fill(0);
      }
    }
  }
}

async function instantiateWithFault(
  module: WebAssembly.Module,
  targetExport: string,
  fault: "oom" | "hang",
): Promise<{ exports: WebAssembly.Exports }> {
  const instance = await WebAssembly.instantiate(module, {});
  const exports = Object.fromEntries(Object.entries(instance.exports)) as WebAssembly.Exports;
  if (typeof exports[targetExport] !== "function") {
    throw new Error("qualification target export unavailable");
  }
  exports[targetExport] = () => {
    if (fault === "hang") {
      for (;;) {
        // The owning host must recover exclusively by terminating this worker.
      }
    }
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new RangeError("qualification memory unavailable");
    }
    memory.grow(8_193);
    throw new RangeError("qualification memory limit was not enforced");
  };
  return { exports };
}

async function summarize(value: Uint8Array): Promise<IsolatedResult> {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
    return {
      outputLength: value.length,
      outputSha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  } finally {
    copy.fill(0);
  }
}

function decodeRequest(value: unknown): WorkerRequest {
  if (typeof value !== "object" || value === null) throw new Error("invalid worker request");
  const request = value as Partial<WorkerRequest>;
  if (
    !Number.isSafeInteger(request.requestId) ||
    ![
      "none",
      "oom",
      "trap",
      "hang",
      "internal-oom",
      "internal-panic",
      "internal-serde-oom",
      "internal-jcs-oom",
      "internal-argon2-oom",
    ].includes(request.fault ?? "") ||
    typeof request.operation !== "object" ||
    request.operation === null ||
    !["canonicalize", "seal", "open-digest"].includes(request.operation.kind)
  ) {
    throw new Error("invalid worker request");
  }
  return request as WorkerRequest;
}

function wipeOperation(operation: IsolatedOperation): void {
  const views: Uint8Array[] =
    operation.kind === "canonicalize"
      ? [operation.document]
      : operation.kind === "seal"
        ? [
            operation.request.kdf.salt,
            operation.request.nonce,
            operation.request.plaintext,
            operation.recoverySecret,
          ]
        : [operation.envelope, operation.recoverySecret];
  for (const view of views) view.fill(0);
}
