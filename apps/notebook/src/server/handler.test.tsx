import { describe, expect, test } from "bun:test";
import { createNotebookHandler } from "./handler";

describe("Notebook product server boundary", () => {
  test("keeps the backup feature disabled by default", async () => {
    const handler = createNotebookHandler(
      "/tmp/notebook-missing-dist",
      () => "req_1234567890abcdef",
    );

    const page = await handler(new Request("https://notebook.local/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Le feature gate produit est désactivé par défaut.");

    const core = await handler(
      new Request("https://notebook.local/assets/notebook-core.core.wasm"),
    );
    expect(core.status).toBe(404);

    const application = await handler(new Request("https://notebook.local/assets/app.js"));
    expect(application.headers.get("Cache-Control")).toBe("no-store");
  });

  test("returns only static feature state and strict browser headers", async () => {
    const handler = createNotebookHandler(
      "/tmp/notebook-missing-dist",
      () => "req_1234567890abcdef",
    );
    const response = await handler(new Request("https://notebook.local/api/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      backupFeature: "disabled",
      service: "libre-ai-notebook",
      status: "ok",
      version: "v1",
    });
    expect(response.headers.get("Content-Security-Policy")).toContain("worker-src 'self'");
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
  });
});
