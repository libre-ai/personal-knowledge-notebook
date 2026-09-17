import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

import { sumPinnedBrowserCacheRss } from "./browser-rss";
import {
  type NotebookHardwareResources,
  parseResourceClassManifest,
  selectEvidenceEnvironment,
  selectResourceClass,
} from "./resource-class";

const ITERATIONS = 20;
const WARMUPS = 2;
const MIB = 1024 * 1024;
const PROFILES = [
  {
    iterations: 3,
    memoryBudgetBytes: 256 * MIB,
    memoryKib: 65_536,
    name: "producer-16mib",
    parallelism: 1,
    plaintextBytes: 16 * MIB,
    plaintextSha256: "55c7e25571a69216de25162f191bb2847201a09ee7efe46b5bada034acc695d5",
    p95BudgetMs: 5_000,
  },
  {
    iterations: 4,
    memoryBudgetBytes: 512 * MIB,
    memoryKib: 131_072,
    name: "maximum-16mib",
    parallelism: 4,
    plaintextBytes: 16 * MIB,
    plaintextSha256: "55c7e25571a69216de25162f191bb2847201a09ee7efe46b5bada034acc695d5",
    p95BudgetMs: 10_000,
  },
] as const;

type Sample = { endToEndMs: number; operationMs: number; wasmMemoryBytes: number };
type WorkerResponse = {
  code?: string;
  envelope?: Uint8Array;
  operationMs?: number;
  outputLength?: number;
  outputSha256?: string;
  requestId?: number;
  tag?: string;
  wasmMemoryBytes?: number;
};
type Vectors = {
  golden: { canonicalEnvelopeUtf8: string; recoverySecret: { hex: string } };
  mutations: Array<{
    name: string;
    recoverySecretHex: string;
    envelope: Record<string, unknown>;
  }>;
};

const repositoryRoot = process.cwd();
const outputDirectory = resolve(repositoryRoot, "target/notebook-core-v2-qualification");
const resourceClassManifestBytes = readFileSync(
  resolve(repositoryRoot, "toolchains/notebook-resource-classes.json"),
);
const resourceClassManifest = parseResourceClassManifest(
  JSON.parse(resourceClassManifestBytes.toString("utf8")),
);
const resourceClassManifestSha256 = createHash("sha256")
  .update(resourceClassManifestBytes)
  .digest("hex");
const toolchain = JSON.parse(
  readFileSync(resolve(repositoryRoot, "toolchains/notebook-qualification.json"), "utf8"),
) as {
  playwright: {
    engines: Record<string, { cacheDirectory: string; browserVersion: string; revision: string }>;
  };
};

test.describe.configure({ timeout: 1_800_000 });

