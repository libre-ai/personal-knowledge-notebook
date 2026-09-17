import { closedBackupRefusal } from "./material";
import { NotebookBackupRefusal, type RestoredBackupMetadata } from "./types";

const DATABASE_NAME = "libre-ai-notebook";
const DATABASE_VERSION = 1;
const STORE_NAME = "backup-runtime";
const LATEST_BACKUP_KEY = "encrypted-backup:latest";
const LATEST_RESTORE_KEY = "restore-receipt:latest";
const OPERATION_ID = /^op_[a-f0-9]{32}$/;
const MAX_ENVELOPE_BYTES = 22_370_044;
const TRANSACTION_DEADLINE_MS = 10_000;

export type RestoreReceipt = RestoredBackupMetadata & {
  operationId: string;
};

export interface NotebookBackupPersistence {
  commitRestore(operationId: string, metadata: RestoredBackupMetadata): Promise<void>;
  discardRestore(operationId: string): Promise<void>;
  recordEncryptedBackup(envelope: Uint8Array): Promise<void>;
  recoverInterruptedRestores(): Promise<number>;
  stageEncryptedRestore(operationId: string, envelope: Uint8Array): Promise<void>;
}

type EncryptedBackupRecord = {
  envelope: Uint8Array;
  key: typeof LATEST_BACKUP_KEY;
  kind: "encrypted-backup";
};

type PendingRestoreRecord = {
  envelope: Uint8Array;
  key: string;
  kind: "pending-restore";
  operationId: string;
};

type RestoreReceiptRecord = RestoreReceipt & {
  key: typeof LATEST_RESTORE_KEY;
  kind: "restore-receipt";
};

export class IndexedDbNotebookBackupPersistence implements NotebookBackupPersistence {
  readonly #factory: IDBFactory;

  constructor(factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new NotebookBackupRefusal("resource-limit-exceeded");
    this.#factory = factory;
  }

  async recordEncryptedBackup(envelope: Uint8Array): Promise<void> {
    assertEnvelope(envelope);
    await this.#put({ envelope, key: LATEST_BACKUP_KEY, kind: "encrypted-backup" });
  }

  async stageEncryptedRestore(operationId: string, envelope: Uint8Array): Promise<void> {
    assertOperationId(operationId);
    assertEnvelope(envelope);
    await this.#put({
      envelope,
      key: pendingKey(operationId),
      kind: "pending-restore",
      operationId,
    });
  }

  async commitRestore(operationId: string, metadata: RestoredBackupMetadata): Promise<void> {
    assertOperationId(operationId);
    assertMetadata(metadata);
    const database = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite", {
        durability: "strict",
      });
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(pendingKey(operationId));
      let validPending = false;
      const timeout = abortAfterDeadline(transaction);
      request.onsuccess = () => {
        const pending = request.result as Partial<PendingRestoreRecord> | undefined;
        validPending = pending?.kind === "pending-restore" && pending.operationId === operationId;
        if (!validPending) {
          transaction.abort();
          return;
        }
        store.delete(pendingKey(operationId));
        store.put({
          ...metadata,
          key: LATEST_RESTORE_KEY,
          kind: "restore-receipt",
          operationId,
        } satisfies RestoreReceiptRecord);
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => {
        clearTimeout(timeout);
        database.close();
        resolve();
      };
      transaction.onabort = () => {
        clearTimeout(timeout);
        database.close();
        reject(
          new NotebookBackupRefusal(validPending ? "resource-limit-exceeded" : "internal-failure"),
        );
      };
      transaction.onerror = () => undefined;
    }).catch((error) => {
      throw closedBackupRefusal(error);
    });
  }

  async discardRestore(operationId: string): Promise<void> {
    assertOperationId(operationId);
    await this.#delete(pendingKey(operationId));
  }

  async recoverInterruptedRestores(): Promise<number> {
    const database = await this.#open();
    return new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite", {
        durability: "strict",
      });
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openKeyCursor(IDBKeyRange.bound("pending:", "pending:\uffff"));
      let removed = 0;
      const timeout = abortAfterDeadline(transaction);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        removed += 1;
        cursor.continue();
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => {
        clearTimeout(timeout);
        database.close();
        resolve(removed);
      };
      transaction.onabort = () => {
        clearTimeout(timeout);
        database.close();
        reject(new NotebookBackupRefusal("resource-limit-exceeded"));
      };
      transaction.onerror = () => undefined;
    }).catch((error) => {
      throw closedBackupRefusal(error);
    });
  }

  async #put(
    record: EncryptedBackupRecord | PendingRestoreRecord | RestoreReceiptRecord,
  ): Promise<void> {
    const database = await this.#open();
    await transactionCompletion(
      database,
      () => database.transaction(STORE_NAME, "readwrite", { durability: "strict" }),
      (transaction) => {
        transaction.objectStore(STORE_NAME).put(record);
      },
    );
  }

  async #delete(key: string): Promise<void> {
    const database = await this.#open();
    await transactionCompletion(
      database,
      () => database.transaction(STORE_NAME, "readwrite", { durability: "strict" }),
      (transaction) => {
        transaction.objectStore(STORE_NAME).delete(key);
      },
    );
  }

  #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: IDBOpenDBRequest;
      try {
        request = this.#factory.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (error) {
        reject(closedBackupRefusal(error));
        return;
      }
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new NotebookBackupRefusal("resource-limit-exceeded"));
      }, TRANSACTION_DEADLINE_MS);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new NotebookBackupRefusal("resource-limit-exceeded"));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new NotebookBackupRefusal("resource-limit-exceeded"));
      };
    });
  }
}

