export type NotebookCoreErrorCode =
  | "invalid-document"
  | "invalid-seal-request"
  | "invalid-envelope"
  | "unsupported-version"
  | "resource-limit-exceeded"
  | "authentication-failed"
  | "internal-failure";

export const NOTEBOOK_BACKUP_ERROR_MESSAGES = Object.freeze({
  "invalid-document": "Invalid context document.",
  "invalid-seal-request": "Invalid backup seal request.",
  "invalid-envelope": "Invalid backup envelope.",
  "unsupported-version": "Unsupported backup version.",
  "resource-limit-exceeded": "Backup operation unavailable.",
  "authentication-failed": "Backup authentication failed.",
  "internal-failure": "Backup operation failed.",
} satisfies Record<NotebookCoreErrorCode, string>);

export class NotebookBackupRefusal extends Error {
  readonly code: NotebookCoreErrorCode;

  constructor(code: NotebookCoreErrorCode) {
    super(NOTEBOOK_BACKUP_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = "NotebookBackupRefusal";
  }
}

export type Argon2idParameters = {
  algorithm: "argon2id";
  iterations: 3;
  memoryKib: 65_536;
  outputLengthBytes: 32;
  parallelism: 1;
  salt: Uint8Array;
  version: 19;
};

export type SealBackupRequest = {
  cipher: "aes-256-gcm";
  id: string;
  kdf: Argon2idParameters;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  schemaVersion: "libre-ai.notebook-backup-seal-request.v2";
};

export type OpenedBackup = {
  digest: string;
  id: string;
  plaintext: Uint8Array;
  schemaVersion: string;
};

export type NotebookCoreApi = {
  openBackup(envelope: Uint8Array, recoverySecret: Uint8Array): OpenedBackup;
  sealBackup(request: SealBackupRequest, recoverySecret: Uint8Array): Uint8Array;
};

export type CreatedBackup = {
  envelope: Uint8Array;
  recoveryCode: string;
};

export type RestoredBackupMetadata = {
  digest: string;
  id: string;
  schemaVersion: string;
};