test("measures locked 16 MiB profiles and anti-oracle distributions", async ({
  browser,
  browserName,
  page,
}) => {
  test.skip(process.platform !== "darwin" || process.arch !== "arm64");
  const engine = toolchain.playwright.engines[browserName];
  expect(engine).toBeDefined();
  const hardware: NotebookHardwareResources = {
    architecture: process.arch,
    hardwareModel: command("sysctl", ["-n", "hw.model"]),
    hypervisorPresent: command("sysctl", ["-n", "kern.hv_vmm_present"]) !== "0",
    logicalCpu: Number(command("sysctl", ["-n", "hw.logicalcpu"])),
    memoryBytes: Number(command("sysctl", ["-n", "hw.memsize"])),
    operatingSystem: process.platform,
    processor: command("sysctl", ["-n", "machdep.cpu.brand_string"]),
  };
  const evidenceEnvironment = selectEvidenceEnvironment(
    process.env.NOTEBOOK_QUALIFICATION_EVIDENCE_MODE,
    hardware,
  );
  const resourceClass = selectResourceClass(
    resourceClassManifest,
    process.env.NOTEBOOK_QUALIFICATION_DEVICE_CLASS,
    hardware,
  );
  const blockedRequests: string[] = [];
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  await blockExternalRequests(page, blockedRequests);
  page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const browserResourcePreflight = await page.evaluate(async () => {
    const source = new Uint8Array([0x5a]);
    const transferred = structuredClone(source, { transfer: [source.buffer] });
    const estimate = await navigator.storage.estimate();
    if (
      typeof estimate.quota !== "number" ||
      typeof estimate.usage !== "number" ||
      !Number.isFinite(estimate.quota) ||
      !Number.isFinite(estimate.usage)
    ) {
      throw new Error("browser storage estimate is unavailable");
    }
    return {
      availableStorageQuotaBytes: Math.max(0, estimate.quota - estimate.usage),
      dedicatedWorker: typeof Worker === "function",
      indexedDb: typeof indexedDB === "object",
      secureContext: isSecureContext,
      transferredArrayBuffer:
        source.byteLength === 0 && transferred.byteLength === 1 && transferred[0] === 0x5a,
      webCrypto:
        typeof crypto.getRandomValues === "function" && typeof crypto.subtle?.digest === "function",
    };
  });
  expect(browserResourcePreflight).toMatchObject({
    dedicatedWorker: true,
    indexedDb: true,
    secureContext: true,
    transferredArrayBuffer: true,
    webCrypto: true,
  });
  expect(browserResourcePreflight.availableStorageQuotaBytes).toBeGreaterThanOrEqual(
    resourceClassManifest.productStorageQuotaCandidateBytes,
  );
  const verifiedBrowserCapabilities = [
    "webassembly-simd128",
    "dedicated-worker",
    "arraybuffer-transfer",
    "web-crypto",
    "indexeddb",
  ].sort();
  expect(verifiedBrowserCapabilities).toEqual(
    [...resourceClassManifest.requiredBrowserCapabilities].sort(),
  );

  const rss = new BrowserRssSampler(engine?.cacheDirectory ?? "");
  const reuseCompiledModule = browserName === "firefox";
  const profileResults: Array<Record<string, unknown>> = [];
  for (const profile of PROFILES) {
    rss.startProfile();
    const profileRun = await page.evaluate(
      async ({ iterations, profile, reuseCompiledModule, warmups }) => {
        const workerUrl = "/generated/benchmark-worker.js";
        let coreModule: WebAssembly.Module | undefined;
        let moduleCompilationMs = 0;
        if (reuseCompiledModule) {
          const moduleState = globalThis as typeof globalThis & {
            __notebookQualificationCompilationMs?: number;
            __notebookQualificationCoreModule?: WebAssembly.Module;
          };
          coreModule = moduleState.__notebookQualificationCoreModule;
          const cachedCompilationMs = moduleState.__notebookQualificationCompilationMs;
          if (!coreModule || cachedCompilationMs === undefined) {
            const compilationStarted = performance.now();
            const response = await fetch("/generated/notebook-core.core.wasm", {
              cache: "no-store",
            });
            if (!response.ok) throw new Error("benchmark core module unavailable");
            coreModule = await WebAssembly.compile(await response.arrayBuffer());
            if (WebAssembly.Module.imports(coreModule).length !== 0) {
              throw new Error("benchmark core module has imports");
            }
            moduleCompilationMs = performance.now() - compilationStarted;
            moduleState.__notebookQualificationCompilationMs = moduleCompilationMs;
            moduleState.__notebookQualificationCoreModule = coreModule;
          } else {
            moduleCompilationMs = cachedCompilationMs;
          }
        }
        let nextRequestId = 1;
        const runWorker = (
          request: Record<string, unknown>,
          transfer: ArrayBuffer[],
        ): Promise<WorkerResponse & { endToEndMs: number }> => {
          const requestId = nextRequestId;
          nextRequestId += 1;
          const started = performance.now();
          return new Promise((resolve, reject) => {
            const worker = new Worker(workerUrl, { type: "module" });
            const timeout = setTimeout(() => {
              worker.terminate();
              reject(new Error("benchmark worker deadline exceeded"));
            }, 30_000);
            const finish = (): void => {
              clearTimeout(timeout);
              worker.onmessage = null;
              worker.onerror = null;
              worker.terminate();
            };
            worker.onerror = (event) => {
              event.preventDefault();
              finish();
              reject(new Error("benchmark worker failed closed"));
            };
            worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
              const response = event.data;
              finish();
              if (response.requestId !== requestId) {
                reject(new Error("benchmark worker response mismatch"));
              } else if (response.tag === "err") {
                reject(new Error(`benchmark refused with ${response.code ?? "unknown"}`));
              } else {
                resolve({
                  ...response,
                  endToEndMs: performance.now() - started + moduleCompilationMs,
                });
              }
            };
            worker.postMessage(
              { ...request, ...(coreModule ? { coreModule } : {}), requestId },
              transfer,
            );
          });
        };
        const hexId = (iteration: number): string =>
          iteration.toString(16).padStart(32, "0").slice(-32);
        const bytes = (length: number, seed: number): Uint8Array =>
          Uint8Array.from({ length }, (_, index) => (index + seed) & 0xff);
        const runIteration = async (
          iteration: number,
        ): Promise<{
          open: Sample;
          seal: Sample;
        }> => {
          const plaintext = new Uint8Array(profile.plaintextBytes).fill(0x5a);
          const sealSecret = bytes(16, 32);
          const salt = bytes(16, iteration + 1);
          const nonce = bytes(12, iteration + 65);
          const seal = await runWorker(
            {
              operation: "seal",
              recoverySecret: sealSecret,
              request: {
                schemaVersion: "libre-ai.notebook-backup-seal-request.v2",
                id: `urn:libre-ai:backup:${hexId(iteration + 1)}`,
                cipher: "aes-256-gcm",
                kdf: {
                  algorithm: "argon2id",
                  version: 19,
                  memoryKib: profile.memoryKib,
                  iterations: profile.iterations,
                  parallelism: profile.parallelism,
                  outputLengthBytes: 32,
                  salt,
                },
                nonce,
                plaintext,
              },
            },
            [
              plaintext.buffer as ArrayBuffer,
              sealSecret.buffer as ArrayBuffer,
              salt.buffer as ArrayBuffer,
              nonce.buffer as ArrayBuffer,
            ],
          );
          if (!(seal.envelope instanceof Uint8Array)) {
            throw new Error("benchmark seal did not return an envelope");
          }
          const envelope = seal.envelope;
          const openSecret = bytes(16, 32);
          const open = await runWorker(
            { envelope, operation: "open", recoverySecret: openSecret },
            [envelope.buffer as ArrayBuffer, openSecret.buffer as ArrayBuffer],
          );
          if (
            open.tag !== "open-ok" ||
            open.outputLength !== profile.plaintextBytes ||
            open.outputSha256 !== profile.plaintextSha256
          ) {
            throw new Error("benchmark open round-trip mismatch");
          }
          const sample = (value: WorkerResponse & { endToEndMs: number }): Sample => {
            if (
              typeof value.operationMs !== "number" ||
              typeof value.wasmMemoryBytes !== "number"
            ) {
              throw new Error("benchmark metrics are incomplete");
            }
            return {
              endToEndMs: value.endToEndMs,
              operationMs: value.operationMs,
              wasmMemoryBytes: value.wasmMemoryBytes,
            };
          };
          return { open: sample(open), seal: sample(seal) };
        };

        for (let index = 0; index < warmups; index += 1) await runIteration(10_000 + index);
        const measured: Array<{ open: Sample; seal: Sample }> = [];
        for (let index = 0; index < iterations; index += 1) {
          measured.push(await runIteration(index));
        }
        return { moduleCompilationMs, samples: measured };
      },
      {
        iterations: ITERATIONS,
        profile,
        reuseCompiledModule,
        warmups: WARMUPS,
      },
    );
    const rssResult = rss.finishProfile();
    const samples = profileRun.samples;
    const seal = summarize(samples.map((sample) => sample.seal));
    const open = summarize(samples.map((sample) => sample.open));
    const budgetPass =
      seal.endToEndP95Ms <= profile.p95BudgetMs &&
      open.endToEndP95Ms <= profile.p95BudgetMs &&
      rssResult.peakDeltaBytes <= profile.memoryBudgetBytes;
    profileResults.push({
      ...profile,
      budgetPass,
      browserPeakRssBytes: rssResult.peakBytes,
      browserPeakRssDeltaBytes: rssResult.peakDeltaBytes,
      browserRssBaselineBytes: rssResult.baselineBytes,
      moduleCompilationMs: profileRun.moduleCompilationMs,
      open,
      seal,
    });
  }

  rss.startProfile();
  const antiOracle = await page.evaluate(
    async ({ iterations, reuseCompiledModule }) => {
      const vectors = (await (await fetch("/golden-vectors.json")).json()) as Vectors;
      let coreModule: WebAssembly.Module | undefined;
      let moduleCompilationMs = 0;
      if (reuseCompiledModule) {
        const moduleState = globalThis as typeof globalThis & {
          __notebookQualificationCompilationMs?: number;
          __notebookQualificationCoreModule?: WebAssembly.Module;
        };
        coreModule = moduleState.__notebookQualificationCoreModule;
        moduleCompilationMs = moduleState.__notebookQualificationCompilationMs ?? 0;
        if (!coreModule || WebAssembly.Module.imports(coreModule).length !== 0) {
          throw new Error("benchmark core module cache unavailable");
        }
      }
      const encoder = new TextEncoder();
      const fromHex = (value: string): Uint8Array => {
        const output = new Uint8Array(value.length / 2);
        for (let index = 0; index < output.length; index += 1) {
          output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
        }
        return output;
      };
      const mutation = (name: string) => {
        const found = vectors.mutations.find((candidate) => candidate.name === name);
        if (!found) throw new Error("anti-oracle vector is missing");
        return {
          envelope: encoder.encode(JSON.stringify(found.envelope)),
          secret: fromHex(found.recoverySecretHex),
        };
      };
      const cases = {
        "digest-modified": mutation("digest-modified"),
        "recovery-secret-too-short": mutation("recovery-secret-too-short"),
        "tag-modified": mutation("ciphertext-modified"),
        "wrong-recovery-secret": mutation("wrong-recovery-secret"),
      };
      let nextRequestId = 50_000;
      const run = (
        envelope: Uint8Array,
        recoverySecret: Uint8Array,
      ): Promise<{ endToEndMs: number; operationMs: number; wasmMemoryBytes: number }> => {
        const requestId = nextRequestId;
        nextRequestId += 1;
        const started = performance.now();
        return new Promise((resolve, reject) => {
          const worker = new Worker("/generated/benchmark-worker.js", { type: "module" });
          const timeout = setTimeout(() => {
            worker.terminate();
            reject(new Error("anti-oracle worker deadline exceeded"));
          }, 15_000);
          const finish = (): void => {
            clearTimeout(timeout);
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
          };
          worker.onerror = (event) => {
            event.preventDefault();
            finish();
            reject(new Error("anti-oracle worker failed closed"));
          };
          worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const response = event.data;
            finish();
            if (
              response.requestId !== requestId ||
              response.tag !== "open-refused" ||
              response.code !== "authentication-failed" ||
              typeof response.operationMs !== "number" ||
              typeof response.wasmMemoryBytes !== "number"
            ) {
              reject(new Error("anti-oracle response mismatch"));
            } else {
              resolve({
                endToEndMs: performance.now() - started + moduleCompilationMs,
                operationMs: response.operationMs,
                wasmMemoryBytes: response.wasmMemoryBytes,
              });
            }
          };
          worker.postMessage(
            {
              ...(coreModule ? { coreModule } : {}),
              envelope,
              operation: "open-failure",
              recoverySecret,
              requestId,
            },
            [envelope.buffer as ArrayBuffer, recoverySecret.buffer as ArrayBuffer],
          );
        });
      };
      const result: Record<string, Sample[]> = {};
      for (const [name, fixture] of Object.entries(cases)) {
        await run(fixture.envelope.slice(), fixture.secret.slice());
        const samples: Sample[] = [];
        for (let index = 0; index < iterations; index += 1) {
          samples.push(await run(fixture.envelope.slice(), fixture.secret.slice()));
        }
        result[name] = samples;
        fixture.envelope.fill(0);
        fixture.secret.fill(0);
      }
      return result;
    },
    { iterations: ITERATIONS, reuseCompiledModule },
  );
  const antiOracleRss = rss.finishProfile();
  const antiOracleSummary = Object.fromEntries(
    Object.entries(antiOracle).map(([name, samples]) => [name, summarize(samples)]),
  );

  const manifest = JSON.parse(
    await readFile(resolve(outputDirectory, "manifest.json"), "utf8"),
  ) as { component: { sha256: string }; coreModule: { sha256: string } };
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const report = {
    antiOracle: antiOracleSummary,
    antiOraclePeakRssBytes: antiOracleRss.peakBytes,
    antiOraclePeakRssDeltaBytes: antiOracleRss.peakDeltaBytes,
    browserName,
    browserResourcePreflight,
    browserVersion: browser.version(),
    commit: command("git", ["rev-parse", "HEAD"]),
    compiledModuleLifecycle: reuseCompiledModule
      ? "one-per-page-cloned-to-disposable-workers"
      : "one-per-disposable-worker",
    endToEndCompilationAccounting: reuseCompiledModule
      ? "measured-page-compilation-added-to-every-sample"
      : "per-worker-compilation-measured-directly",
    componentSha256: manifest.component.sha256,
    coreModuleSha256: manifest.coreModule.sha256,
    deviceClass: resourceClass.id,
    evidenceMode: evidenceEnvironment.mode,
    hardware: {
      hardwareModel: hardware.hardwareModel,
      hypervisorPresent: hardware.hypervisorPresent,
      logicalCpu: hardware.logicalCpu,
      memoryBytes: hardware.memoryBytes,
      processor: hardware.processor,
    },
    minimumProductCandidateClassId: resourceClassManifest.minimumProductCandidateClassId,
    iterations: ITERATIONS,
    node: process.versions.node,
    operatingSystem: {
      architecture: process.arch,
      build: command("sw_vers", ["-buildVersion"]),
      name: command("sw_vers", ["-productName"]),
      version: command("sw_vers", ["-productVersion"]),
    },
    profiles: profileResults,
    requiredBrowserCapabilities: resourceClassManifest.requiredBrowserCapabilities,
    promotableEvidence: evidenceEnvironment.promotable,
    resourceClassEvidenceStatus: resourceClass.evidenceStatus,
    resourceClassManifestSha256,
    rssProcessSelection: "exclusive-pinned-browser-cache",
    resourceClassRequirements: {
      architecture: resourceClass.architecture,
      maximumLogicalCpuExclusive: resourceClass.maximumLogicalCpuExclusive,
      maximumPhysicalMemoryBytesExclusive: resourceClass.maximumPhysicalMemoryBytesExclusive,
      minimumLogicalCpu: resourceClass.minimumLogicalCpu,
      minimumPhysicalMemoryBytes: resourceClass.minimumPhysicalMemoryBytes,
      operatingSystem: resourceClass.operatingSystem,
      purpose: resourceClass.purpose,
    },
    schemaVersion: "libre-ai.notebook-core-v2-browser-performance.v2",
    toolchainManifestSha256: createHash("sha256")
      .update(await readFile(resolve(repositoryRoot, "toolchains/notebook-qualification.json")))
      .digest("hex"),
    userAgent,
    verifiedBrowserCapabilities,
    virtualizationDetected: evidenceEnvironment.virtualizationDetected,
    virtualizationSignals: evidenceEnvironment.virtualizationSignals,
    warmups: WARMUPS,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, `performance-${browserName}.json`),
    `${JSON.stringify(report)}\n`,
  );

  expect(blockedRequests).toEqual([]);
  expect(consoleMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});

