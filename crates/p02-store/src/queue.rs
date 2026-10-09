//! Worker side of the P02 job queue.
//!
//! Claiming reads only `p02.job_dispatch` (identifiers and timing). Loading
//! the command and recording the result happen in a transaction scoped to the
//! claimed job's tenant: `SET LOCAL ROLE p02_worker` plus the
//! transaction-local `app.tenant_id`, so row-level security limits the worker
//! to that one organization while it handles that job.

use std::time::Duration;

use serde_json::Value;
use tokio_postgres::Client;

use crate::error::StoreError;
use crate::tenant::TenantId;

/// Final state of a job, as recorded with its result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminal {
    Succeeded,
    Refused,
    Failed,
}

impl Terminal {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }
}

/// A job this worker holds a lease on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub tenant: TenantId,
    pub job_id: String,
    /// How many times the job has been claimed, this claim included.
    pub claims: i32,
    lease_token: String,
}

/// Claim the next ready job, if any, with a lease of `lease`.
/// `client` must be connected as a login role that is a member of `p02_worker`.
pub async fn claim(
    client: &mut Client,
    worker: &str,
    lease: Duration,
) -> Result<Option<Claim>, StoreError> {
    let transaction = client.transaction().await?;
    transaction
        .batch_execute("SET LOCAL ROLE p02_worker")
        .await?;
    // SKIP LOCKED: concurrent workers never wait on, nor take, the same row.
    let row = transaction
        .query_opt(
            "UPDATE p02.job_dispatch AS d \
             SET claims = d.claims + 1, \
                 lease_token = $1 || ':' || (d.claims + 1), \
                 lease_expires_at = clock_timestamp() + make_interval(secs => $2) \
             FROM (SELECT tenant_id, job_id FROM p02.job_dispatch \
                   WHERE available_at <= clock_timestamp() \
                     AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()) \
                   ORDER BY available_at, tenant_id, job_id \
                   FOR UPDATE SKIP LOCKED LIMIT 1) AS next \
             WHERE d.tenant_id = next.tenant_id AND d.job_id = next.job_id \
             RETURNING d.tenant_id, d.job_id, d.claims, d.lease_token",
            &[&worker, &lease.as_secs_f64()],
        )
        .await?;
    transaction.commit().await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let tenant: String = row.try_get(0)?;
    Ok(Some(Claim {
        tenant: TenantId::parse(&tenant)?,
        job_id: row.try_get(1)?,
        claims: row.try_get(2)?,
        lease_token: row.try_get(3)?,
    }))
}

/// Open a transaction as `p02_worker` inside `tenant`'s row-level security
/// context. Both settings are transaction-local and end with it.
async fn tenant_transaction<'a>(
    client: &'a mut Client,
    tenant: &TenantId,
) -> Result<tokio_postgres::Transaction<'a>, StoreError> {
    let transaction = client.transaction().await?;
    transaction
        .batch_execute("SET LOCAL ROLE p02_worker")
        .await?;
    transaction
        .execute(
            "SELECT set_config('app.tenant_id', $1, true)",
            &[&tenant.as_str()],
        )
        .await?;
    Ok(transaction)
}

/// The claim still holds its lease: same token, not expired.
const LEASE_HELD: &str =
    "tenant_id = $1 AND job_id = $2 AND lease_token = $3 AND lease_expires_at > clock_timestamp()";

/// Read the command of a claimed job, in its tenant context, and mark the job
/// running.
pub async fn load_command(client: &mut Client, claim: &Claim) -> Result<Value, StoreError> {
    let transaction = tenant_transaction(client, &claim.tenant).await?;
    let held = transaction
        .query_opt(
            &format!("SELECT 1 FROM p02.job_dispatch WHERE {LEASE_HELD} FOR UPDATE"),
            &[&claim.tenant.as_str(), &claim.job_id, &claim.lease_token],
        )
        .await?;
    if held.is_none() {
        return Err(StoreError::LeaseLost);
    }
    let row = transaction
        .query_opt(
            "UPDATE p02.jobs SET state = 'running', attempts = $2, updated_at = now() \
             WHERE job_id = $1 AND state IN ('queued', 'running') RETURNING command",
            &[&claim.job_id, &claim.claims],
        )
        .await?
        .ok_or(StoreError::JobMissing)?;
    let command: Value = row.try_get(0)?;
    transaction.commit().await?;
    Ok(command)
}

/// Record the final result of a claimed job and release it. Refused with
/// `LeaseLost` if the lease expired or another worker took the job over.
pub async fn complete(
    client: &mut Client,
    claim: &Claim,
    state: Terminal,
    result: &Value,
) -> Result<(), StoreError> {
    let transaction = tenant_transaction(client, &claim.tenant).await?;
    let released = transaction
        .execute(
            &format!("DELETE FROM p02.job_dispatch WHERE {LEASE_HELD}"),
            &[&claim.tenant.as_str(), &claim.job_id, &claim.lease_token],
        )
        .await?;
    if released != 1 {
        return Err(StoreError::LeaseLost);
    }
    // The table's checks refuse a result whose tenant, job or status
    // disagrees with the row.
    let updated = transaction
        .execute(
            "UPDATE p02.jobs SET state = $2, result = $3, updated_at = now() WHERE job_id = $1",
            &[&claim.job_id, &state.as_str(), result],
        )
        .await?;
    if updated != 1 {
        return Err(StoreError::JobMissing);
    }
    transaction.commit().await?;
    Ok(())
}

/// Give a claimed job back to the queue, ready again after `delay`.
pub async fn release_for_retry(
    client: &mut Client,
    claim: &Claim,
    delay: Duration,
) -> Result<(), StoreError> {
    let transaction = tenant_transaction(client, &claim.tenant).await?;
    let released = transaction
        .execute(
            &format!(
                "UPDATE p02.job_dispatch SET lease_token = NULL, lease_expires_at = NULL, \
                 available_at = clock_timestamp() + make_interval(secs => $4) WHERE {LEASE_HELD}"
            ),
            &[
                &claim.tenant.as_str(),
                &claim.job_id,
                &claim.lease_token,
                &delay.as_secs_f64(),
            ],
        )
        .await?;
    if released != 1 {
        return Err(StoreError::LeaseLost);
    }
    transaction
        .execute(
            "UPDATE p02.jobs SET state = 'queued', updated_at = now() WHERE job_id = $1",
            &[&claim.job_id],
        )
        .await?;
    transaction.commit().await?;
    Ok(())
}
