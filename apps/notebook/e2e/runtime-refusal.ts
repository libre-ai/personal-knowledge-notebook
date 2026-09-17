import { expect, type Page } from "@playwright/test";

export async function assertUnavailableRuntime(page: Page): Promise<void> {
  let workers = 0;
  let downloads = 0;
  page.on("worker", () => { workers += 1; });
  page.on("download", () => { downloads += 1; });
  await page.goto("/");
  await expect(page.getByTestId("backup-status")).toHaveText("Backup operation unavailable.");
  await expect(page.getByRole("button", { name: "Créer une sauvegarde d’essai" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Restaurer la sauvegarde" })).toBeDisabled();
  await expect(page.locator("#backup-file")).toBeDisabled();
  await expect(page.locator("#recovery-code")).toBeDisabled();
  expect(workers).toBe(0);
  expect(downloads).toBe(0);
}
