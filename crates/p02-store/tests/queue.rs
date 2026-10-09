//! Worker side of the job queue: claim, tenant-scoped read, completion,
//! retry, lease expiry and fencing (S0.5, G10).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use std::time::Duration;

use common::{TENANT_A, TENANT_B, enqueue, succeeded};
use p02_store::StoreError;
use p02_store::queue::{Terminal, claim, complete, load_command, release_for_retry};
use p02_store::testing::{API_LOGIN, TestDatabase, WORKER_LOGIN};

const LEASE: Duration = Duration::from_secs(30);

#[tokio::test]
async fn an_empty_queue_yields_no_claim() {
    let database = TestDatabase::start().await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    assert_eq!(claim(&mut worker, "w1", LEASE).await.unwrap(), None);
}

#[tokio::test]
async fn a_claim_reads_its_command_in_its_tenant_and_completes_once() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    enqueue(&mut api, TENANT_A, "job-a1", "key-1")
        .await
        .unwrap();
    let mut worker = database.connect(WORKER_LOGIN).await;
    let job = claim(&mut worker, "w1", LEASE)
        .await
        .unwrap()
        .expect("one ready job");
    assert_eq!(job.tenant.as_str(), TENANT_A);
    assert_eq!(job.job_id, "job-a1");
    assert_eq!(job.claims, 1);
    let command = load_command(&mut worker, &job).await.unwrap();
    assert_eq!(
        command["operation"]["url"],
        "https://feeds.example.org/atom.xml"
    );
    // Claimed: nobody else gets it.
    assert_eq!(claim(&mut worker, "w2", LEASE).await.unwrap(), None);
    complete(
        &mut worker,
        &job,
        Terminal::Succeeded,
        &succeeded(TENANT_A, "job-a1"),
    )
    .await
    .unwrap();
    // Completed: gone from dispatch, a second completion is refused.
    assert_eq!(claim(&mut worker, "w2", LEASE).await.unwrap(), None);
    assert!(matches!(
        complete(
            &mut worker,
            &job,
            Terminal::Succeeded,
            &succeeded(TENANT_A, "job-a1")
        )
        .await,
        Err(StoreError::LeaseLost)
    ));
    let row = api_state(&mut api, TENANT_A, "job-a1").await;
    assert_eq!(row, ("succeeded".to_owned(), 1, true));
}

#[tokio::test]
async fn a_result_for_another_tenant_or_job_is_refused_by_the_database() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    enqueue(&mut api, TENANT_A, "job-a1", "key-1")
        .await
        .unwrap();
    let mut worker = database.connect(WORKER_LOGIN).await;
    let job = claim(&mut worker, "w1", LEASE).await.unwrap().unwrap();
    for wrong in [succeeded(TENANT_B, "job-a1"), succeeded(TENANT_A, "job-zz")] {
        assert!(
            complete(&mut worker, &job, Terminal::Succeeded, &wrong)
                .await
                .is_err()
        );
    }
    // State in the result must match the terminal state recorded.
    assert!(
        complete(
            &mut worker,
            &job,
            Terminal::Failed,
            &succeeded(TENANT_A, "job-a1")
        )
        .await
        .is_err()
    );
    complete(
        &mut worker,
        &job,
        Terminal::Succeeded,
        &succeeded(TENANT_A, "job-a1"),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_released_job_comes_back_after_its_delay() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    enqueue(&mut api, TENANT_A, "job-a1", "key-1")
        .await
        .unwrap();
    let mut worker = database.connect(WORKER_LOGIN).await;
    let first = claim(&mut worker, "w1", LEASE).await.unwrap().unwrap();
    release_for_retry(&mut worker, &first, Duration::from_millis(300))
        .await
        .unwrap();
    assert_eq!(
        claim(&mut worker, "w1", LEASE).await.unwrap(),
        None,
        "not before its delay"
    );
    tokio::time::sleep(Duration::from_millis(400)).await;
    let second = claim(&mut worker, "w1", LEASE).await.unwrap().unwrap();
    assert_eq!(second.claims, 2);
    assert_eq!(api_state(&mut api, TENANT_A, "job-a1").await.0, "queued");
}

#[tokio::test]
async fn an_expired_lease_is_reclaimed_and_the_stale_holder_is_fenced() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    enqueue(&mut api, TENANT_A, "job-a1", "key-1")
        .await
        .unwrap();
    let mut worker = database.connect(WORKER_LOGIN).await;
    let stale = claim(&mut worker, "w1", Duration::from_millis(200))
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let fresh = claim(&mut worker, "w2", LEASE)
        .await
        .unwrap()
        .expect("expired lease reclaimed");
    assert_eq!(fresh.claims, 2);
    assert!(matches!(
        complete(
            &mut worker,
            &stale,
            Terminal::Succeeded,
            &succeeded(TENANT_A, "job-a1")
        )
        .await,
        Err(StoreError::LeaseLost)
    ));
    assert!(matches!(
        release_for_retry(&mut worker, &stale, Duration::ZERO).await,
        Err(StoreError::LeaseLost)
    ));
    complete(
        &mut worker,
        &fresh,
        Terminal::Succeeded,
        &succeeded(TENANT_A, "job-a1"),
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_workers_never_claim_the_same_job() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    for index in 0..20 {
        let tenant = if index % 2 == 0 { TENANT_A } else { TENANT_B };
        enqueue(
            &mut api,
            tenant,
            &format!("job-{index:03}"),
            &format!("key-{index}"),
        )
        .await
        .unwrap();
    }
    let mut handles = Vec::new();
    for worker_index in 0..4 {
        let mut worker = database.connect(WORKER_LOGIN).await;
        handles.push(tokio::spawn(async move {
            let mut claimed = Vec::new();
            while let Some(job) = claim(&mut worker, &format!("w{worker_index}"), LEASE)
                .await
                .unwrap()
            {
                claimed.push(format!("{}/{}", job.tenant, job.job_id));
            }
            claimed
        }));
    }
    let mut all = Vec::new();
    for handle in handles {
        all.extend(handle.await.unwrap());
    }
    let total = all.len();
    all.sort();
    all.dedup();
    assert_eq!(
        (total, all.len()),
        (20, 20),
        "every job claimed exactly once"
    );
}

async fn api_state(
    api: &mut tokio_postgres::Client,
    tenant: &str,
    job: &str,
) -> (String, i32, bool) {
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&tenant])
        .await
        .unwrap();
    let row = transaction
        .query_one(
            "SELECT state, attempts, result IS NOT NULL FROM p02.jobs WHERE job_id = $1",
            &[&job],
        )
        .await
        .unwrap();
    (row.get(0), row.get(1), row.get(2))
}