function summarize(samples: Sample[]) {
  const operation = samples.map(({ operationMs }) => operationMs);
  const endToEnd = samples.map(({ endToEndMs }) => endToEndMs);
  return {
    endToEndP50Ms: percentile(endToEnd, 0.5),
    endToEndP95Ms: percentile(endToEnd, 0.95),
    operationP50Ms: percentile(operation, 0.5),
    operationP95Ms: percentile(operation, 0.95),
    samples,
    wasmMemoryPeakBytes: Math.max(...samples.map(({ wasmMemoryBytes }) => wasmMemoryBytes)),
  };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? Number.NaN;
}

class BrowserRssSampler {
  private baselineBytes = 0;
  private peakBytes = 0;
  private referenceBaselineBytes = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly cacheDirectory: string) {}

  startProfile(): void {
    this.stop();
    const currentBytes = this.sample();
    if (currentBytes <= 0) throw new Error("browser RSS process group is unavailable");
    if (this.referenceBaselineBytes === 0) this.referenceBaselineBytes = currentBytes;
    this.baselineBytes = this.referenceBaselineBytes;
    this.peakBytes = Math.max(this.baselineBytes, currentBytes);
    this.timer = setInterval(() => {
      this.peakBytes = Math.max(this.peakBytes, this.sample());
    }, 20);
  }

  finishProfile(): { baselineBytes: number; peakBytes: number; peakDeltaBytes: number } {
    this.peakBytes = Math.max(this.peakBytes, this.sample());
    this.stop();
    return {
      baselineBytes: this.baselineBytes,
      peakBytes: this.peakBytes,
      peakDeltaBytes: Math.max(0, this.peakBytes - this.baselineBytes),
    };
  }

  private sample(): number {
    const cachePath = join(homedir(), "Library/Caches/ms-playwright", this.cacheDirectory);
    const processTable = execFileSync("/bin/ps", ["-axo", "rss=,command="], {
      encoding: "utf8",
    });
    return sumPinnedBrowserCacheRss(processTable, cachePath);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

async function blockExternalRequests(page: Page, blocked: string[]): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.port === "41773") await route.continue();
    else {
      blocked.push(url.origin);
      await route.abort("blockedbyclient");
    }
  });
}

function command(executable: string, arguments_: string[]): string {
  return execFileSync(executable, arguments_, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}
