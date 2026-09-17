import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { inspectRuntimeCapabilities } from "./runtime-diagnostics";
import { assertUnavailableRuntime } from "./runtime-refusal";

const PUBLIC_PLAINTEXT =
  '{"blocks":[],"schemaVersion":"libre-ai.notebook-product-host-fixture.v1"}';

test("seals, downloads, stages and restores through the exact product host", async ({ page }) => {
  const buildManifest = JSON.parse(
    await readFile(new URL("../dist/notebook-build-manifest.json", import.meta.url), "utf8"),
  ) as {
    backupFeature: string;
    coreProvenance: { generatedCore: { sha256: string }; qualificationManifestSha256: string };
    shippingFiles: Record<string, { sha256: string }>;
  };
  expect(buildManifest.backupFeature).toBe("gate-b");
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const root = new URL("../../../", import.meta.url);
  const qualificationBytes = await readFile(new URL("target/notebook-core-v2-qualification/manifest.json", root));
  expect(hash(qualificationBytes)).toBe(buildManifest.coreProvenance.qualificationManifestSha256);
  const qualification = JSON.parse(qualificationBytes.toString("utf8")) as {
    generated: Record<string, { sha256: string }>;
    buildProvenance: {
      inputFiles: Array<{ path: string; sha256: string }>;
      node: { version: string; executableSha256: string };
      rust: string; closedWitSha256: string; coreImports: number;
    };
  };
  const provenance = qualification.buildProvenance;
  expect(provenance.inputFiles.length).toBeGreaterThan(20);
  const inputPaths = provenance.inputFiles.map((input) => input.path);
  expect(inputPaths).toContain("package.json");
  expect(inputPaths).toContain("bun.lock");
  expect(inputPaths.some((path) => path.startsWith("vendored/wit/notebook-core-v2/"))).toBe(true);
  for (const input of provenance.inputFiles) {
    expect(input.path).not.toMatch(/(^\/|\.\.)/);
    expect(hash(await readFile(new URL(input.path, root)))).toBe(input.sha256);
  }
  const toolchain = JSON.parse(await readFile(new URL("toolchains/notebook-qualification.json", root), "utf8"));
  expect(provenance.node.version).toBe(toolchain.node.version);
  expect(Object.values(toolchain.node.platforms).some((asset) =>
    (asset as { executableSha256: string }).executableSha256 === provenance.node.executableSha256,
  )).toBe(true);
  const rustToolchain = await readFile(new URL("rust-toolchain.toml", root), "utf8");
  expect(rustToolchain).toContain(`channel = "${provenance.rust.split(" ")[1]}"`);
  const witBytes = await readFile(new URL("target/notebook-core-v2-qualification/component.wit", root));
  expect(hash(witBytes)).toBe(provenance.closedWitSha256);
  expect(witBytes.toString("utf8")).toContain("export libre-ai:notebook-core/api@2.0.0;");
  expect(witBytes.toString("utf8")).not.toContain("import ");
  expect(provenance.coreImports).toBe(0);
  expect(qualification.generated["notebook-core.core.wasm"]?.sha256).toBe(buildManifest.coreProvenance.generatedCore.sha256);
  const servedCore = await page.request.get("/assets/notebook-core.core.wasm");
  expect(servedCore.ok()).toBe(true);
  const servedBytes = await servedCore.body();
  expect(hash(servedBytes)).toBe(buildManifest.coreProvenance.generatedCore.sha256);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(servedBytes))).toEqual([]);
  expect(buildManifest.shippingFiles["assets/notebook-core.core.wasm"]?.sha256).toBe(
    buildManifest.coreProvenance.generatedCore.sha256,
  );
  expect(
    Object.keys(buildManifest.shippingFiles).some((path) => /fault|internal|trap/i.test(path)),
  ).toBe(false);

  const externalRequests: string[] = [];
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.port === "4174") await route.continue();
    else {
      externalRequests.push(url.origin);
      await route.abort("blockedbyclient");
    }
  });
  page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const pageResponse = await page.goto("/");
  const contentSecurityPolicy = pageResponse?.headers()["content-security-policy"] ?? "";
  expect(contentSecurityPolicy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(contentSecurityPolicy).not.toContain("'unsafe-eval'");
  await expect(page.getByRole("heading", { name: "Fixture publique Gate B" })).toBeVisible();

  await assertRuntimeReady(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Créer une sauvegarde d’essai" }).click();
  const download = await downloadPromise;
  await expect(page.getByTestId("backup-status")).toHaveText(
    "Sauvegarde chiffrée téléchargée sous un nom neutre.",
  );
  const recoveryCode = (await page.getByTestId("recovery-code").textContent()) ?? "";
  expect(recoveryCode).toMatch(/^[a-f0-9]{32}$/);
  expect(download.suggestedFilename()).toBe("notebook-backup.lai");

  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const envelopeBytes = await readFile(downloadPath ?? "");
  const envelope = JSON.parse(envelopeBytes.toString("utf8")) as Record<string, unknown>;
  expect(envelope.schemaVersion).toBe("libre-ai.notebook-backup.v2");
  expect(envelope.cipher).toBe("aes-256-gcm");
  expect(envelopeBytes.toString("utf8")).not.toContain(recoveryCode);

  const afterBackup = await inspectBackupStore(page);
  expect(afterBackup.kinds).toEqual(["encrypted-backup"]);
  expect(afterBackup.serialized).not.toContain(recoveryCode);
  expect(afterBackup.serialized).not.toContain(PUBLIC_PLAINTEXT);

  await page.locator("#backup-file").setInputFiles(downloadPath ?? "");
  await page.locator("#recovery-code").fill(recoveryCode);
  await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
  await expect(page.getByTestId("backup-status")).toHaveText(
    "Sauvegarde authentifiée et reçu de restauration validé.",
  );

  const afterRestore = await inspectBackupStore(page);
  expect(afterRestore.kinds).toEqual(["encrypted-backup", "restore-receipt"]);
  expect(afterRestore.keys.some((key) => key.startsWith("pending:"))).toBe(false);
  expect(afterRestore.serialized).not.toContain(recoveryCode);
  expect(afterRestore.serialized).not.toContain(PUBLIC_PLAINTEXT);
  expect(afterRestore.fieldNames).not.toContain("plaintext");
  expect(afterRestore.fieldNames).not.toContain("recoveryCode");
  expect(afterRestore.fieldNames).not.toContain("recoverySecret");

  await page.locator("#backup-file").setInputFiles(downloadPath ?? "");
  await page.locator("#recovery-code").fill("00".repeat(16));
  await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
  await expect(page.getByTestId("backup-status")).toHaveText("Backup authentication failed.");
  await expect(page.locator("#recovery-code")).toHaveValue("");
  const afterRefusal = await inspectBackupStore(page);
  expect(afterRefusal.keys.some((key) => key.startsWith("pending:"))).toBe(false);

  await page.locator("#backup-file").setInputFiles({
    buffer: Buffer.alloc(0),
    mimeType: "application/json",
    name: "empty.lai",
  });
  await page.locator("#recovery-code").fill("00".repeat(16));
  await page.getByRole("button", { name: "Restaurer la sauvegarde" }).click();
  await expect(page.getByTestId("backup-status")).toHaveText("Invalid backup envelope.");
  await expect(page.locator("#recovery-code")).toHaveValue("");

  expect(externalRequests).toEqual([]);
  expect(consoleMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("removes encrypted restore staging left by an interrupted process", async ({
  context,
  page,
}) => {
  // Fixed phase markers localize an unresolved browser call without exposing records.
  console.info("restore-recovery: initial-navigation");
  await test.step("initial navigation", () => page.goto("/"));
  console.info("restore-recovery: initial-readiness");
  await test.step("initial readiness", () => assertRuntimeReady(page));
  console.info("restore-recovery: stage-indexeddb");
  await test.step("stage IndexedDB record", () => page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("libre-ai-notebook", 1);
      open.onerror = () => reject(new Error("database unavailable"));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction("backup-runtime", "readwrite");
        transaction.objectStore("backup-runtime").put({
          envelope: new Uint8Array([1, 2, 3]),
          key: `pending:op_${"a".repeat(32)}`,
          kind: "pending-restore",
          operationId: `op_${"a".repeat(32)}`,
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onabort = () => reject(new Error("staging unavailable"));
      };
    });
  }));

  console.info("restore-recovery: close-original-page");
  await test.step("close original page", () => page.close());
  console.info("restore-recovery: create-recovery-page");
  const recoveredPage = await test.step("create recovery page", () => context.newPage());
  console.info("restore-recovery: recovery-navigation");
  await test.step("recovery navigation", () => recoveredPage.goto("/", { waitUntil: "domcontentloaded" }));
  console.info("restore-recovery: await-cleanup-status");
  await test.step("await cleanup status", () => expect(recoveredPage.getByTestId("backup-status")).toHaveText(
    "Une restauration interrompue a été nettoyée sans libérer de plaintext.",
  ));
  console.info("restore-recovery: inspect-indexeddb");
  const records = await test.step("inspect IndexedDB records", () => inspectBackupStore(recoveredPage));
  expect(records.keys.some((key) => key.startsWith("pending:"))).toBe(false);
  console.info("restore-recovery: completed");
});

