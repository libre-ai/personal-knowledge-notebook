import { expect, test } from "@playwright/test";

test("never submits recovery material before hydration", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Créer une sauvegarde d’essai" })).toBeDisabled();
  await expect(page.locator("#backup-file")).toBeDisabled();
  await expect(page.locator("#recovery-code")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Restaurer la sauvegarde" })).toBeDisabled();
  expect(page.url()).toBe("http://127.0.0.1:4174/");
});
