import { expect, type Page, test } from "@playwright/test";
import type { ErrorCode, NotebookCoreApi, NotebookHostRefusal, SealBackupRequest } from "./host";

type VectorKdf = {
  algorithm: string;
  version: number;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  outputLengthBytes: number;
  salt: string;
};

type VectorEnvelope = {
  schemaVersion: string;
  id: string;
  cipher: string;
  kdf: VectorKdf;
  nonce: string;
  ciphertext: string;
  digest: string;
};

type Vectors = {
  golden: {
    request: {
      schemaVersion: string;
      id: string;
      cipher: string;
      kdf: VectorKdf;
      nonce: string;
      plaintext: string;
    };
    recoverySecret: { hex: string };
    plaintext: { base64: string };
    canonicalEnvelopeUtf8: string;
  };
  mutations: Array<{
    name: string;
    recoverySecretHex: string;
    envelope: VectorEnvelope;
    expected: { code: ErrorCode; plaintextReleased: boolean };
  }>;
  contextCanonicalization: {
    golden: { inputUtf8: string; canonicalOutputUtf8: string };
    mutations: Array<{
      name: string;
      documentUtf8?: string;
      documentHex?: string;
      expected: { code: ErrorCode };
    }>;
    numericCases: Array<{
      name: string;
      inputUtf8: string;
      canonicalUtf8?: string;
      expected: "accepted" | "invalid-document";
    }>;
    resourceCases: Array<{
      name: string;
      dimension: "jsonDepth" | "jsonNodes" | "totalLinks";
      value: number;
      expected: "accepted" | "invalid-document";
      fixtureOrdinal: number;
      canonicalOutputByteLength?: number;
      canonicalOutputSha256?: string;
    }>;
  };
};

type ComponentModule = {
  instantiate(
    loader: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, never>,
  ): Promise<{ api: NotebookCoreApi; "libre-ai:notebook-core/api@2.0.0": NotebookCoreApi }>;
};

type HostModule = typeof import("./host");

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

