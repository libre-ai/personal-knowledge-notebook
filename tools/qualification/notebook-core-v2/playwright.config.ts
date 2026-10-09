import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: resolve(process.cwd(), "target/notebook-core-v2-qualification/test-results"),
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // TODO(playwright-1.64): remove once @playwright/test >= 1.64.0 (microsoft/playwright#42731) — Juggler loses a message on COOP-triggered context replacement.
        launchOptions: {
          firefoxUserPrefs: { "browser.tabs.remote.useCrossOriginOpenerPolicy": false },
        },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  reporter: "line",
  retries: 0,
  testDir: ".",
  testMatch: ["browser.playwright.ts", "faults.playwright.ts"],
  timeout: 180_000,
  use: {
    baseURL: "http://127.0.0.1:41773",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "bun serve.ts",
    port: 41_773,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  workers: 1,
});
