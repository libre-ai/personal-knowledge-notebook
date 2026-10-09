/**
 * Database access of the API: every statement runs inside a transaction that
 * drops to the NOLOGIN `p02_api` role and sets the transaction-local tenant
 * (or session-hash) context row-level security reads.
 */
import type { SQL, TransactionSQL } from "bun";

const TENANT = /^ten_[a-z0-9]{16,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export async function withTenant<T>(
  sql: SQL,
  tenant: string,
  work: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
  if (!TENANT.test(tenant)) throw new Error("tenant context refused: malformed tenant");
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE p02_api`;
    await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
    return work(tx);
  });
}

/** The tenant of the live session whose token hashes to `hash`, if any. */
export async function sessionTenant(sql: SQL, hash: string): Promise<string | null> {
  if (!SHA256.test(hash)) return null;
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE p02_api`;
    await tx`SELECT set_config('app.session_token_sha256', ${hash}, true)`;
    const rows = await tx`SELECT tenant_id FROM p02.sessions WHERE token_sha256 = ${hash}`;
    const tenant = rows[0]?.tenant_id;
    return typeof tenant === "string" && TENANT.test(tenant) ? tenant : null;
  });
}
