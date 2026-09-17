import { execFileSync } from "node:child_process";
import { mkdir, open, readdir, readFile, rm, statfs, unlink, writeFile } from "node:fs/promises";
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
  webkit,
} from "@playwright/test";
import { STORAGE_RUNTIME_ROOT } from "./product-host-storage.runtime";

const PRODUCT_ORIGIN = "http://127.0.0.1:4174";
const QUALIFIED_CORE_SHA256 = "be423962e3a889e792a69a1ab60b978bcbf5ae1102db74a68c70a9a1c65e5942";
const QUALIFIED_WORKER_SHA256 = "19054f4913ffc438159bb2345b17487dae82d75e3e0ba17212610f61c3cbeb9a";
const PUBLIC_PLAINTEXT =
  '{"blocks":[],"schemaVersion":"libre-ai.notebook-product-host-fixture.v1"}';
const DISK_IMAGE_BYTES = 6 * 1024 ** 3;
const HOST_FREE_SPACE_RESERVE_BYTES = 8 * 1024 ** 3;
const FILL_CHUNK_BYTES = 8 * 1024 ** 2;
const BROWSER_TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };
const CONTEXT_EXTERNAL_REQUESTS = new WeakMap<BrowserContext, string[]>();
const PAGE_DIAGNOSTICS = new WeakMap<Page, { consoleMessages: string[]; pageErrors: string[] }>();

test("fails closed on real APFS ENOSPC and recovers the same profile", async ({
  browserName,
}, testInfo) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("the APFS ENOSPC qualification requires a macOS arm64 host");
  }
  const root = join(STORAGE_RUNTIME_ROOT, browserName);
  await mkdir(root);
  const downloads = join(root, "downloads");
  const backupPath = join(root, "complete-notebook-backup.lai");
  const pressureEnvelopePath = join(root, "public-storage-pressure.lai");
  const hostSpace = await volumeSpace(root);
  if (hostSpace.availableBytes < DISK_IMAGE_BYTES + HOST_FREE_SPACE_RESERVE_BYTES) {
    await rm(root, { force: true, recursive: true });
    throw new Error("insufficient host free space for the bounded APFS ENOSPC scenario");
  }
  const volume = await createBoundedApfsVolume(root);
  const profile = join(volume.mountPoint, "profile");
  let context: BrowserContext | undefined;
  try {
    const productBuild = await assertProductBuild();
    await mkdir(downloads, { recursive: true });
    const pressureEnvelope = Buffer.alloc(16 * 1024 ** 2, 0x5a);
    try {
      await writeFile(pressureEnvelopePath, pressureEnvelope, { flag: "wx" });
    } finally {
      pressureEnvelope.fill(0);
    }
    context = await launchPersistent(browserName, profile, downloads);
    let page = await productPage(context);

    const baselineDownload = page.waitForEvent("download");
    const baselineWorker = page.waitForEvent("worker");
    await page.getByRole("button", { name: "Créer une sauvegarde d’essai" }).click();
    const [download] = await Promise.all([baselineDownload, baselineWorker]);
    await expect(page.getByTestId("backup-status")).toHaveText(
      "Sauvegarde chiffrée téléchargée sous un nom neutre.",
    );
    const recoveryCode = (await page.getByTestId("recovery-code").textContent()) ?? "";
    expect(recoveryCode).toMatch(/^[a-f0-9]{32}$/);
    await download.saveAs(backupPath);
    await download.delete();
    await expectWorkersGone(page);
    const baseline = await inspectBackupStore(page);
    expect(baseline.records).toEqual([
      { key: "encrypted-backup:latest", kind: "encrypted-backup" },
    ]);
    expect(baseline.serialized).not.toContain(PUBLIC_PLAINTEXT);
    const before = await volumeSpace(volume.mountPoint);
    const browserEstimate = await page.evaluate(() => navigator.storage.estimate());
    expect(before.availableBytes).toBeGreaterThanOrEqual(536_870_912);
    expect(browserEstimate.quota).toBeGreaterThanOrEqual(536_870_912);

    const exhausted = await fillUntilEnospc(volume.mountPoint, volume.fillerPath);
    expect(exhausted.marker.code).toBe("ENOSPC");

    await page.locator("#backup-file").setInputFiles(pressureEnvelopePath);
    await page.locator("#recovery-code").fill("00".repeat(16));
    const unexpectedWorker = page
      .waitForEvent("worker", { timeout: 15_000 })
      .catch(() => undefined);
    await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
    await expect(page.getByTestId("backup-status")).toHaveText("Backup operation unavailable.");
    await expect(page.locator("#recovery-code")).toHaveValue("");
    expect(await unexpectedWorker).toBeUndefined();
    await expectWorkersGone(page);
    expect(await filesBelow(downloads)).toEqual([]);
    const liveInspection = await inspectBackupStore(page).then(
      (state) => ({ available: true as const, state }),
      () => ({ available: false as const }),
    );
    if (liveInspection.available) expect(liveInspection.state).toEqual(baseline);
    assertCleanRuntime(context, page);

    await context.close();
    context = undefined;
    await unlink(volume.fillerPath);
    const recoveredSpace = await volumeSpace(volume.mountPoint);
    expect(recoveredSpace.availableBytes).toBeGreaterThanOrEqual(536_870_912);

    context = await launchPersistent(browserName, profile, downloads);
    page = await productPage(context);
    expect(await inspectBackupStore(page)).toEqual(baseline);
    await page.locator("#backup-file").setInputFiles(backupPath);
    await page.locator("#recovery-code").fill(recoveryCode);
    const successfulRestoreWorker = page.waitForEvent("worker");
    await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
    await successfulRestoreWorker;
    await expect(page.getByTestId("backup-status")).toHaveText(
      "Sauvegarde authentifiée et reçu de restauration validé.",
    );
    await expectWorkersGone(page);

    const successfulDownload = page.waitForEvent("download");
    const successfulWorker = page.waitForEvent("worker");
    await page.getByRole("button", { name: "Créer une sauvegarde d’essai" }).click();
    await Promise.all([successfulDownload, successfulWorker]);
    await expect(page.getByTestId("backup-status")).toHaveText(
      "Sauvegarde chiffrée téléchargée sous un nom neutre.",
    );
    await expect(page.getByTestId("recovery-code")).toHaveText(/^[a-f0-9]{32}$/);
    await expectWorkersGone(page);
    const final = await inspectBackupStore(page);
    expect(final.records).toEqual([
      { key: "encrypted-backup:latest", kind: "encrypted-backup" },
      { key: "restore-receipt:latest", kind: "restore-receipt" },
    ]);
    expect(final.serialized).not.toContain(PUBLIC_PLAINTEXT);
    assertCleanRuntime(context, page);

    await attachEvidence(testInfo, {
      browserName,
      browserVersion: context.browser()?.version() ?? "unknown",
      productBuild,
      profileRestarted: true,
      scenario: "apfs-enospc-and-clean-restart",
      storageBoundary: {
        capacityBytes: before.capacityBytes,
        browserEstimateBeforeExhaustion: browserEstimate,
        enospcMarker: exhausted.marker,
        exhaustedAvailableBytes: exhausted.availableBytes,
        filesystem: volume.filesystem,
        pressureEnvelopeBytes: 16 * 1024 ** 2,
        liveInspectionAvailableDuringEnospc: liveInspection.available,
        pressureEnvelopeClass: "public-deterministic-invalid-envelope",
        recoveredAvailableBytes: recoveredSpace.availableBytes,
        storageOperation: "restore-staging-before-worker",
        testVolume: "disposable-sparse-image",
      },
      verdict: "pass",
    });
  } finally {
    await context?.close().catch(() => undefined);
    await unlink(volume.fillerPath).catch(() => undefined);
    await volume.detach();
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
  expect(manifest.shippingFiles?.["assets/notebook-core-worker.js"]?.sha256).toBe(
    QUALIFIED_WORKER_SHA256,
  );
  expect(
    Object.keys(manifest.shippingFiles ?? {}).some((path) => /fault|internal|trap/i.test(path)),
  ).toBe(false);
  const sourceCommit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  expect(manifest.commit).toBe(sourceCommit);
  return {
    backupFeature: manifest.backupFeature ?? "invalid",
    commit: manifest.commit ?? "invalid",
    coreSha256: manifest.shippingFiles?.["assets/notebook-core.core.wasm"]?.sha256 ?? "invalid",
    workerSha256: manifest.shippingFiles?.["assets/notebook-core-worker.js"]?.sha256 ?? "invalid",
  };
}

