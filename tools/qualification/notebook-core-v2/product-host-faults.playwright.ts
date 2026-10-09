import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type BrowserContext,
  type BrowserType,
  chromium,
  expect,
  firefox,
  type Page,
  type TestInfo,
  test,
  type Worker,
  webkit,
} from "@playwright/test";

const PRODUCT_ORIGIN = "http://127.0.0.1:4174";
const QUALIFIED_CORE_SHA256 = "be423962e3a889e792a69a1ab60b978bcbf5ae1102db74a68c70a9a1c65e5942";
const PUBLIC_PLAINTEXT =
  '{"blocks":[],"schemaVersion":"libre-ai.notebook-product-host-fixture.v1"}';
const BROWSER_TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };
const CONTEXT_EXTERNAL_REQUESTS = new WeakMap<BrowserContext, string[]>();
const PAGE_DIAGNOSTICS = new WeakMap<Page, { consoleMessages: string[]; pageErrors: string[] }>();

test("recovers after forced process kill and crash without partial artifacts or worker reuse", async ({
  browserName,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), `notebook-process-kill-${browserName}-`));
  const profile = join(root, "profile");
  const downloads = join(root, "downloads");
  const backupPath = join(root, "complete-notebook-backup.lai");
  let context: BrowserContext | undefined;
  try {
    const productBuild = await assertProductBuild();
    context = await launchPersistent(browserName, profile, downloads);
    let page = await productPage(context);
    const sealDownloads: unknown[] = [];
    page.on("download", (download) => sealDownloads.push(download));

    const sealWorker = page.waitForEvent("worker");
    await page.getByRole("button", { name: "Créer une sauvegarde d’essai" }).click();
    await sealWorker;
    assertCleanRuntime(context, page);
    const sealTermination = await forceKill(context);
    context = undefined;

    expect(sealDownloads).toEqual([]);
    expect(await filesBelow(downloads)).toEqual([]);

    context = await launchPersistent(browserName, profile, downloads);
    page = await productPage(context);
    expect(await inspectBackupStore(page)).toEqual({ records: [], serialized: "[]" });
    expect(page.workers()).toEqual([]);

    const completeDownload = page.waitForEvent("download");
    const createWorker = page.waitForEvent("worker");
    await page.getByRole("button", { name: "Créer une sauvegarde d’essai" }).click();
    const [download, createdWorker] = await Promise.all([completeDownload, createWorker]);
    await expect(page.getByTestId("backup-status")).toHaveText(
      "Sauvegarde chiffrée téléchargée sous un nom neutre.",
    );
    await download.saveAs(backupPath);
    const recoveryCode = (await page.getByTestId("recovery-code").textContent()) ?? "";
    expect(recoveryCode).toMatch(/^[a-f0-9]{32}$/);
    await expectWorkersGone(page);

    const crashedRestoreDownloads: unknown[] = [];
    page.on("download", (downloadEvent) => crashedRestoreDownloads.push(downloadEvent));
    await page.locator("#backup-file").setInputFiles(backupPath);
    await page.locator("#recovery-code").fill(recoveryCode);
    const restoreWorker = page.waitForEvent("worker");
    await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
    const killedRestoreWorker = await restoreWorker;
    expect(killedRestoreWorker).not.toBe(createdWorker);
    const beforeKill = await inspectBackupStore(page);
    expect(beforeKill.records.map((record) => record.kind).sort()).toEqual([
      "encrypted-backup",
      "pending-restore",
    ]);
    expect(beforeKill.records.some((record) => record.key === "restore-receipt:latest")).toBe(
      false,
    );
    assertCleanRuntime(context, page);
    const restoreTermination = await forceCrash(context);
    context = undefined;
    expect(crashedRestoreDownloads).toEqual([]);

    context = await launchPersistent(browserName, profile, downloads);
    page = await productPage(
      context,
      "Une restauration interrompue a été nettoyée sans libérer de plaintext.",
    );
    const recovered = await inspectBackupStore(page);
    expect(recovered.records).toEqual([
      { key: "encrypted-backup:latest", kind: "encrypted-backup" },
    ]);
    expect(recovered.serialized).not.toContain(PUBLIC_PLAINTEXT);
    expect(recovered.serialized).not.toContain(recoveryCode);

    const restartedWorkers: Worker[] = [];
    const restoreDownloads: unknown[] = [];
    page.on("worker", (worker) => restartedWorkers.push(worker));
    page.on("download", (downloadEvent) => restoreDownloads.push(downloadEvent));
    await page.locator("#backup-file").setInputFiles(backupPath);
    await page.locator("#recovery-code").fill("00".repeat(16));
    await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
    await expect(page.getByTestId("backup-status")).toHaveText("Backup authentication failed.");
    await expectWorkersGone(page);

    await page.locator("#recovery-code").fill(recoveryCode);
    await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
    await expect(page.getByTestId("backup-status")).toHaveText(
      "Sauvegarde authentifiée et reçu de restauration validé.",
    );
    await expectWorkersGone(page);

    expect(restartedWorkers).toHaveLength(2);
    expect(restartedWorkers[0]).not.toBe(restartedWorkers[1]);
    expect(restoreDownloads).toEqual([]);
    const completed = await inspectBackupStore(page);
    expect(completed.records.map((record) => record.kind).sort()).toEqual([
      "encrypted-backup",
      "restore-receipt",
    ]);
    expect(completed.records.some((record) => record.key.startsWith("pending:"))).toBe(false);
    expect(completed.serialized).not.toContain(PUBLIC_PLAINTEXT);
    expect(completed.serialized).not.toContain(recoveryCode);
    assertCleanRuntime(context, page);
    await attachEvidence(testInfo, {
      browserName,
      browserVersion: context.browser()?.version() ?? "unknown",
      processFaults: [
        { operation: "seal", ...sealTermination },
        { operation: "restore", ...restoreTermination },
      ],
      productBuild,
      scenario: "seal-and-staged-restore-process-kill",
      verdict: "pass",
    });
  } finally {
    await context?.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed before and during an injected quota exhaustion, then recovers", async ({
  browserName,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), `notebook-quota-${browserName}-`));
  const profile = join(root, "profile");
  const downloads = join(root, "downloads");
  let context: BrowserContext | undefined;
  try {
    const productBuild = await assertProductBuild();
    context = await launchPersistent(browserName, profile, downloads, lowQuotaPreflight);
    let page = await productPage(context, "Backup operation unavailable.", false);
    await expect(page.getByRole("button", { name: "Créer une sauvegarde d’essai" })).toBeDisabled();
    expect(page.workers()).toEqual([]);
    expect(await filesBelow(downloads)).toEqual([]);
    assertCleanRuntime(context, page);
    await context.close();
    context = undefined;

    context = await launchPersistent(browserName, profile, downloads, abortEncryptedBackupPut);
    page = await productPage(context);
    const quotaDownloads: unknown[] = [];
    page.on("download", (download) => quotaDownloads.push(download));
    await page.getByRole("button", { name: "Créer une sauvegarde d’essai" }).click();
    await expect(page.getByTestId("backup-status")).toHaveText("Backup operation unavailable.");
    await expectWorkersGone(page);
    expect(quotaDownloads).toEqual([]);
    expect(await filesBelow(downloads)).toEqual([]);
    expect(await inspectBackupStore(page)).toEqual({ records: [], serialized: "[]" });
    assertCleanRuntime(context, page);
    await context.close();
    context = undefined;

    context = await launchPersistent(browserName, profile, downloads);
    page = await productPage(context);
    const successfulWorker = page.waitForEvent("worker");
    const successfulDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Créer une sauvegarde d’essai" }).click();
    await Promise.all([successfulWorker, successfulDownload]);
    await expect(page.getByTestId("backup-status")).toHaveText(
      "Sauvegarde chiffrée téléchargée sous un nom neutre.",
    );
    await expectWorkersGone(page);
    const recovered = await inspectBackupStore(page);
    expect(recovered.records).toEqual([
      { key: "encrypted-backup:latest", kind: "encrypted-backup" },
    ]);
    expect(recovered.serialized).not.toContain(PUBLIC_PLAINTEXT);
    assertCleanRuntime(context, page);
    await attachEvidence(testInfo, {
      browserName,
      browserVersion: context.browser()?.version() ?? "unknown",
      productBuild,
      quotaFaults: ["below-floor-estimate", "injected-transaction-abort"],
      scenario: "quota-refusal-and-clean-restart",
      verdict: "pass",
    });
  } finally {
    await context?.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

type ProductBuildEvidence = {
  backupFeature: string;
  commit: string;
  coreSha256: string;
  workerSha256: string;
};

async function assertProductBuild(): Promise<ProductBuildEvidence> {
  const manifest = JSON.parse(
    await readFile(resolve("apps/notebook/dist/notebook-build-manifest.json"), "utf8"),
  ) as {
    backupFeature?: string;
    commit?: string;
    shippingFiles?: Record<string, { sha256?: string }>;
  };
  expect(manifest.backupFeature).toBe("gate-b");
  expect(manifest.shippingFiles?.["assets/notebook-core.core.wasm"]?.sha256).toBe(
    QUALIFIED_CORE_SHA256,
  );
  expect(
    Object.keys(manifest.shippingFiles ?? {}).some((path) => /fault|internal|trap/i.test(path)),
  ).toBe(false);
  expect(manifest.commit).toMatch(/^[a-f0-9]{40}$/);
  return {
    backupFeature: manifest.backupFeature ?? "invalid",
    commit: manifest.commit ?? "invalid",
    coreSha256: manifest.shippingFiles?.["assets/notebook-core.core.wasm"]?.sha256 ?? "invalid",
    workerSha256: manifest.shippingFiles?.["assets/notebook-core-worker.js"]?.sha256 ?? "invalid",
  };
}

async function attachEvidence(
  testInfo: TestInfo,
  evidence: Record<string, unknown>,
): Promise<void> {
  const body = `${JSON.stringify(
    {
      ...evidence,
      schemaVersion: "libre-ai.notebook-product-host-fault-evidence.v1",
    },
    null,
    2,
  )}\n`;
  const scenario = String(evidence.scenario);
  if (!/^[a-z-]+$/.test(scenario)) throw new Error("invalid evidence scenario");
  const evidenceDirectory = join(testInfo.project.outputDir, "evidence");
  const evidencePath = join(evidenceDirectory, `${testInfo.project.name}-${scenario}.json`);
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidencePath, body, { encoding: "utf8", flag: "wx" });
  await testInfo.attach("product-host-fault-evidence", {
    contentType: "application/json",
    path: evidencePath,
  });
}

