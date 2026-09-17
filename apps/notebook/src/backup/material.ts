import {
  NOTEBOOK_BACKUP_ERROR_MESSAGES,
  NotebookBackupRefusal,
  type NotebookCoreErrorCode,
} from "./types";

export type RandomSource = Pick<Crypto, "getRandomValues">;

const ERROR_CODES = new Set<NotebookCoreErrorCode>(
  Object.keys(NOTEBOOK_BACKUP_ERROR_MESSAGES) as NotebookCoreErrorCode[],
);
const HEX = "0123456789abcdef";
const LOWERCASE_RECOVERY_CODE = /^[a-f0-9]{32}$/;

export function freshBytes(length: number, randomSource: RandomSource = globalThis.crypto) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536 || !randomSource) {
    throw new NotebookBackupRefusal("internal-failure");
  }
  try {
    return randomSource.getRandomValues(new Uint8Array(length));
  } catch (error) {
    throw closedBackupRefusal(error);
  }
}

export function encodeRecoveryCode(value: Uint8Array): string {
  if (value.length !== 16) throw new NotebookBackupRefusal("internal-failure");
  let output = "";
  for (const byte of value) output += `${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
  return output;
}

export function freshBackupId(randomSource: RandomSource = globalThis.crypto): string {
  const bytes = freshBytes(16, randomSource);
  try {
    return `urn:libre-ai:backup:${encodeRecoveryCode(bytes)}`;
  } finally {
    bytes.fill(0);
  }
}

export function decodeRecoveryAttempt(value: string): Uint8Array {
  if ([30, 32, 34].includes(value.length) && /^[a-f0-9]+$/.test(value)) {
    return decodeLowercaseHex(value);
  }
  return new Uint8Array(15);
}

export function isCanonicalRecoveryCode(value: string): boolean {
  return LOWERCASE_RECOVERY_CODE.test(value);
}

export function closedBackupRefusal(error: unknown): NotebookBackupRefusal {
  if (error instanceof NotebookBackupRefusal) return error;
  if (error instanceof RangeError) return new NotebookBackupRefusal("resource-limit-exceeded");

  let message: unknown;
  try {
    message =
      typeof error === "object" && error !== null && "message" in error
        ? Reflect.get(error, "message")
        : undefined;
  } catch {
    message = undefined;
  }
  return new NotebookBackupRefusal(
    typeof message === "string" && ERROR_CODES.has(message as NotebookCoreErrorCode)
      ? (message as NotebookCoreErrorCode)
      : "internal-failure",
  );
}

function decodeLowercaseHex(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    const offset = index * 2;
    output[index] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return output;
}
