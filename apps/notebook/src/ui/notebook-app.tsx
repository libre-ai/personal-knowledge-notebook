import { SkipLink, StatusMessage, Surface } from "@libre-ai/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { NotebookBackupController } from "../backup/controller";
import { NOTEBOOK_BACKUP_FEATURE_ENABLED } from "../backup/feature";
import { IndexedDbNotebookBackupPersistence } from "../backup/indexed-db";
import { NotebookBackupHost } from "../backup/operation-host";
import { verifyNotebookBackupRuntime } from "../backup/preflight";
import {
  consumePublicNotebookSnapshot,
  createPublicNotebookSnapshot,
} from "../backup/public-fixture";
import { NotebookBackupRefusal } from "../backup/types";

const MAX_ENVELOPE_BYTES = 22_370_044;

type UiStatus = {
  message: string;
  tone: "error" | "neutral" | "success";
};

export function NotebookApp() {
  const controller = useRef<NotebookBackupController | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [restoreCode, setRestoreCode] = useState("");
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [status, setStatus] = useState<UiStatus>({
    message: NOTEBOOK_BACKUP_FEATURE_ENABLED
      ? "Vérification locale des capacités et du quota…"
      : "La sauvegarde Notebook est désactivée.",
    tone: "neutral",
  });

  const getController = (): NotebookBackupController => {
    if (!controller.current) {
      controller.current = new NotebookBackupController({
        host: new NotebookBackupHost(),
        persistence: new IndexedDbNotebookBackupPersistence(),
        restoreConsumer: consumePublicNotebookSnapshot,
        snapshotProvider: createPublicNotebookSnapshot,
      });
    }
    return controller.current;
  };

  useEffect(() => {
    setHydrated(true);
    if (!NOTEBOOK_BACKUP_FEATURE_ENABLED) return;
    let cancelled = false;
    void verifyNotebookBackupRuntime()
      .then(() => getController().recoverInterruptedRestores())
      .then((removed) => {
        if (cancelled) return;
        setRuntimeReady(true);
        setStatus(
          removed > 0
            ? {
                message: "Une restauration interrompue a été nettoyée sans libérer de plaintext.",
                tone: "success",
              }
            : {
                message: "Le host est prêt pour les fixtures publiques Gate B.",
                tone: "neutral",
              },
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus(refusalStatus(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const createBackup = async (): Promise<void> => {
    if (busy || !hydrated || !runtimeReady || !NOTEBOOK_BACKUP_FEATURE_ENABLED) return;
    setBusy(true);
    setRecoveryCode("");
    setStatus({ message: "Création de la sauvegarde chiffrée…", tone: "neutral" });
    try {
      await getController().createBackup((code) => setRecoveryCode(code));
      setStatus({
        message: "Sauvegarde chiffrée téléchargée sous un nom neutre.",
        tone: "success",
      });
    } catch (error) {
      setStatus(refusalStatus(error));
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || !hydrated || !runtimeReady || !NOTEBOOK_BACKUP_FEATURE_ENABLED) return;
    if (!file || file.size < 1 || file.size > MAX_ENVELOPE_BYTES) {
      setRestoreCode("");
      setStatus({ message: "Invalid backup envelope.", tone: "error" });
      return;
    }
    setBusy(true);
    setStatus({ message: "Vérification et restauration de la sauvegarde…", tone: "neutral" });
    let envelope: Uint8Array | undefined;
    try {
      envelope = new Uint8Array(await file.arrayBuffer());
      await getController().restoreBackup(envelope, restoreCode);
      setRestoreCode("");
      setStatus({
        message: "Sauvegarde authentifiée et reçu de restauration validé.",
        tone: "success",
      });
    } catch (error) {
      setStatus(refusalStatus(error));
    } finally {
      try {
        envelope?.fill(0);
      } catch {
        // The worker owns a successfully transferred envelope.
      }
      setRestoreCode("");
      setBusy(false);
    }
  };

  return (
    <>
      <SkipLink targetId="notebook-main" />
      <header className="notebook-header">
        <p className="notebook-eyebrow">Libre AI · Notebook</p>
        <h1>Host de sauvegarde locale</h1>
        <p>
          Aucun contenu n’est envoyé à un serveur. La fonctionnalité reste fermée tant que Gate B
          n’est pas approuvée.
        </p>
      </header>
      <main id="notebook-main" className="notebook-main">
        {!NOTEBOOK_BACKUP_FEATURE_ENABLED ? (
          <Surface aria-labelledby="backup-disabled-title">
            <h2 id="backup-disabled-title">Sauvegarde indisponible</h2>
            <p>Le feature gate produit est désactivé par défaut.</p>
          </Surface>
        ) : (
          <>
            <Surface aria-labelledby="gate-b-title">
              <h2 id="gate-b-title">Fixture publique Gate B</h2>
              <p>
                Cette interface exerce le worker produit jetable, IndexedDB et le téléchargement.
                Elle n’accepte aucune donnée utilisateur pendant la qualification.
              </p>
              <button
                className="lai-button lai-button--primary"
                disabled={busy || !hydrated || !runtimeReady}
                onClick={() => void createBackup()}
                type="button"
              >
                Créer une sauvegarde d’essai
              </button>
              {recoveryCode ? (
                <div className="notebook-recovery" data-testid="recovery-panel">
                  <h3>Code de récupération à conserver séparément</h3>
                  <output data-testid="recovery-code">{recoveryCode}</output>
                  <p>
                    Ce code n’est ni enregistré dans IndexedDB, ni inclus dans le nom du fichier.
                  </p>
                  <button
                    className="lai-button lai-button--quiet"
                    disabled={busy || !hydrated || !runtimeReady}
                    onClick={() => setRecoveryCode("")}
                    type="button"
                  >
                    Masquer le code
                  </button>
                </div>
              ) : null}
            </Surface>

            <Surface aria-labelledby="restore-title">
              <h2 id="restore-title">Restaurer la fixture</h2>
              <form onSubmit={(event) => void restoreBackup(event)}>
                <label htmlFor="backup-file">Fichier de sauvegarde</label>
                <input
                  accept=".lai,application/vnd.libre-ai.notebook-backup+json,application/json"
                  disabled={busy || !hydrated || !runtimeReady}
                  id="backup-file"
                  name="backup-file"
                  onChange={(event) => setFile(event.currentTarget.files?.item(0) ?? null)}
                  required
                  type="file"
                />
                <label htmlFor="recovery-code">Code de récupération</label>
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  disabled={busy || !hydrated || !runtimeReady}
                  id="recovery-code"
                  inputMode="text"
                  maxLength={34}
                  minLength={30}
                  name="recovery-code"
                  onChange={(event) => setRestoreCode(event.currentTarget.value)}
                  required
                  spellCheck={false}
                  type="password"
                  value={restoreCode}
                />
                <button
                  className="lai-button lai-button--primary"
                  disabled={busy || !hydrated || !runtimeReady}
                  type="submit"
                >
                  Restaurer la sauvegarde
                </button>
              </form>
            </Surface>
          </>
        )}
        <StatusMessage
          className={`notebook-status notebook-status--${status.tone}`}
          data-testid="backup-status"
          politeness={status.tone === "error" ? "assertive" : "polite"}
        >
          {status.message}
        </StatusMessage>
      </main>
    </>
  );
}

function refusalStatus(error: unknown): UiStatus {
  const refusal =
    error instanceof NotebookBackupRefusal ? error : new NotebookBackupRefusal("internal-failure");
  return { message: refusal.message, tone: "error" };
}
