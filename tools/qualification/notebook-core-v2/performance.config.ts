import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const root = resolve(process.cwd(), "tools/qualification/notebook-core-v2");

export default defineConfig({
  fullyParallel: false,
  globalSetup: resolve(root, "performance.global-setup.ts"),
  outputDir: `${root}/../../../target/notebook-core-v2-qualification/playwright-performance`,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  reporter: [["line"]],
  testDir: root,
  testMatch: "performance.playwright.ts",
  timeout: 1_800_000,
  use: {
    baseURL: "http://127.0.0.1:41773",
    serviceWorkers: "block",
  },
  webServer: {
    command: "bun serve.ts",
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:41773",
  },
  workers: 1,
});
