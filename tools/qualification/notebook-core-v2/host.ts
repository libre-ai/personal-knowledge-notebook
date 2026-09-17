export type ErrorCode =
  | "invalid-document"
  | "invalid-seal-request"
  | "invalid-envelope"
  | "unsupported-version"
  | "resource-limit-exceeded"
  | "authentication-failed"
  | "internal-failure";

export type Argon2idParameters = {
  algorithm: string;
  version: number;
  memoryKib: number;
  iterations: number;
  parallelism: number;
  outputLengthBytes: number;
  salt: Uint8Array;
};

export type SealBackupRequest = {
  schemaVersion: string;
  id: string;
  cipher: string;
  kdf: Argon2idParameters;
  nonce: Uint8Array;
  plaintext: Uint8Array;
};

export type OpenedBackup = {
  schemaVersion: string;
  id: string;
  digest: string;
  plaintext: Uint8Array;
};

export type NotebookCoreApi = {
  canonicalizeContext(document: Uint8Array): Uint8Array;
  sealBackup(request: SealBackupRequest, recoverySecret: Uint8Array): Uint8Array;
  openBackup(envelope: Uint8Array, recoverySecret: Uint8Array): OpenedBackup;
};

export type RandomSource = Pick<Crypto, "getRandomValues">;

export const ERROR_MESSAGES = Object.freeze({
  "invalid-document": "Invalid context document.",
  "invalid-seal-request": "Invalid backup seal request.",
  "invalid-envelope": "Invalid backup envelope.",
  "unsupported-version": "Unsupported backup version.",
  "resource-limit-exceeded": "Backup operation unavailable.",
  "authentication-failed": "Backup authentication failed.",
  "internal-failure": "Backup operation failed.",
} satisfies Record<ErrorCode, string>);

const ERROR_CODES = new Set<ErrorCode>(Object.keys(ERROR_MESSAGES) as ErrorCode[]);
const LOWERCASE_RECOVERY_CODE = /^[a-f0-9]{32}$/;
const HEX = "0123456789abcdef";

export class NotebookHostRefusal extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "NotebookHostRefusal";
    this.code = code;
  }
}

export function decodeRecoveryCode(value: string): Uint8Array {
  if (!LOWERCASE_RECOVERY_CODE.test(value)) {
    throw new NotebookHostRefusal("authentication-failed");
  }
  return decodeLowercaseHex(value);
}

export function encodeRecoveryCode(value: Uint8Array): string {
  if (value.length !== 16) throw new NotebookHostRefusal("internal-failure");
  let output = "";
  for (const byte of value) output += `${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
  return output;
}

export function freshBytes(
  length: number,
  randomSource: RandomSource = globalThis.crypto,
): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536 || !randomSource) {
    throw new NotebookHostRefusal("internal-failure");
  }
  return randomSource.getRandomValues(new Uint8Array(length));
}

export function freshOpaqueId(
  prefix: "urn:libre-ai:backup:" | "urn:libre-ai:context:" | "blk_",
  randomSource: RandomSource = globalThis.crypto,
): string {
  return `${prefix}${encodeRecoveryCode(freshBytes(16, randomSource))}`;
}

export type FreshSealMaterial = {
  backupId: string;
  salt: Uint8Array;
  nonce: Uint8Array;
  recoveryCode: string;
  recoverySecret: Uint8Array;
};

export function generateFreshSealMaterial(
  randomSource: RandomSource = globalThis.crypto,
): FreshSealMaterial {
  let recoverySecret: Uint8Array | undefined;
  try {
    recoverySecret = freshBytes(16, randomSource);
    return {
      backupId: freshOpaqueId("urn:libre-ai:backup:", randomSource),
      salt: freshBytes(16, randomSource),
      nonce: freshBytes(12, randomSource),
      recoveryCode: encodeRecoveryCode(recoverySecret),
      recoverySecret,
    };
  } catch (error) {
    recoverySecret?.fill(0);
    throw closedRefusal(error);
  }
}

export function canonicalizeOwned(api: NotebookCoreApi, document: Uint8Array): Uint8Array {
  try {
    return api.canonicalizeContext(document);
  } catch (error) {
    throw closedRefusal(error);
  } finally {
    document.fill(0);
  }
}

export function sealOwned(
  api: NotebookCoreApi,
  request: SealBackupRequest,
  recoverySecret: Uint8Array,
): Uint8Array {
  const ownedPlaintext = request.plaintext;
  try {
    return api.sealBackup(request, recoverySecret);
  } catch (error) {
    throw closedRefusal(error);
  } finally {
    ownedPlaintext.fill(0);
    recoverySecret.fill(0);
  }
}

export function sealFreshOwned(
  api: NotebookCoreApi,
  plaintext: Uint8Array,
  randomSource: RandomSource = globalThis.crypto,
): { envelope: Uint8Array; recoveryCode: string } {
  const material = generateFreshSealMaterial(randomSource);
  const request: SealBackupRequest = {
    schemaVersion: "libre-ai.notebook-backup-seal-request.v2",
    id: material.backupId,
    cipher: "aes-256-gcm",
    kdf: {
      algorithm: "argon2id",
      version: 19,
      memoryKib: 65_536,
      iterations: 3,
      parallelism: 1,
      outputLengthBytes: 32,
      salt: material.salt,
    },
    nonce: material.nonce,
    plaintext,
  };
  return {
    envelope: sealOwned(api, request, material.recoverySecret),
    recoveryCode: material.recoveryCode,
  };
}

export async function openForUse<Result>(
  api: NotebookCoreApi,
  envelope: Uint8Array,
  recoveryCode: string,
  consume: (opened: OpenedBackup) => Result | Promise<Result>,
): Promise<Result> {
  const recoverySecret = decodeRecoveryAttempt(recoveryCode);
  let opened: OpenedBackup;
  try {
    opened = api.openBackup(envelope, recoverySecret);
  } catch (error) {
    throw closedRefusal(error);
  } finally {
    recoverySecret.fill(0);
  }

  const ownedPlaintext = opened.plaintext;
  try {
    return await consume(opened);
  } finally {
    ownedPlaintext.fill(0);
  }
}

function decodeLowercaseHex(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    const offset = index * 2;
    output[index] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return output;
}

function decodeRecoveryAttempt(value: string): Uint8Array {
  if ([30, 32, 34].includes(value.length) && /^[a-f0-9]+$/.test(value)) {
    return decodeLowercaseHex(value);
  }
  // A syntax-level refusal still enters the component with an invalid-size
  // secret so Argon2id/AES execute before the closed authentication error.
  return new Uint8Array(15);
}

export function closedRefusal(error: unknown): NotebookHostRefusal {
  if (error instanceof NotebookHostRefusal) return error;
  if (error instanceof RangeError) {
    return new NotebookHostRefusal("resource-limit-exceeded");
  }
  let message: unknown;
  try {
    message =
      typeof error === "object" && error !== null && "message" in error
        ? Reflect.get(error, "message")
        : undefined;
  } catch {
    message = undefined;
  }
  const code: ErrorCode | null =
    typeof message === "string" && ERROR_CODES.has(message as ErrorCode)
      ? (message as ErrorCode)
      : null;
  return new NotebookHostRefusal(code ?? "internal-failure");
}