type BoundedVolume = {
  detach(): Promise<void>;
  fillerPath: string;
  filesystem: "apfs";
  mountPoint: string;
};

async function createBoundedApfsVolume(root: string): Promise<BoundedVolume> {
  const imagePath = join(root, "profile.sparseimage");
  const mountPoint = join(root, "mount");
  let attached = false;
  try {
    await mkdir(mountPoint);
    execFileSync("/usr/bin/hdiutil", [
      "create",
      "-quiet",
      "-size",
      String(DISK_IMAGE_BYTES),
      "-type",
      "SPARSE",
      "-fs",
      "APFS",
      "-volname",
      "LAI_NOTEBOOK_QUOTA",
      imagePath,
    ]);
    execFileSync("/usr/bin/hdiutil", [
      "attach",
      "-quiet",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
      imagePath,
    ]);
    attached = true;
    const filesystem = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "FilesystemType", "raw", "-o", "-", "-"],
      {
        encoding: "utf8",
        input: execFileSync("/usr/sbin/diskutil", ["info", "-plist", mountPoint]),
      },
    ).trim();
    if (filesystem !== "apfs") throw new Error("qualification volume is not APFS");
  } catch (error) {
    let detached = !attached;
    if (attached) {
      try {
        execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mountPoint]);
        detached = true;
      } catch {
        // Global teardown retains the root and retries the bounded detach.
      }
    }
    if (detached) await rm(root, { force: true, recursive: true });
    throw error;
  }
  return {
    async detach() {
      try {
        execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", mountPoint]);
      } catch {
        execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mountPoint]);
      }
    },
    fillerPath: join(mountPoint, "qualification-filler.bin"),
    filesystem: "apfs",
    mountPoint,
  };
}