test("executes the locked component through the qualification host", async ({ page }) => {
  const blockedRequests: string[] = [];
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  await blockExternalRequests(page, blockedRequests);
  page.on("console", (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const componentUrl = "/generated/notebook-core.js";
    const hostUrl = "/generated/host.js";
    const component = (await import(componentUrl)) as ComponentModule;
    const host = (await import(hostUrl)) as HostModule;
    const vectors = (await (await fetch("/golden-vectors.json")).json()) as Vectors;
    const loadedCoreModules: string[] = [];
    const root = await component.instantiate(async (path) => {
      const response = await fetch(`/generated/${path}`, { cache: "no-store" });
      if (!response.ok) throw new Error("qualification core module unavailable");
      const module = await WebAssembly.compile(await response.arrayBuffer());
      if (WebAssembly.Module.imports(module).length !== 0) {
        throw new Error("transpiled core module unexpectedly imports host capabilities");
      }
      loadedCoreModules.push(path);
      return module;
    }, {});
    if (root.api !== root["libre-ai:notebook-core/api@2.0.0"]) {
      throw new Error("component aliases do not resolve to the same API");
    }

    const fromBase64 = (value: string): Uint8Array =>
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const fromHex = (value: string): Uint8Array => {
      const output = new Uint8Array(value.length / 2);
      for (let index = 0; index < output.length; index += 1) {
        output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
      }
      return output;
    };
    const toHex = (value: Uint8Array): string =>
      [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const equal = (left: Uint8Array, right: Uint8Array): boolean =>
      left.length === right.length && left.every((byte, index) => byte === right[index]);
    const wiped = (value: Uint8Array): boolean => value.every((byte) => byte === 0);
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    const sha256Hex = async (value: Uint8Array): Promise<string> => {
      const copy = new ArrayBuffer(value.byteLength);
      new Uint8Array(copy).set(value);
      return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
    };
    const blockIds = Array.from(
      { length: 1_000 },
      (_, index) => `blk_${index.toString(16).padStart(32, "0")}`,
    );
    const contextWithJson = (ordinal: number, content: string): Uint8Array =>
      textEncoder.encode(
        JSON.stringify({
          schemaVersion: "libre-ai.context-document.v2",
          id: `urn:libre-ai:context:${ordinal.toString(16).padStart(32, "0")}`,
          rootBlockIds: [blockIds[0]],
          blocks: [
            {
              id: blockIds[0],
              mediaType: "application/json",
              content,
              links: [],
            },
          ],
          totalBytes: content.length,
          digest: "0".repeat(64),
        }),
      );
    const materializeResource = (
      resource: Vectors["contextCanonicalization"]["resourceCases"][number],
    ): Uint8Array => {
      let blocks: Array<Record<string, unknown>>;
      if (resource.dimension === "jsonDepth") {
        blocks = [
          {
            id: blockIds[0],
            mediaType: "application/json",
            content: `${"[".repeat(resource.value - 1)}0${"]".repeat(resource.value - 1)}`,
            links: [],
          },
        ];
      } else if (resource.dimension === "jsonNodes") {
        blocks = [
          {
            id: blockIds[0],
            mediaType: "application/json",
            content: `[${Array(resource.value - 1)
              .fill("0")
              .join(",")}]`,
            links: [],
          },
        ];
      } else {
        let remaining = resource.value;
        blocks = blockIds.map((id) => {
          const count = Math.min(remaining, 1_000);
          remaining -= count;
          return { id, mediaType: "text/plain", content: "", links: blockIds.slice(0, count) };
        });
      }
      const totalBytes = blocks.reduce((total, block) => total + String(block.content).length, 0);
      return textEncoder.encode(
        JSON.stringify({
          schemaVersion: "libre-ai.context-document.v2",
          id: `urn:libre-ai:context:${resource.fixtureOrdinal.toString(16).padStart(32, "0")}`,
          rootBlockIds: [blockIds[0]],
          blocks,
          totalBytes,
          digest: "0".repeat(64),
        }),
      );
    };

    const golden = vectors.golden;
    const request: SealBackupRequest = {
      schemaVersion: golden.request.schemaVersion,
      id: golden.request.id,
      cipher: golden.request.cipher,
      kdf: {
        algorithm: golden.request.kdf.algorithm,
        version: golden.request.kdf.version,
        memoryKib: golden.request.kdf.memoryKiB,
        iterations: golden.request.kdf.iterations,
        parallelism: golden.request.kdf.parallelism,
        outputLengthBytes: golden.request.kdf.outputLengthBytes,
        salt: fromBase64(golden.request.kdf.salt),
      },
      nonce: fromBase64(golden.request.nonce),
      plaintext: fromBase64(golden.request.plaintext),
    };
    const goldenPlaintextInput = request.plaintext;
    const goldenSecretInput = fromHex(golden.recoverySecret.hex);
    const envelope = host.sealOwned(root.api, request, goldenSecretInput);
    const envelopeMatches = textDecoder.decode(envelope) === vectors.golden.canonicalEnvelopeUtf8;

    let openedPlaintext: Uint8Array | undefined;
    const openedMatches = await host.openForUse(
      root.api,
      envelope,
      golden.recoverySecret.hex,
      (opened) => {
        openedPlaintext = opened.plaintext;
        return equal(opened.plaintext, fromBase64(golden.plaintext.base64));
      },
    );

    const contextInput = textEncoder.encode(vectors.contextCanonicalization.golden.inputUtf8);
    const canonicalContext = host.canonicalizeOwned(root.api, contextInput);
    const contextMatches =
      textDecoder.decode(canonicalContext) ===
      vectors.contextCanonicalization.golden.canonicalOutputUtf8;
    canonicalContext.fill(0);

    const contextMutationFailures: string[] = [];
    for (const mutation of vectors.contextCanonicalization.mutations) {
      const input =
        mutation.documentUtf8 !== undefined
          ? textEncoder.encode(mutation.documentUtf8)
          : fromHex(mutation.documentHex ?? "");
      let code: ErrorCode | "accepted" = "accepted";
      let message = "";
      try {
        const output = host.canonicalizeOwned(root.api, input);
        output.fill(0);
      } catch (error) {
        const refusal = error as NotebookHostRefusal;
        code = refusal.code;
        message = refusal.message;
      }
      if (
        code !== mutation.expected.code ||
        message !== host.ERROR_MESSAGES[mutation.expected.code] ||
        !wiped(input)
      ) {
        contextMutationFailures.push(mutation.name);
      }
    }

    const numericFailures: string[] = [];
    for (const [index, numeric] of vectors.contextCanonicalization.numericCases.entries()) {
      const input = contextWithJson(index + 32, numeric.inputUtf8);
      let code: ErrorCode | "accepted" = "accepted";
      let canonicalContent: string | undefined;
      try {
        const output = host.canonicalizeOwned(root.api, input);
        const parsed = JSON.parse(textDecoder.decode(output)) as {
          blocks: Array<{ content: string }>;
        };
        canonicalContent = parsed.blocks[0]?.content;
        output.fill(0);
      } catch (error) {
        code = (error as NotebookHostRefusal).code;
      }
      if (
        code !== numeric.expected ||
        (numeric.expected === "accepted" && canonicalContent !== numeric.canonicalUtf8) ||
        !wiped(input)
      ) {
        numericFailures.push(numeric.name);
      }
    }

    const resourceFailures: string[] = [];
    for (const resource of vectors.contextCanonicalization.resourceCases) {
      const input = materializeResource(resource);
      let code: ErrorCode | "accepted" = "accepted";
      let outputLength: number | undefined;
      let outputSha256: string | undefined;
      try {
        const output = host.canonicalizeOwned(root.api, input);
        outputLength = output.length;
        outputSha256 = await sha256Hex(output);
        output.fill(0);
      } catch (error) {
        code = (error as NotebookHostRefusal).code;
      }
      if (
        code !== resource.expected ||
        (resource.expected === "accepted" &&
          (outputLength !== resource.canonicalOutputByteLength ||
            outputSha256 !== resource.canonicalOutputSha256)) ||
        !wiped(input)
      ) {
        resourceFailures.push(resource.name);
      }
    }

    const mutationFailures: string[] = [];
    for (const mutation of vectors.mutations) {
      let plaintextReleased = false;
      let code: ErrorCode | "accepted" = "accepted";
      let message = "";
      try {
        await host.openForUse(
          root.api,
          textEncoder.encode(JSON.stringify(mutation.envelope)),
          mutation.recoverySecretHex,
          () => {
            plaintextReleased = true;
          },
        );
      } catch (error) {
        const refusal = error as NotebookHostRefusal;
        code = refusal.code;
        message = refusal.message;
      }
      if (
        code !== mutation.expected.code ||
        message !== host.ERROR_MESSAGES[mutation.expected.code] ||
        plaintextReleased !== mutation.expected.plaintextReleased
      ) {
        mutationFailures.push(mutation.name);
      }
    }

    let malformedRecovery: { code?: ErrorCode; message?: string } = {};
    try {
      await host.openForUse(root.api, envelope, golden.recoverySecret.hex.toUpperCase(), () => {});
    } catch (error) {
      const refusal = error as NotebookHostRefusal;
      malformedRecovery = { code: refusal.code, message: refusal.message };
    }

    const ids = new Set<string>();
    const contexts = new Set<string>();
    const blocks = new Set<string>();
    const salts = new Set<string>();
    const nonces = new Set<string>();
    const recoveries = new Set<string>();
    let materialShapeValid = true;
    for (let index = 0; index < 256; index += 1) {
      const material = host.generateFreshSealMaterial();
      ids.add(material.backupId);
      contexts.add(host.freshOpaqueId("urn:libre-ai:context:"));
      blocks.add(host.freshOpaqueId("blk_"));
      salts.add(toHex(material.salt));
      nonces.add(toHex(material.nonce));
      recoveries.add(material.recoveryCode);
      materialShapeValid &&=
        /^urn:libre-ai:backup:[a-f0-9]{32}$/.test(material.backupId) &&
        /^[a-f0-9]{32}$/.test(material.recoveryCode) &&
        material.salt.length === 16 &&
        material.nonce.length === 12 &&
        material.recoverySecret.length === 16;
      material.recoverySecret.fill(0);
    }

    const freshPlaintext = textEncoder.encode("public qualification round-trip");
    const fresh = host.sealFreshOwned(root.api, freshPlaintext);
    let freshOpenedPlaintext: Uint8Array | undefined;
    const freshRoundTrip = await host.openForUse(
      root.api,
      fresh.envelope,
      fresh.recoveryCode,
      (opened) => {
        freshOpenedPlaintext = opened.plaintext;
        return textDecoder.decode(opened.plaintext) === "public qualification round-trip";
      },
    );

    const manifest = (await (await fetch("/manifest.json")).json()) as {
      component: { sha256: string };
      coreModule: { sha256: string };
      transpiler: string;
    };
    return {
      componentSha256: manifest.component.sha256,
      contextInputWiped: wiped(contextInput),
      contextMatches,
      contextMutationFailures,
      envelopeMatches,
      freshInputWiped: wiped(freshPlaintext),
      freshOpenedWiped: freshOpenedPlaintext !== undefined && wiped(freshOpenedPlaintext),
      freshRoundTrip,
      goldenInputWiped: wiped(goldenPlaintextInput),
      goldenOpenedWiped: openedPlaintext !== undefined && wiped(openedPlaintext),
      goldenSecretWiped: wiped(goldenSecretInput),
      loadedCoreModules,
      malformedRecovery,
      materialShapeValid,
      materialUnique:
        ids.size === 256 &&
        contexts.size === 256 &&
        blocks.size === 256 &&
        salts.size === 256 &&
        nonces.size === 256 &&
        recoveries.size === 256,
      mutationFailures,
      numericFailures,
      openedMatches,
      resourceFailures,
      transpiler: manifest.transpiler,
    };
  });

  expect(result.envelopeMatches).toBe(true);
  expect(result.openedMatches).toBe(true);
  expect(result.contextMatches).toBe(true);
  expect(result.contextMutationFailures).toEqual([]);
  expect(result.numericFailures).toEqual([]);
  expect(result.resourceFailures).toEqual([]);
  expect(result.goldenInputWiped).toBe(true);
  expect(result.goldenSecretWiped).toBe(true);
  expect(result.goldenOpenedWiped).toBe(true);
  expect(result.contextInputWiped).toBe(true);
  expect(result.mutationFailures).toEqual([]);
  expect(result.malformedRecovery).toEqual({
    code: "authentication-failed",
    message: "Backup authentication failed.",
  });
  expect(result.materialShapeValid).toBe(true);
  expect(result.materialUnique).toBe(true);
  expect(result.freshRoundTrip).toBe(true);
  expect(result.freshInputWiped).toBe(true);
  expect(result.freshOpenedWiped).toBe(true);
  expect(result.loadedCoreModules).toEqual(["notebook-core.core.wasm"]);
  expect(result.transpiler).toBe("@bytecodealliance/jco-transpile@0.4.2");
  expect(result.componentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(blockedRequests).toEqual([]);
  expect(consoleMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});