async function transactionCompletion(
  database: IDBDatabase,
  create: () => IDBTransaction,
  execute: (transaction: IDBTransaction) => void,
): Promise<void> {
  try {
    const transaction = create();
    await new Promise<void>((resolve, reject) => {
      const timeout = abortAfterDeadline(transaction);
      transaction.oncomplete = () => {
        clearTimeout(timeout);
        resolve();
      };
      transaction.onabort = () => {
        clearTimeout(timeout);
        reject(new NotebookBackupRefusal("resource-limit-exceeded"));
      };
      transaction.onerror = () => undefined;
      try {
        execute(transaction);
      } catch (error) {
        clearTimeout(timeout);
        try {
          transaction.abort();
        } catch {
          // The closed error below remains authoritative.
        }
        reject(closedBackupRefusal(error));
      }
    });
  } catch (error) {
    throw closedBackupRefusal(error);
  } finally {
    database.close();
  }
}

function abortAfterDeadline(transaction: IDBTransaction): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    try {
      transaction.abort();
    } catch {
      // A completed transaction needs no further action.
    }
  }, TRANSACTION_DEADLINE_MS);
}

function pendingKey(operationId: string): string {
  return `pending:${operationId}`;
}

function assertOperationId(value: string): void {
  if (!OPERATION_ID.test(value)) throw new NotebookBackupRefusal("internal-failure");
}

function assertEnvelope(value: Uint8Array): void {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteOffset !== 0 ||
    value.byteLength !== value.buffer.byteLength ||
    value.byteLength < 1 ||
    value.byteLength > MAX_ENVELOPE_BYTES
  ) {
    try {
      value.fill(0);
    } catch {
      // Reject partial, detached or hostile views before IndexedDB can clone a backing buffer.
    }
    throw new NotebookBackupRefusal("resource-limit-exceeded");
  }
}

function assertMetadata(value: RestoredBackupMetadata): void {
  if (
    !/^urn:libre-ai:backup:[a-f0-9]{32}$/.test(value.id) ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    value.schemaVersion !== "libre-ai.notebook-backup.v2"
  ) {
    throw new NotebookBackupRefusal("internal-failure");
  }
}
