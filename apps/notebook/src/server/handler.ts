import { join } from "node:path";
import { createRequestHandler, renderSsrDocument, type StaticAsset } from "@libre-ai/web-platform";
import { NOTEBOOK_BACKUP_FEATURE_ENABLED } from "../backup/feature";
import { notebookDocument } from "../shared/document";

export function createNotebookHandler(
  distRoot = join(import.meta.dir, "../../dist"),
  requestId = () => `req_${crypto.randomUUID().replaceAll("-", "")}`,
) {
  const assets: Record<string, StaticAsset> = {
    "/assets/app.js": {
      body: Bun.file(join(distRoot, "assets/app.js")),
      cacheControl: "no-store",
      contentType: "text/javascript; charset=utf-8",
    },
    "/assets/icon.svg": {
      body: Bun.file(join(distRoot, "assets/icon.svg")),
      cacheControl: "public, max-age=300",
      contentType: "image/svg+xml",
    },
    "/assets/tokens.css": {
      body: Bun.file(join(distRoot, "assets/tokens.css")),
      contentType: "text/css; charset=utf-8",
    },
    "/assets/styles.css": {
      body: Bun.file(join(distRoot, "assets/styles.css")),
      contentType: "text/css; charset=utf-8",
    },
    "/manifest.webmanifest": {
      body: Bun.file(join(distRoot, "manifest.webmanifest")),
      contentType: "application/manifest+json",
    },
    "/static": {
      body: Bun.file(join(distRoot, "static/index.html")),
      contentType: "text/html; charset=utf-8",
    },
  };
  if (NOTEBOOK_BACKUP_FEATURE_ENABLED) {
    assets["/assets/notebook-core-worker.js"] = {
      body: Bun.file(join(distRoot, "assets/notebook-core-worker.js")),
      contentType: "text/javascript; charset=utf-8",
    };
    assets["/assets/notebook-core.js"] = {
      body: Bun.file(join(distRoot, "assets/notebook-core.js")),
      contentType: "text/javascript; charset=utf-8",
    };
    assets["/assets/notebook-core.core.wasm"] = {
      body: Bun.file(join(distRoot, "assets/notebook-core.core.wasm")),
      contentType: "application/wasm",
    };
  }

  const handler = createRequestHandler({
    assets,
    requestId,
    routes: {
      "/": () => renderSsrDocument(notebookDocument()),
      "/api/health": () =>
        Response.json({
          backupFeature: NOTEBOOK_BACKUP_FEATURE_ENABLED ? "gate-b" : "disabled",
          service: "libre-ai-notebook",
          status: "ok",
          version: "v1",
        }),
    },
  });
  if (!NOTEBOOK_BACKUP_FEATURE_ENABLED) return handler;
  return async (request: Request): Promise<Response> =>
    allowWasmCompilation(await handler(request));
}

function allowWasmCompilation(response: Response): Response {
  const headers = new Headers(response.headers);
  const policy = headers.get("Content-Security-Policy");
  if (!policy?.includes("script-src 'self'")) {
    throw new Error("notebook.csp_boundary_invalid");
  }
  headers.set(
    "Content-Security-Policy",
    policy.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"),
  );
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
