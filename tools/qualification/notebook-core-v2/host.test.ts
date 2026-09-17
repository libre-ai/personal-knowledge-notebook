import { describe, expect, test } from "bun:test";
import {
  canonicalizeOwned,
  decodeRecoveryCode,
  ERROR_MESSAGES,
  freshOpaqueId,
  generateFreshSealMaterial,
  type NotebookCoreApi,
  NotebookHostRefusal,
  openForUse,
  type RandomSource,
  type SealBackupRequest,
  sealOwned,
} from "./host";

const zeros = (value: Uint8Array): boolean => value.every((byte) => byte === 0);

function refusal(action: () => unknown): NotebookHostRefusal {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(NotebookHostRefusal);
    return error as NotebookHostRefusal;
  }
  throw new Error("expected a closed host refusal");
}

describe("Notebook qualification host", () => {
  test("decodes only the exact recovery profile", () => {
    expect(decodeRecoveryCode("202122232425262728292a2b2c2d2e2f")).toEqual(
      Uint8Array.from({ length: 16 }, (_, index) => index + 32),
    );
    for (const invalid of [
      "202122232425262728292A2B2C2D2E2F",
      " 202122232425262728292a2b2c2d2e2f",
      "202122232425262728292a2b2c2d2e2f\n",
      "202122232425262728292a2b2c2d2e",
      "202122232425262728292a2b2c2d2e2f00",
    ]) {
      const error = refusal(() => decodeRecoveryCode(invalid));
      expect(error.code).toBe("authentication-failed");
      expect(error.message).toBe(ERROR_MESSAGES["authentication-failed"]);
      expect(error.message).not.toContain(invalid);
    }
  });

  test("routes malformed recovery attempts through the component anti-oracle path", async () => {
    const lengths: number[] = [];
    const captured: Uint8Array[] = [];
    const api = {
      canonicalizeContext: (document: Uint8Array) => document,
      sealBackup: () => new Uint8Array(),
      openBackup(_envelope: Uint8Array, recoverySecret: Uint8Array) {
        lengths.push(recoverySecret.length);
        captured.push(recoverySecret);
        throw new Error("authentication-failed");
      },
    } satisfies NotebookCoreApi;
    for (const attempt of [
      "202122232425262728292a2b2c2d2e",
      "202122232425262728292a2b2c2d2e2f00",
      "202122232425262728292A2B2C2D2E2F",
      "invalid",
    ]) {
      try {
        await openForUse(api, new Uint8Array([1]), attempt, () => {});
        throw new Error("expected authentication refusal");
      } catch (error) {
        expect((error as NotebookHostRefusal).code).toBe("authentication-failed");
      }
    }
    expect(lengths).toEqual([15, 17, 15, 15]);
    expect(captured.every(zeros)).toBe(true);
  });

  test("wipes owned seal and Context inputs on failure without reflecting diagnostics", () => {
    const plaintext = new TextEncoder().encode("private plaintext");
    const secret = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const document = new TextEncoder().encode("private Context");
    const api = {
      canonicalizeContext() {
        throw new Error("private Context");
      },
      sealBackup() {
        throw new Error("private plaintext");
      },
      openBackup() {
        throw new Error("unreachable");
      },
    } satisfies NotebookCoreApi;
    const request = {
      schemaVersion: "libre-ai.notebook-backup-seal-request.v2",
      id: "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f",
      cipher: "aes-256-gcm",
      kdf: {
        algorithm: "argon2id",
        version: 19,
        memoryKib: 65_536,
        iterations: 3,
        parallelism: 1,
        outputLengthBytes: 32,
        salt: new Uint8Array(16),
      },
      nonce: new Uint8Array(12),
      plaintext,
    } satisfies SealBackupRequest;

    const sealError = refusal(() => sealOwned(api, request, secret));
    expect(sealError.code).toBe("internal-failure");
    expect(sealError.message).toBe(ERROR_MESSAGES["internal-failure"]);
    expect(sealError.message).not.toContain("private plaintext");
    expect(zeros(plaintext)).toBe(true);
    expect(zeros(secret)).toBe(true);

    const contextError = refusal(() => canonicalizeOwned(api, document));
    expect(contextError.code).toBe("internal-failure");
    expect(contextError.message).not.toContain("private Context");
    expect(zeros(document)).toBe(true);
  });

  test("fails closed for hostile error accessors", () => {
    const document = new TextEncoder().encode("private Context");
    const hostileError = Object.create(null, {
      message: {
        get() {
          throw new Error("private accessor detail");
        },
      },
    });
    const api = {
      canonicalizeContext() {
        throw hostileError;
      },
      sealBackup: () => new Uint8Array(),
      openBackup() {
        throw new Error("unreachable");
      },
    } satisfies NotebookCoreApi;

    const error = refusal(() => canonicalizeOwned(api, document));
    expect(error.code).toBe("internal-failure");
    expect(error.message).toBe(ERROR_MESSAGES["internal-failure"]);
    expect(error.message).not.toContain("private accessor detail");
    expect(zeros(document)).toBe(true);
  });

  test("maps runtime allocation failures to the static resource refusal", () => {
    const document = new Uint8Array([1, 2, 3]);
    const api = {
      canonicalizeContext() {
        throw new RangeError("private allocation detail");
      },
      sealBackup: () => new Uint8Array(),
      openBackup() {
        throw new Error("unreachable");
      },
    } satisfies NotebookCoreApi;

    const error = refusal(() => canonicalizeOwned(api, document));
    expect(error.code).toBe("resource-limit-exceeded");
    expect(error.message).toBe(ERROR_MESSAGES["resource-limit-exceeded"]);
    expect(error.message).not.toContain("private allocation detail");
    expect(zeros(document)).toBe(true);
  });

  test("retains stable references to every owned plaintext buffer", async () => {
    const sealPlaintext = new TextEncoder().encode("private seal plaintext");
    const secret = new Uint8Array(16).fill(7);
    const replacementSealPlaintext = new Uint8Array([9]);
    const openedPlaintext = new TextEncoder().encode("private opened plaintext");
    const replacementOpenedPlaintext = new Uint8Array([8]);
    const api = {
      canonicalizeContext: (document: Uint8Array) => document,
      sealBackup(request: SealBackupRequest) {
        request.plaintext = replacementSealPlaintext;
        throw new Error("internal-failure");
      },
      openBackup() {
        return {
          schemaVersion: "libre-ai.notebook-backup.v2",
          id: "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f",
          digest: "0".repeat(64),
          plaintext: openedPlaintext,
        };
      },
    } satisfies NotebookCoreApi;
    const request = {
      schemaVersion: "libre-ai.notebook-backup-seal-request.v2",
      id: "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f",
      cipher: "aes-256-gcm",
      kdf: {
        algorithm: "argon2id",
        version: 19,
        memoryKib: 65_536,
        iterations: 3,
        parallelism: 1,
        outputLengthBytes: 32,
        salt: new Uint8Array(16),
      },
      nonce: new Uint8Array(12),
      plaintext: sealPlaintext,
    } satisfies SealBackupRequest;

    refusal(() => sealOwned(api, request, secret));
    expect(zeros(sealPlaintext)).toBe(true);
    expect(zeros(secret)).toBe(true);

    await openForUse(api, new Uint8Array([1]), "202122232425262728292a2b2c2d2e2f", (opened) => {
      opened.plaintext = replacementOpenedPlaintext;
    });
    expect(zeros(openedPlaintext)).toBe(true);
  });

  test("wipes decoded recovery and opened plaintext on error and success", async () => {
    let failedSecret: Uint8Array | undefined;
    const failedApi = {
      canonicalizeContext: (document: Uint8Array) => document,
      sealBackup: () => new Uint8Array(),
      openBackup(_envelope: Uint8Array, recoverySecret: Uint8Array) {
        failedSecret = recoverySecret;
        throw new Error("authentication-failed");
      },
    } satisfies NotebookCoreApi;
    try {
      await openForUse(
        failedApi,
        new Uint8Array([1]),
        "202122232425262728292a2b2c2d2e2f",
        () => {},
      );
      throw new Error("expected authentication refusal");
    } catch (error) {
      const hostError = error as NotebookHostRefusal;
      expect(hostError.code).toBe("authentication-failed");
      expect(hostError.message).toBe(ERROR_MESSAGES["authentication-failed"]);
    }
    expect(failedSecret).toBeDefined();
    expect(zeros(failedSecret ?? new Uint8Array([1]))).toBe(true);

    let openedPlaintext: Uint8Array | undefined;
    let successfulSecret: Uint8Array | undefined;
    const successfulApi = {
      canonicalizeContext: (document: Uint8Array) => document,
      sealBackup: () => new Uint8Array(),
      openBackup(_envelope: Uint8Array, recoverySecret: Uint8Array) {
        successfulSecret = recoverySecret;
        openedPlaintext = new TextEncoder().encode("private restored plaintext");
        return {
          schemaVersion: "libre-ai.notebook-backup.v2",
          id: "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f",
          digest: "0".repeat(64),
          plaintext: openedPlaintext,
        };
      },
    } satisfies NotebookCoreApi;
    const consumed = await openForUse(
      successfulApi,
      new Uint8Array([1]),
      "202122232425262728292a2b2c2d2e2f",
      (opened) => new TextDecoder().decode(opened.plaintext),
    );
    expect(consumed).toBe("private restored plaintext");
    expect(zeros(successfulSecret ?? new Uint8Array([1]))).toBe(true);
    expect(zeros(openedPlaintext ?? new Uint8Array([1]))).toBe(true);
  });

  test("wipes partial recovery material when the CSPRNG fails closed", () => {
    let allocatedRecovery: Uint8Array | undefined;
    let calls = 0;
    const failingRandom = {
      getRandomValues(array: ArrayBufferView | null) {
        if (!(array instanceof Uint8Array)) throw new TypeError("Uint8Array required");
        calls += 1;
        if (calls === 1) {
          array.fill(0x5a);
          allocatedRecovery = array;
          return array;
        }
        throw new Error("private random provider detail");
      },
    } as RandomSource;
    const error = refusal(() => generateFreshSealMaterial(failingRandom));
    expect(error.code).toBe("internal-failure");
    expect(error.message).toBe(ERROR_MESSAGES["internal-failure"]);
    expect(error.message).not.toContain("private random provider detail");
    expect(zeros(allocatedRecovery ?? new Uint8Array([1]))).toBe(true);
  });

  test("uses the supplied CSPRNG for opaque export material", () => {
    let counter = 0;
    const randomSource = {
      getRandomValues(array: ArrayBufferView | null) {
        if (!(array instanceof Uint8Array)) throw new TypeError("Uint8Array required");
        for (let index = 0; index < array.length; index += 1) {
          array[index] = counter & 0xff;
          counter += 1;
        }
        return array;
      },
    } as RandomSource;
    const material = generateFreshSealMaterial(randomSource);
    expect(material.recoveryCode).toBe("000102030405060708090a0b0c0d0e0f");
    expect(material.backupId).toBe("urn:libre-ai:backup:101112131415161718191a1b1c1d1e1f");
    expect(material.salt).toEqual(Uint8Array.from({ length: 16 }, (_, index) => index + 32));
    expect(material.nonce).toEqual(Uint8Array.from({ length: 12 }, (_, index) => index + 48));
    expect(freshOpaqueId("blk_", randomSource)).toBe("blk_3c3d3e3f404142434445464748494a4b");
    material.recoverySecret.fill(0);
  });
});
