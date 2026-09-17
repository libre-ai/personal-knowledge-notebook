import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const outputDirectory = resolve(repositoryRoot, "target/notebook-core-v2-qualification");
const goldenVector = resolve(
  repositoryRoot,
  "contracts/fixtures/notebook-core-v2/golden-vectors.v1.json",
);
const hostname = "127.0.0.1";
const port = 41_773;

const contentTypes = new Map([
  [".d.ts", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wit", "text/plain; charset=utf-8"],
]);

function contentType(path: string): string {
  for (const [suffix, value] of contentTypes) if (path.endsWith(suffix)) return value;
  return "application/octet-stream";
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }

    let path: string;
    if (url.pathname === "/") path = resolve(outputDirectory, "index.html");
    else if (url.pathname === "/golden-vectors.json") path = goldenVector;
    else if (/^\/generated\/[a-zA-Z0-9./_-]+$/.test(url.pathname)) {
      path = resolve(outputDirectory, url.pathname.slice(1));
      if (!path.startsWith(`${resolve(outputDirectory, "generated")}/`)) {
        return new Response(null, { status: 404 });
      }
    } else if (url.pathname === "/manifest.json") path = resolve(outputDirectory, "manifest.json");
    else return new Response(null, { status: 404 });

    const file = Bun.file(path);
    if (!(await file.exists())) return new Response(null, { status: 404 });
    const headers = {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self'",
      "content-type": contentType(path),
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    return new Response(request.method === "HEAD" ? null : file, { headers });
  },
});

console.log(`Notebook qualification server ready on ${server.hostname}:${server.port}`);
