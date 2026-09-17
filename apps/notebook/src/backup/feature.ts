export function isNotebookBackupFeatureEnabled(value: string | undefined): boolean {
  return value === "1";
}

export const NOTEBOOK_BACKUP_FEATURE_ENABLED = isNotebookBackupFeatureEnabled(
  process.env.NOTEBOOK_BACKUP_FEATURE_ENABLED,
);
