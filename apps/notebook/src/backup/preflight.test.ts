import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verifyNotebookBackupRuntime } from "./preflight";
import { NotebookBackupRefusal } from "./types";

const keys = ["navigator", "isSecureContext", "Worker", "indexedDB"] as const;
let originals: Array<PropertyDescriptor | undefined> = [];

beforeEach(() => {
  originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, {
    navigator: { configurable: true, value: { storage: { estimate: async () => ({ quota: 536_870_912, usage: 0 }) } } },
    isSecureContext: { configurable: true, value: true },
    Worker: { configurable: true, value: class SyntheticWorker {} },
    indexedDB: { configurable: true, value: {} },
  });
});
afterEach(() => {
  for (const [index, key] of keys.entries()) {
    const descriptor = originals[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function expectUnavailable(): Promise<void> {
  const failure = await verifyNotebookBackupRuntime().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NotebookBackupRefusal);
  expect((failure as NotebookBackupRefusal).code).toBe("resource-limit-exceeded");
}

describe("Notebook browser capability preflight", () => {
  test("refuses an absent quota-estimate capability explicitly", async () => {
    Object.defineProperty(navigator, "storage", { value: {}, configurable: true });
    await expectUnavailable();
  });
  test("refuses an absent storage manager explicitly", async () => {
    Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
    await expectUnavailable();
  });
  test("accepts the unchanged quota floor and real transferable buffer semantics", async () => {
    await expect(verifyNotebookBackupRuntime()).resolves.toBeUndefined();
  });
  test("refuses one byte below the unchanged quota floor", async () => {
    Object.defineProperty(navigator, "storage", { value: { estimate: async () => ({ quota: 536_870_912, usage: 1 }) }, configurable: true });
    await expectUnavailable();
  });
});
