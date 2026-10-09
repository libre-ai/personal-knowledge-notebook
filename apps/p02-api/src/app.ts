/**
 * P02 API request handling (PRD 12 §3.7). The API authenticates the owner,
 * enqueues p02-job-v1 commands for the worker in the session's tenant and
 * reports job state. It never fetches a URL and never evaluates a rule.
 */
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL } from "bun";
import { validateJobDocument } from "./contract";
import { sessionTenant, withTenant } from "./db";
import { envelope, problem } from "./http";

/** Largest request body read, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024;
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,256})$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_ROUTE = /^\/v1\/jobs\/([a-z][a-z0-9_-]{2,127})$/;

export interface AppDependencies {
  /** A pool connected as a login member of `p02_api`. */
  sql: SQL;
  now?: () => Date;
}

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJson(request: Request): Promise<Body> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: problem(413, "p02.body_too_large", "The request body is too large."),
    };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        return {
          ok: false,
          response: problem(413, "p02.body_too_large", "The request body is too large."),
        };
      }
      chunks.push(chunk);
    }
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return {
      ok: false,
      response: problem(400, "p02.body_invalid", "The request body is not JSON."),
    };
  }
}

async function authenticate(sql: SQL, request: Request): Promise<string | null> {
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  const token = match?.[1];
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  return sessionTenant(sql, hash);
}

function unauthenticated(): Response {
  return problem(401, "p02.unauthenticated", "A live session is required.");
}

async function enqueue(deps: AppDependencies, request: Request, tenant: string): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (key === null) {
    return problem(400, "p02.idempotency_key_required", "An Idempotency-Key header is required.");
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    return problem(400, "p02.idempotency_key_invalid", "The Idempotency-Key header is malformed.");
  }
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const operation =
    typeof body.value === "object" && body.value !== null && !Array.isArray(body.value)
      ? { type: "fetch-source", ...body.value }
      : body.value;
  const command = {
    schemaVersion: "libre-ai.p02-job.v1",
    kind: "command",
    jobId: `job-${randomBytes(12).toString("hex")}`,
    tenantId: tenant,
    idempotencyKey: key,
    enqueuedAt: (deps.now?.() ?? new Date()).toISOString(),
    operation,
  };
  if (!validateJobDocument(command).ok) {
    return problem(422, "p02.command_invalid", "The command is outside the p02-job-v1 contract.");
  }
  return withTenant(deps.sql, tenant, async (tx) => {
    const inserted = await tx`
      INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command)
      VALUES (${tenant}, ${command.jobId}, ${key}, 'fetch-source', ${command}::jsonb)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING job_id, state`;
    if (inserted.length === 1) {
      return envelope(201, { jobId: inserted[0].job_id, state: inserted[0].state });
    }
    const existing = await tx`
      SELECT job_id, state, command->'operation' AS operation FROM p02.jobs
      WHERE idempotency_key = ${key}`;
    const row = existing[0];
    if (!row || !isDeepStrictEqual(row.operation, operation)) {
      return problem(
        409,
        "p02.idempotency_conflict",
        "This Idempotency-Key was used for another command.",
      );
    }
    return envelope(200, { jobId: row.job_id, state: row.state });
  });
}

async function readJob(deps: AppDependencies, tenant: string, jobId: string): Promise<Response> {
  return withTenant(deps.sql, tenant, async (tx) => {
    const rows =
      await tx`SELECT job_id, state, attempts, result FROM p02.jobs WHERE job_id = ${jobId}`;
    const row = rows[0];
    if (!row) return problem(404, "p02.not_found", "No such resource.");
    return envelope(200, {
      jobId: row.job_id,
      state: row.state,
      attempts: row.attempts,
      result: row.result,
    });
  });
}

export function createApp(deps: AppDependencies): { handle(request: Request): Promise<Response> } {
  async function route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/health") {
      return request.method === "GET"
        ? envelope(200, { status: "ok" })
        : problem(405, "p02.method_not_allowed", "Method not allowed.");
    }
    const jobMatch = JOB_ROUTE.exec(pathname);
    const isJobs = pathname === "/v1/jobs";
    if (!isJobs && !jobMatch) return problem(404, "p02.not_found", "No such resource.");
    const allowed = isJobs ? request.method === "POST" : request.method === "GET";
    if (!allowed) return problem(405, "p02.method_not_allowed", "Method not allowed.");
    const tenant = await authenticate(deps.sql, request);
    if (tenant === null) return unauthenticated();
    if (isJobs) return enqueue(deps, request, tenant);
    return readJob(deps, tenant, jobMatch?.[1] ?? "");
  }

  return {
    async handle(request: Request): Promise<Response> {
      try {
        return await route(request);
      } catch {
        // Database or runtime failure: a fixed refusal, nothing echoed.
        return problem(503, "p02.store_unavailable", "The service is unavailable.");
      }
    },
  };
}