async function launchPersistent(
  browserName: string,
  profile: string,
  downloadsPath: string,
  initScript?: () => void,
): Promise<BrowserContext> {
  const browserType = BROWSER_TYPES[browserName];
  if (!browserType) throw new Error("unsupported qualification browser");
  const context = await browserType.launchPersistentContext(profile, {
    acceptDownloads: true,
    downloadsPath,
    headless: true,
  });
  if (initScript) await context.addInitScript(initScript);
  const externalRequests: string[] = [];
  CONTEXT_EXTERNAL_REQUESTS.set(context, externalRequests);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === PRODUCT_ORIGIN) await route.continue();
    else {
      externalRequests.push(url.origin);
      await route.abort("blockedbyclient");
    }
  });
  return context;
}

async function productPage(
  context: BrowserContext,
  expectedStatus = "Le host est prêt pour les fixtures publiques Gate B.",
  expectReady = true,
): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  PAGE_DIAGNOSTICS.set(page, { consoleMessages, pageErrors });
  page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const response = await page.goto(PRODUCT_ORIGIN);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("backup-status")).toHaveText(expectedStatus);
  if (expectReady) {
    await expect(page.getByRole("button", { name: "Créer une sauvegarde d’essai" })).toBeEnabled();
  }
  expect(consoleMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
  return page;
}

