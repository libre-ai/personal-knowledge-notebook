import { join } from "node:path";
import { parseServerAddress } from "@libre-ai/web-platform";
import { verifyNotebookBuildMode } from "./build-manifest";
import { createNotebookHandler } from "./handler";

const { hostname, port } = parseServerAddress(process.env);
await verifyNotebookBuildMode(join(import.meta.dir, "../../dist/notebook-build-manifest.json"));
const handler = createNotebookHandler();

const server = Bun.serve({
  fetch: handler,
  hostname,
  port,
});

console.log(`Notebook server ready on ${server.hostname}:${server.port}`);
