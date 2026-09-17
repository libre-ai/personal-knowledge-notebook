import { downloadEncryptedBackup } from "./download";
import type { NotebookBackupPersistence } from "./indexed-db";
import { closedBackupRefusal, encodeRecoveryCode, freshBytes, type RandomSource } from "./material";
import type { NotebookBackupHost } from "./operation-host";
import { NotebookBackupRefusal, type OpenedBackup, type RestoredBackupMetadata } from "./types";

export type NotebookSnapshotProvider = () => Promise<Uint8Array> | Uint8Array;
export type NotebookRestoreConsumer = (opened: OpenedBackup) => Promise<void> | void;
export type BackupDownload = (envelope: Uint8Array) => Promise<void>;

export type NotebookBackupControllerOptions = {
  download?: BackupDownload;
  host: Pick<NotebookBackupHost, "createBackup" | "openBackupForUse">;
  persistence: NotebookBackupPersistence;
  randomSource?: RandomSource;
  restoreConsumer: NotebookRestoreConsumer;
  snapshotProvider: NotebookSnapshotProvider;
};

export class NotebookBackupController {
  readonly #download: BackupDownload;
  readonly #host: Pick<NotebookBackupHost, "createBackup" | "openBackupForUse">;
  readonly #persistence: NotebookBackupPersistence;
  readonly #randomSource: RandomSource;
  readonly #restoreConsumer: NotebookRestoreConsumer;
  readonly #snapshotProvider: NotebookSnapshotProvider;

  constructor(options: NotebookBackupControllerOptions) {
    this.#download = options.download ?? downloadEncryptedBackup;
    this.#host = options.host;
    this.#persistence = options.persistence;
    this.#randomSource = options.randomSource ?? globalThis.crypto;
    this.#restoreConsumer = options.restoreConsumer;
    this.#snapshotProvider = options.snapshotProvider;
  }

  async createBackup(publishRecoveryCode: (recoveryCode: string) => void): Promise<void> {
    let plaintext: Uint8Array | undefined;
    let envelope: Uint8Array | undefined;
    try {
      plaintext = await this.#snapshotProvider();
      if (!(plaintext instanceof Uint8Array)) {
        throw new NotebookBackupRefusal("internal-failure");
      }
      const created = await this.#host.createBackup(plaintext);
      envelope = created.envelope;
      await this.#persistence.recordEncryptedBackup(envelope);
      await this.#download(envelope);
      publishRecoveryCode(created.recoveryCode);
    } catch (error) {
      throw closedBackupRefusal(error);
    } finally {
      wipeView(plaintext);
      wipeView(envelope);
    }
  }

  async restoreBackup(envelope: Uint8Array, recoveryCode: string): Promise<RestoredBackupMetadata> {
    const operationId = freshOperationId(this.#randomSource);
    let staged = false;
    try {
      await this.#persistence.stageEncryptedRestore(operationId, envelope);
      staged = true;
      const restored = await this.#host.openBackupForUse(envelope, recoveryCode, async (opened) => {
        await this.#restoreConsumer(opened);
      });
      await this.#persistence.commitRestore(operationId, restored.metadata);
      staged = false;
      return restored.metadata;
    } catch (error) {
      if (staged) {
        try {
          await this.#persistence.discardRestore(operationId);
        } catch {
          // Startup recovery removes encrypted staging after a failed cleanup.
        }
      }
      throw closedBackupRefusal(error);
    } finally {
      wipeView(envelope);
    }
  }

  recoverInterruptedRestores(): Promise<number> {
    return this.#persistence.recoverInterruptedRestores();
  }
}

function freshOperationId(randomSource: RandomSource): string {
  const bytes = freshBytes(16, randomSource);
  try {
    return `op_${encodeRecoveryCode(bytes)}`;
  } finally {
    bytes.fill(0);
  }
}

function wipeView(view: Uint8Array | undefined): void {
  try {
    view?.fill(0);
  } catch {
    // Transferring ownership detaches the source buffer.
  }
}
