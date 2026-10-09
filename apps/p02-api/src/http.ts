/** Fleet response shapes: `{ data, meta }` and problem-details.v1 errors. */
import { randomBytes } from "node:crypto";

export function requestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

export function envelope(status: number, data: unknown): Response {
  return Response.json({ data, meta: {} }, { status, headers: { "cache-control": "no-store" } });
}

/** A refusal. `message` is fixed per code: it never echoes request content. */
export function problem(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, requestId: requestId() } },
    {
      status,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
    },
  );
}
