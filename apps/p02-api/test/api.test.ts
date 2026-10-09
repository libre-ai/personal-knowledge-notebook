import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { validateJobDocument } from "../src/contract";
import { API_LOGIN, BOOTSTRAP, startCluster, type TestCluster } from "./pg";

const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";

let cluster: TestCluster;
let owner: SQL;
let app: ReturnType<typeof createApp>;
let tokenA: string;
let tokenB: string;

async function session(tenant: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  await owner`INSERT INTO p02.sessions (token_sha256, tenant_id, expires_at)
              VALUES (${hash}, ${tenant}, now() + interval '1 hour')`;
  return token;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://api.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const fetchSource = {
  sourceId: "src-example",
  url: "https://feeds.example.org/atom.xml",
  bodyKind: "feed",
};

beforeAll(async () => {
  cluster = await startCluster();
  owner = cluster.connect(BOOTSTRAP);
  app = createApp({ sql: cluster.connect(API_LOGIN) });
  tokenA = await session(TENANT_A);
  tokenB = await session(TENANT_B);
});

afterAll(async () => {
  await cluster.stop();
});

describe("p02 API", () => {
  test("health answers in the fleet envelope", async () => {
    const response = await app.handle(new Request("http://api.test/v1/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: "ok" }, meta: {} });
  });

  test("every job route requires a live session", async () => {
    for (const authorization of [
      undefined,
      "Bearer nope",
      "Basic abc",
      `Bearer ${"0".repeat(64)}`,
    ]) {
      const headers: Record<string, string> = { "idempotency-key": "k-1" };
      if (authorization) headers.authorization = authorization;
      const response = await app.handle(post("/v1/jobs", fetchSource, headers));
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe("p02.unauthenticated");
      expect(body.error.requestId).toMatch(/^req_[a-z0-9]{16,64}$/);
    }
  });

  test("enqueuing creates one contract-valid command in the session's tenant", async () => {
    const response = await app.handle(
      post("/v1/jobs", fetchSource, {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "fetch-1",
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { jobId: string; state: string };
      meta: object;
    };
    expect(body.data.state).toBe("queued");
    expect(body.data.jobId).toMatch(/^job-[a-z0-9]{24}$/);
    expect(body.meta).toEqual({});
    const rows =
      await owner`SELECT tenant_id, command FROM p02.jobs WHERE job_id = ${body.data.jobId}`;
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
    expect(validateJobDocument(rows[0].command)).toEqual({ ok: true });
    expect(rows[0].command.operation).toEqual({ type: "fetch-source", ...fetchSource });
    const dispatch =
      await owner`SELECT count(*)::int AS n FROM p02.job_dispatch WHERE job_id = ${body.data.jobId}`;
    expect(dispatch[0].n).toBe(1);
  });

  test("an idempotent replay returns the same job; a different body under the same key conflicts", async () => {
    const headers = { authorization: `Bearer ${tokenA}`, "idempotency-key": "fetch-2" };
    const first = await app.handle(post("/v1/jobs", fetchSource, headers));
    const replay = await app.handle(post("/v1/jobs", fetchSource, headers));
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const [a, b] = (await Promise.all([first.json(), replay.json()])) as {
      data: { jobId: string };
    }[];
    expect(b?.data.jobId).toBe(a?.data.jobId as string);
    const conflict = await app.handle(
      post("/v1/jobs", { ...fetchSource, bodyKind: "page" }, headers),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      "p02.idempotency_conflict",
    );
    // The same key in another tenant is another job.
    const other = await app.handle(
      post("/v1/jobs", fetchSource, {
        authorization: `Bearer ${tokenB}`,
        "idempotency-key": "fetch-2",
      }),
    );
    expect(other.status).toBe(201);
  });

  test("a command outside the contract is refused before the database, without echoing it", async () => {
    const headers = { authorization: `Bearer ${tokenA}`, "idempotency-key": "bad-1" };
    for (const body of [
      { ...fetchSource, url: "http://feeds.example.org:8080/atom.xml" },
      { ...fetchSource, url: "file:///etc/passwd" },
      { ...fetchSource, url: "https://user@feeds.example.org/" },
      { ...fetchSource, bodyKind: "video" },
      { ...fetchSource, extra: true },
      { ...fetchSource, validators: { etag: '"v1"\r\nX-Injected: 1' } },
      { sourceId: "src-example", url: "https://feeds.example.org/atom.xml" },
    ]) {
      const response = await app.handle(post("/v1/jobs", body, headers));
      expect(response.status).toBe(422);
      const text = await response.text();
      expect(JSON.parse(text).error.code).toBe("p02.command_invalid");
      expect(text).not.toContain("feeds.example.org");
      expect(text).not.toContain("passwd");
    }
    const rows =
      await owner`SELECT count(*)::int AS n FROM p02.jobs WHERE idempotency_key = 'bad-1'`;
    expect(rows[0].n).toBe(0);
  });

  test("malformed requests get typed refusals", async () => {
    const auth = { authorization: `Bearer ${tokenA}` };
    const cases: [Request, number, string][] = [
      [post("/v1/jobs", fetchSource, auth), 400, "p02.idempotency_key_required"],
      [
        post("/v1/jobs", fetchSource, { ...auth, "idempotency-key": "has space" }),
        400,
        "p02.idempotency_key_invalid",
      ],
      [
        post("/v1/jobs", "{not json", { ...auth, "idempotency-key": "k-2" }),
        400,
        "p02.body_invalid",
      ],
      [
        post("/v1/jobs", "x".repeat(17 * 1024), { ...auth, "idempotency-key": "k-3" }),
        413,
        "p02.body_too_large",
      ],
      [
        new Request("http://api.test/v1/jobs", { method: "PUT", headers: auth }),
        405,
        "p02.method_not_allowed",
      ],
      [new Request("http://api.test/v1/unknown", { headers: auth }), 404, "p02.not_found"],
    ];
    for (const [request, status, code] of cases) {
      const response = await app.handle(request);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  test("a job is readable by its tenant only", async () => {
    const created = await app.handle(
      post("/v1/jobs", fetchSource, {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "read-1",
      }),
    );
    const { data } = (await created.json()) as { data: { jobId: string } };
    const mine = await app.handle(
      new Request(`http://api.test/v1/jobs/${data.jobId}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      }),
    );
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({
      data: { jobId: data.jobId, state: "queued", attempts: 0, result: null },
      meta: {},
    });
    const theirs = await app.handle(
      new Request(`http://api.test/v1/jobs/${data.jobId}`, {
        headers: { authorization: `Bearer ${tokenB}` },
      }),
    );
    expect(theirs.status).toBe(404);
    const malformed = await app.handle(
      new Request("http://api.test/v1/jobs/..%2Fetc", {
        headers: { authorization: `Bearer ${tokenA}` },
      }),
    );
    expect(malformed.status).toBe(404);
  });

  test("a revoked or expired session is refused", async () => {
    const token = await session(TENANT_A);
    const hash = createHash("sha256").update(token).digest("hex");
    await owner`UPDATE p02.sessions SET revoked_at = now() WHERE token_sha256 = ${hash}`;
    const response = await app.handle(
      post("/v1/jobs", fetchSource, {
        authorization: `Bearer ${token}`,
        "idempotency-key": "rev-1",
      }),
    );
    expect(response.status).toBe(401);
  });
});
