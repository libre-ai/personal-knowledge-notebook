/**
 * `bun src/main.ts`: serve the P02 API.
 *
 * - `P02_API_DATABASE_SOCKET_DIR`: directory of the PostgreSQL Unix socket.
 *   This build has no TLS transport for PostgreSQL, so it connects through a
 *   Unix socket only.
 * - `P02_API_DATABASE_USER`: a login member of `p02_api` (default
 *   `p02_api_login`); `P02_API_DATABASE_NAME` (default `p02`).
 * - `P02_API_HOSTNAME` / `P02_API_PORT`: listen address (default 127.0.0.1:8402),
 *   meant to sit behind the TLS reverse proxy of the deployment.
 */
import { SQL } from "bun";
import { createApp, MAX_BODY_BYTES } from "./app";

const socketDir = process.env.P02_API_DATABASE_SOCKET_DIR;
if (!socketDir?.startsWith("/")) {
  console.error("p02-api: P02_API_DATABASE_SOCKET_DIR must be an absolute socket directory");
  process.exit(2);
}
const sql = new SQL({
  adapter: "postgres",
  path: socketDir,
  port: 5432,
  username: process.env.P02_API_DATABASE_USER ?? "p02_api_login",
  database: process.env.P02_API_DATABASE_NAME ?? "p02",
  max: 8,
});
const app = createApp({ sql });
const server = Bun.serve({
  hostname: process.env.P02_API_HOSTNAME ?? "127.0.0.1",
  port: Number(process.env.P02_API_PORT ?? "8402"),
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: (request) => app.handle(request),
});
console.log(`p02-api: listening on port ${server.port}`);
