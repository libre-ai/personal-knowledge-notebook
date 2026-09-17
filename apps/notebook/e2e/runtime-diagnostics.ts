import type { Page } from "@playwright/test";

/** Public fixture capabilities only: never include exception messages or database contents. */
export async function inspectRuntimeCapabilities(page: Page) {
  return page.evaluate(async () => {
    const errorKind = (error: unknown): string =>
      error instanceof DOMException
        ? "dom-exception"
        : error instanceof TypeError
          ? "type-error"
          : "other-error";
    const result = {
      secureContext: isSecureContext,
      worker: typeof Worker,
      indexedDb: typeof indexedDB,
      random: typeof globalThis.crypto?.getRandomValues,
      storageEstimate: typeof navigator.storage?.estimate,
      transfer: "unobserved",
      quota: "unobserved",
      strictTransaction: "unobserved",
    };
    try {
      const source = new Uint8Array([0x5a]);
      const transferred = structuredClone(source, { transfer: [source.buffer] });
      result.transfer = source.byteLength === 0 && transferred.byteLength === 1 && transferred[0] === 0x5a
        ? "matched" : "mismatched";
    } catch (error) {
      result.transfer = errorKind(error);
    }
    try {
      const estimate = await navigator.storage.estimate();
      result.quota = typeof estimate.quota === "number" && typeof estimate.usage === "number"
        && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)
        ? (Math.max(0, estimate.quota - estimate.usage) >= 536_870_912 ? "sufficient" : "insufficient")
        : "invalid-shape";
    } catch (error) {
      result.quota = errorKind(error);
    }
    result.strictTransaction = await new Promise<string>((resolve) => {
      let database: IDBDatabase | undefined;
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        database?.close();
        resolve(value);
      };
      const timeout = setTimeout(() => finish("deadline"), 5_000);
      try {
        // This existing product store is inspected without writing or reading records.
        const open = indexedDB.open("libre-ai-notebook", 1);
        open.onupgradeneeded = () => { open.transaction?.abort(); finish("store-not-created"); };
        open.onerror = () => finish("open-error");
        open.onblocked = () => finish("blocked");
        open.onsuccess = () => {
          database = open.result;
          if (settled) { database.close(); return; }
          try {
            const transaction = database.transaction("backup-runtime", "readwrite", { durability: "strict" });
            transaction.oncomplete = () => finish("matched");
            transaction.onabort = () => finish("aborted");
            transaction.onerror = () => undefined;
          } catch (error) { finish(errorKind(error)); }
        };
      } catch (error) { finish(errorKind(error)); }
    });
    return result;
  });
}
