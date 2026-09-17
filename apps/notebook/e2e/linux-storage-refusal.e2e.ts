import { expect, test } from "@playwright/test";
import { assertUnavailableRuntime } from "./runtime-refusal";

test("Linux WebKit without storage estimate refuses backup before creating a worker", async ({ page }) => {
  // This is the unmodified Linux engine capability, never a synthetic quota fallback.
  await assertUnavailableRuntime(page);
  expect(await page.evaluate(() => typeof navigator.storage?.estimate)).toBe("undefined");
});