type EnospcMarker = {
  code: "ENOSPC";
  errno: number | undefined;
  syscall: string | undefined;
};

async function fillUntilEnospc(
  mountPoint: string,
  fillerPath: string,
): Promise<{ availableBytes: number; marker: EnospcMarker }> {
  const chunk = Buffer.alloc(FILL_CHUNK_BYTES, 0xa5);
  const file = await open(fillerPath, "wx");
  try {
    for (const writeBytes of [FILL_CHUNK_BYTES, 1024 ** 2, 64 * 1024, 4 * 1024]) {
      for (;;) {
        try {
          await file.write(chunk.subarray(0, writeBytes));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
          break;
        }
      }
    }
    await file.sync().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOSPC") throw error;
    });
  } finally {
    chunk.fill(0);
    await file.close();
  }
  const marker = await requireEnospcProbe(mountPoint);
  const space = await volumeSpace(mountPoint);
  return { availableBytes: space.availableBytes, marker };
}

async function requireEnospcProbe(mountPoint: string): Promise<EnospcMarker> {
  const probePath = join(mountPoint, "qualification-enospc-probe.bin");
  let probe: Awaited<ReturnType<typeof open>> | undefined;
  try {
    probe = await open(probePath, "wx");
    await probe.write(Buffer.alloc(4 * 1024, 0xa5));
    await probe.sync();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== "ENOSPC") throw error;
    return { code: "ENOSPC", errno: failure.errno, syscall: failure.syscall };
  } finally {
    await probe?.close().catch(() => undefined);
    await unlink(probePath).catch(() => undefined);
  }
  throw new Error("APFS accepted the ENOSPC verification write");
}

async function volumeSpace(
  path: string,
): Promise<{ availableBytes: number; capacityBytes: number }> {
  const value = await statfs(path, { bigint: true });
  return {
    availableBytes: Number(value.bavail * value.bsize),
    capacityBytes: Number(value.blocks * value.bsize),
  };
}

async function launchPersistent(
  browserName: string,
  profile: string,
  downloadsPath: string,
): Promise<BrowserContext> {
  const browserType = BROWSER_TYPES[browserName];
  if (!browserType) throw new Error("unsupported qualification browser");
  const context = await browserType.launchPersistentContext(profile, {
    acceptDownloads: true,
    downloadsPath,
    headless: true,
  });
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

async function productPage(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  PAGE_DIAGNOSTICS.set(page, { consoleMessages, pageErrors });
  page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const response = await page.goto(PRODUCT_ORIGIN);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("backup-status")).toHaveText(
    "Le host est prêt pour les fixtures publiques Gate B.",
  );
  await expect(page.getByRole("button", { name: "Créer une sauvegarde d’essai" })).toBeEnabled();
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

async function inspectBackupStore(page: Page): Promise<{
  records: Array<{ key: string; kind: string }>;
  serialized: string;
}> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("libre-ai-notebook", 1);
      request.onerror = () => reject(new Error("database unavailable"));
      request.onsuccess = () => resolveDatabase(request.result);
    });
    return new Promise((resolveState, reject) => {
      const transaction = database.transaction("backup-runtime", "readonly");
      const store = transaction.objectStore("backup-runtime");
      const requests = [
        store.get("encrypted-backup:latest"),
        store.get("restore-receipt:latest"),
        store.getAll(IDBKeyRange.bound("pending:", "pending:\uffff")),
      ];
      transaction.oncomplete = () => {
        database.close();
        const records = [requests[0]?.result, requests[1]?.result, ...(requests[2]?.result ?? [])]
          .filter((record): record is Record<string, unknown> => Boolean(record))
          .sort((left, right) => String(left.key).localeCompare(String(right.key)));
        resolveState({
          records: records.map((record) => ({
            key: String(record.key),
            kind: String(record.kind),
          })),
          serialized: JSON.stringify(records),
        });
      };
      transaction.onabort = () => {
        database.close();
        reject(new Error("records unavailable"));
      };
      transaction.onerror = () => undefined;
    });
  });
}

async function expectWorkersGone(page: Page): Promise<void> {
  await expect.poll(() => page.workers().length, { timeout: 5_000 }).toBe(0);
}

async function filesBelow(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { recursive: true })).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function attachEvidence(
  testInfo: TestInfo,
  evidence: Record<string, unknown>,
): Promise<void> {
  const body = `${JSON.stringify(
    {
      ...evidence,
      schemaVersion: "libre-ai.notebook-product-host-storage-evidence.v1",
    },
    null,
    2,
  )}\n`;
  const evidenceDirectory = join(testInfo.project.outputDir, "evidence");
  const evidencePath = join(
    evidenceDirectory,
    `${testInfo.project.name}-apfs-enospc-and-clean-restart.json`,
  );
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidencePath, body, { encoding: "utf8", flag: "wx" });
  await testInfo.attach("product-host-storage-evidence", {
    contentType: "application/json",
    path: evidencePath,
  });
}
