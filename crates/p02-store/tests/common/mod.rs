#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]

use serde_json::{Value, json};
use tokio_postgres::Client;

pub const TENANT_A: &str = "ten_aaaaaaaaaaaaaaaa";
pub const TENANT_B: &str = "ten_bbbbbbbbbbbbbbbb";

pub fn command(tenant: &str, job_id: &str, key: &str) -> Value {
    json!({
        "schemaVersion": "libre-ai.p02-job.v1",
        "kind": "command",
        "jobId": job_id,
        "tenantId": tenant,
        "idempotencyKey": key,
        "enqueuedAt": "2026-10-09T08:00:00Z",
        "operation": {
            "type": "fetch-source",
            "sourceId": "src-example",
            "url": "https://feeds.example.org/atom.xml",
            "bodyKind": "feed"
        }
    })
}

/// Enqueue as the API would: its runtime role, its tenant context.
/// Returns whether a new job was created.
pub async fn enqueue(
    api: &mut Client,
    tenant: &str,
    job_id: &str,
    key: &str,
) -> Result<bool, tokio_postgres::Error> {
    let transaction = api.transaction().await?;
    transaction.batch_execute("SET LOCAL ROLE p02_api").await?;
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&tenant])
        .await?;
    let inserted = transaction
        .execute(
            "INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command) \
             VALUES ($1, $2, $3, 'fetch-source', $4) \
             ON CONFLICT (tenant_id, idempotency_key) DO NOTHING",
            &[&tenant, &job_id, &key, &command(tenant, job_id, key)],
        )
        .await?;
    transaction.commit().await?;
    Ok(inserted == 1)
}

/// Count the jobs `role` sees in `tenant`'s context (None = no context).
pub async fn visible_jobs(
    client: &mut Client,
    role: &str,
    tenant: Option<&str>,
) -> Result<i64, tokio_postgres::Error> {
    let transaction = client.transaction().await?;
    transaction
        .batch_execute(&format!("SET LOCAL ROLE {role}"))
        .await?;
    if let Some(tenant) = tenant {
        transaction
            .execute("SELECT set_config('app.tenant_id', $1, true)", &[&tenant])
            .await?;
    }
    let row = transaction
        .query_one("SELECT count(*) FROM p02.jobs", &[])
        .await?;
    transaction.commit().await?;
    Ok(row.get(0))
}

pub fn succeeded(tenant: &str, job_id: &str) -> Value {
    json!({
        "schemaVersion": "libre-ai.p02-job.v1",
        "kind": "result",
        "jobId": job_id,
        "tenantId": tenant,
        "completedAt": "2026-10-09T08:00:02Z",
        "status": "succeeded",
        "outcome": {
            "type": "fetch-source",
            "finalUrl": "https://feeds.example.org/atom.xml",
            "httpStatus": 200,
            "redirects": 0,
            "notModified": false
        }
    })
}
