//! Worker job processing against a throwaway P02 database (S0.5, G10).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use p02_fetch::{FetchError, FetchOutcome, FetchRequest, FetcherConfig, ResponseMeta, SafeFetcher};
use p02_store::testing::{API_LOGIN, TestDatabase, WORKER_LOGIN};
use p02_worker::{Fetch, FetchFuture, Processed, WorkerSettings, process_one};
use serde_json::{Value, json};
use url::Url;

const TENANT: &str = "ten_aaaaaaaaaaaaaaaa";

struct Scripted {
    replies: Mutex<Vec<Result<FetchOutcome, FetchError>>>,
    calls: AtomicUsize,
    seen: Mutex<Vec<FetchRequest>>,
}

impl Scripted {
    fn new(replies: Vec<Result<FetchOutcome, FetchError>>) -> Self {
        Self {
            replies: Mutex::new(replies),
            calls: AtomicUsize::new(0),
            seen: Mutex::new(Vec::new()),
        }
    }
}

impl Fetch for Scripted {
    fn fetch<'a>(&'a self, request: &'a FetchRequest) -> FetchFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.seen.lock().unwrap().push(request.clone());
            self.replies.lock().unwrap().remove(0)
        })
    }
}

fn meta(status: u16) -> ResponseMeta {
    ResponseMeta {
        final_url: Url::parse("https://feeds.example.org/atom.xml").unwrap(),
        status,
        redirects: 1,
        etag: Some("\"v2\"".to_owned()),
        last_modified: None,
        content_type: Some("application/atom+xml".to_owned()),
        retry_after: None,
    }
}

fn command(job: &str, key: &str, url: &str, tenant_in_command: &str) -> Value {
    json!({
        "schemaVersion": "libre-ai.p02-job.v1",
        "kind": "command",
        "jobId": job,
        "tenantId": tenant_in_command,
        "idempotencyKey": key,
        "enqueuedAt": "2026-10-09T08:00:00Z",
        "operation": {"type": "fetch-source", "sourceId": "src-example", "url": url, "bodyKind": "feed",
                      "validators": {"etag": "\"v1\""}}
    })
}

async fn enqueue_raw(database: &TestDatabase, job: &str, key: &str, document: &Value) {
    let mut api = database.connect(API_LOGIN).await;
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT])
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command) VALUES ($1, $2, $3, 'fetch-source', $4)",
            &[&TENANT, &job, &key, document],
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
}

async fn enqueue(database: &TestDatabase, job: &str, url: &str) {
    enqueue_raw(
        database,
        job,
        &format!("key-{job}"),
        &command(job, &format!("key-{job}"), url, TENANT),
    )
    .await;
}

async fn job_row(database: &TestDatabase, job: &str) -> (String, Option<Value>) {
    let mut api = database.connect(API_LOGIN).await;
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT])
        .await
        .unwrap();
    let row = transaction
        .query_one(
            "SELECT state, result FROM p02.jobs WHERE job_id = $1",
            &[&job],
        )
        .await
        .unwrap();
    (row.get(0), row.get(1))
}

fn settings() -> WorkerSettings {
    WorkerSettings {
        worker_id: "w-test".to_owned(),
        lease: Duration::from_secs(60),
        max_claims: 3,
        retry_base: Duration::ZERO,
    }
}

#[tokio::test]
async fn an_empty_queue_is_idle() {
    let database = TestDatabase::start().await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    let fetcher = Scripted::new(vec![]);
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Idle
    );
}

#[tokio::test]
async fn a_fetched_body_is_recorded_as_a_contract_result_with_its_digest() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-1", "https://feeds.example.org/atom.xml").await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    let body = b"<feed/>".to_vec();
    let fetcher = Scripted::new(vec![Ok(FetchOutcome::Body {
        meta: meta(200),
        body: body.clone().into(),
    })]);
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Completed
    );
    let (state, result) = job_row(&database, "job-1").await;
    assert_eq!(state, "succeeded");
    let result = result.unwrap();
    let parsed = p02_domain::job::parse_document(&serde_json::to_vec(&result).unwrap());
    assert!(
        parsed.is_ok(),
        "the worker writes a valid p02-job-v1 result: {result}"
    );
    assert_eq!(result["outcome"]["body"]["bytes"], 7);
    assert_eq!(
        result["outcome"]["body"]["blake3"],
        blake3::hash(&body).to_hex().as_str()
    );
    assert_eq!(result["outcome"]["etag"], "\"v2\"");
    let seen = fetcher.seen.lock().unwrap();
    assert_eq!(
        seen[0].validators.etag.as_deref(),
        Some("\"v1\""),
        "validators forwarded"
    );
    assert!(
        !result.to_string().contains("<feed/>"),
        "no content in the result"
    );
}