async function inspectBackupStore(page: import("@playwright/test").Page): Promise<{
  fieldNames: string[];
  keys: string[];
  kinds: string[];
  serialized: string;
}> {
  return page.evaluate(async () => {
    const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const open = indexedDB.open("libre-ai-notebook", 1);
      open.onerror = () => reject(new Error("database unavailable"));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction("backup-runtime", "readonly");
        const request = transaction.objectStore("backup-runtime").getAll();
        request.onerror = () => reject(new Error("records unavailable"));
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        transaction.oncomplete = () => database.close();
      };
    });
    return {
      fieldNames: [...new Set(records.flatMap((record) => Object.keys(record)))].sort(),
      keys: records.map((record) => String(record.key)).sort(),
      kinds: records.map((record) => String(record.kind)).sort(),
      serialized: JSON.stringify(records),
    };
  });
}

async function assertRuntimeReady(page: import("@playwright/test").Page): Promise<void> {
  try {
    await expect(page.getByTestId("backup-status")).toContainText("host est prêt");
  } catch {
    const capabilities = await inspectRuntimeCapabilities(page);
    throw new Error(`Notebook startup unavailable: ${JSON.stringify(capabilities)}`);
  }
}

test("reports capability stages without retaining exception details", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: async () => { throw new TypeError("private-diagnostic-sentinel"); } },
    });
  });
  const capabilities = await inspectRuntimeCapabilities(page);
  expect(capabilities.quota).toBe("type-error");
  expect(JSON.stringify(capabilities)).not.toContain("private-diagnostic-sentinel");
});

test("refuses a missing quota API without creating a backup worker", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "storage", { configurable: true, value: {} });
  });
  await assertUnavailableRuntime(page);
});
