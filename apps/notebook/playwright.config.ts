import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      testMatch: /backup-host\.e2e\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testMatch: /backup-host\.e2e\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testMatch: /backup-host\.e2e\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "chromium-no-js",
      testMatch: /no-js\.e2e\.ts/,
      use: { ...devices["Desktop Chrome"], javaScriptEnabled: false },
    },
  ],
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run start",
    env: {
      HOST: "127.0.0.1",
      NOTEBOOK_BACKUP_FEATURE_ENABLED: "1",
      PORT: "4174",
    },
    port: 4174,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