#[tokio::test]
async fn a_not_modified_and_a_404_are_successful_outcomes_without_body() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-1", "https://feeds.example.org/a.xml").await;
    enqueue(&database, "job-2", "https://feeds.example.org/b.xml").await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    let fetcher = Scripted::new(vec![
        Ok(FetchOutcome::NotModified { meta: meta(304) }),
        Ok(FetchOutcome::Status { meta: meta(404) }),
    ]);
    for _ in 0..2 {
        assert_eq!(
            process_one(&mut worker, &fetcher, &settings())
                .await
                .unwrap(),
            Processed::Completed
        );
    }
    for (job, status, not_modified) in [("job-1", 304, true), ("job-2", 404, false)] {
        let (state, result) = job_row(&database, job).await;
        let result = result.unwrap();
        assert_eq!(state, "succeeded");
        assert_eq!(result["outcome"]["httpStatus"], status);
        assert_eq!(result["outcome"]["notModified"], not_modified);
        assert!(result["outcome"].get("body").is_none());
    }
}

#[tokio::test]
async fn a_policy_refusal_is_final_and_a_transient_failure_is_retried_then_failed() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-1", "https://feeds.example.org/a.xml").await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    let fetcher = Scripted::new(vec![Err(FetchError::DestinationForbidden)]);
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Completed
    );
    let (state, result) = job_row(&database, "job-1").await;
    assert_eq!(state, "refused");
    assert_eq!(result.unwrap()["reasonCode"], "fetch.destination_forbidden");
    assert_eq!(
        fetcher.calls.load(Ordering::SeqCst),
        1,
        "no retry after a refusal"
    );

    enqueue(&database, "job-2", "https://feeds.example.org/b.xml").await;
    let fetcher = Scripted::new(vec![Err(FetchError::TotalTimeout); 3]);
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Retried
    );
    assert_eq!(job_row(&database, "job-2").await.0, "queued");
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Retried
    );
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Completed
    );
    let (state, result) = job_row(&database, "job-2").await;
    assert_eq!(state, "failed");
    assert_eq!(result.unwrap()["reasonCode"], "fetch.total_timeout");
    assert_eq!(
        fetcher.calls.load(Ordering::SeqCst),
        3,
        "max_claims attempts, no more"
    );
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Idle
    );
}

#[tokio::test]
async fn an_invalid_command_is_refused_without_fetching() {
    let database = TestDatabase::start().await;
    // Valid row, but a command whose URL breaks the contract (port 8080).
    let bad = command(
        "job-1",
        "key-job-1",
        "http://feeds.example.org:8080/a.xml",
        TENANT,
    );
    enqueue_raw(&database, "job-1", "key-job-1", &bad).await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    let fetcher = Scripted::new(vec![]);
    assert_eq!(
        process_one(&mut worker, &fetcher, &settings())
            .await
            .unwrap(),
        Processed::Completed
    );
    let (state, result) = job_row(&database, "job-1").await;
    assert_eq!(state, "refused");
    assert_eq!(result.unwrap()["reasonCode"], "job.command_invalid");
    assert_eq!(fetcher.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_production_fetcher_refuses_a_private_destination_without_network() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-1", "http://127.0.0.1/admin").await;
    enqueue(
        &database,
        "job-2",
        "http://169.254.169.254/latest/meta-data",
    )
    .await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    let fetcher = SafeFetcher::new(FetcherConfig::default()).unwrap();
    for _ in 0..2 {
        assert_eq!(
            process_one(&mut worker, &fetcher, &settings())
                .await
                .unwrap(),
            Processed::Completed
        );
    }
    for job in ["job-1", "job-2"] {
        let (state, result) = job_row(&database, job).await;
        assert_eq!(state, "refused");
        assert_eq!(result.unwrap()["reasonCode"], "fetch.destination_forbidden");
    }
}