function assertCleanRuntime(context: BrowserContext, page: Page): void {
  expect(CONTEXT_EXTERNAL_REQUESTS.get(context) ?? []).toEqual([]);
  expect(PAGE_DIAGNOSTICS.get(page) ?? { consoleMessages: [], pageErrors: [] }).toEqual({
    consoleMessages: [],
    pageErrors: [],
  });
}

type ProcessTermination = {
  exitCode: number | null;
  signalCode: NodeJS.Signals;
};

async function forceKill(context: BrowserContext): Promise<ProcessTermination> {
  const child = internalBrowserProcess(context);
  const browser = context.browser() as unknown as {
    _channel?: { killForTests?: () => Promise<void> };
  } | null;
  const kill = browser?._channel?.killForTests;
  if (typeof kill !== "function") {
    throw new Error("pinned Playwright process-kill channel unavailable");
  }
  await kill.call(browser?._channel);
  expect(child.signalCode).toBe("SIGKILL");
  return { exitCode: child.exitCode, signalCode: "SIGKILL" };
}

async function forceCrash(context: BrowserContext): Promise<ProcessTermination> {
  const child = internalBrowserProcess(context);
  const pid = child.pid;
  if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || (pid ?? 0) < 2) {
    throw new Error("pinned Playwright browser process unavailable for crash injection");
  }
  const closed = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>(
    (resolveClosed) => {
      child.once("close", (exitCode, signalCode) => resolveClosed({ exitCode, signalCode }));
    },
  );
  process.kill(-(pid as number), "SIGABRT");
  const termination = await closed;
  expect(termination.signalCode).toBe("SIGABRT");
  return { exitCode: termination.exitCode, signalCode: "SIGABRT" };
}

