import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 30_000 },
  forbidOnly: true,
  fullyParallel: false,
  globalSetup: resolve(
    process.cwd(),
    "tools/qualification/notebook-core-v2/product-host-storage.global-setup.ts",
  ),
  globalTeardown: resolve(
    process.cwd(),
    "tools/qualification/notebook-core-v2/product-host-storage.global-teardown.ts",
  ),
  outputDir: resolve(process.cwd(), "target/notebook-product-host-storage/test-results"),
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  reporter: "line",
  retries: 0,
  testDir: ".",
  testMatch: "product-host-storage.playwright.ts",
  timeout: 300_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "bun run --cwd ../../../apps/notebook start",
    env: {
      HOST: "127.0.0.1",
      NOTEBOOK_BACKUP_FEATURE_ENABLED: "1",
      PORT: "4174",
    },
    port: 4174,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  workers: 1,
});