function internalBrowserProcess(context: BrowserContext): ChildProcess {
  const browser = context.browser() as unknown as {
    _connection?: {
      toImpl?: (value: unknown) => {
        options?: { browserProcess?: { process?: ChildProcess } };
      };
    };
  } | null;
  const child = browser?._connection?.toImpl?.(browser)?.options?.browserProcess?.process;
  if (!child) throw new Error("pinned Playwright internal browser process unavailable");
  return child;
}

async function expectWorkersGone(page: Page): Promise<void> {
  await expect.poll(() => page.workers().length, { timeout: 5_000 }).toBe(0);
}

async function inspectBackupStore(page: Page): Promise<{
  records: Array<{ key: string; kind: string }>;
  serialized: string;
}> {
  return page.evaluate(async () => {
    const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const open = indexedDB.open("libre-ai-notebook", 1);
      open.onerror = () => reject(new Error("database unavailable"));
      open.onsuccess = () => {
        const database = open.result;
        if (!database.objectStoreNames.contains("backup-runtime")) {
          database.close();
          resolve([]);
          return;
        }
        const transaction = database.transaction("backup-runtime", "readonly");
        const request = transaction.objectStore("backup-runtime").getAll();
        request.onerror = () => reject(new Error("records unavailable"));
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        transaction.oncomplete = () => database.close();
      };
    });
    return {
      records: records
        .map((record) => ({ key: String(record.key), kind: String(record.kind) }))
        .sort((left, right) => left.key.localeCompare(right.key)),
      serialized: JSON.stringify(records),
    };
  });
}

async function filesBelow(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { recursive: true })).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function lowQuotaPreflight(): void {
  Object.defineProperty(StorageManager.prototype, "estimate", {
    configurable: true,
    value: async () => ({ quota: 536_870_911, usage: 0 }),
  });
}

function abortEncryptedBackupPut(): void {
  const originalPut = IDBObjectStore.prototype.put;
  Object.defineProperty(IDBObjectStore.prototype, "put", {
    configurable: true,
    value(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request =
        key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      if (
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value as Record<string, unknown>, "kind") === "encrypted-backup"
      ) {
        this.transaction.abort();
      }
      return request;
    },
  });
}
