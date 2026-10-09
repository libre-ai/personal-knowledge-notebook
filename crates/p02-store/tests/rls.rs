//! Tenant isolation of the P02 tables (AT-32, NFR-12) under the runtime roles.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{TENANT_A, TENANT_B, enqueue, visible_jobs};
use p02_store::testing::{API_LOGIN, MIGRATOR, TestDatabase, WORKER_LOGIN};

#[tokio::test]
async fn runtime_roles_carry_no_bypass() {
    let database = TestDatabase::start().await;
    let migrator = database.connect(MIGRATOR).await;
    for role in ["p02_api", "p02_worker", API_LOGIN, WORKER_LOGIN, MIGRATOR] {
        let row = migrator
            .query_one(
                "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
                &[&role],
            )
            .await
            .unwrap();
        let (superuser, bypass): (bool, bool) = (row.get(0), row.get(1));
        assert!(
            !superuser && !bypass,
            "{role} must be neither superuser nor BYPASSRLS"
        );
    }
    let row = migrator
        .query_one(
            "SELECT bool_and(relrowsecurity AND relforcerowsecurity), count(*) FROM pg_class \
             WHERE relnamespace = 'p02'::regnamespace AND relkind = 'r'",
            &[],
        )
        .await
        .unwrap();
    let (forced, tables): (bool, i64) = (row.get(0), row.get(1));
    assert!(forced, "every p02 table forces row-level security");
    assert_eq!(tables, 3, "tables inspected");
}

#[tokio::test]
async fn the_api_sees_and_writes_only_its_tenant() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    assert!(
        enqueue(&mut api, TENANT_A, "job-a1", "key-1")
            .await
            .unwrap()
    );
    assert!(
        enqueue(&mut api, TENANT_B, "job-b1", "key-1")
            .await
            .unwrap()
    );
    assert_eq!(
        visible_jobs(&mut api, "p02_api", Some(TENANT_A))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        visible_jobs(&mut api, "p02_api", Some(TENANT_B))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        visible_jobs(&mut api, "p02_api", None).await.unwrap(),
        0,
        "no context, no row"
    );

    // A row for tenant B written from tenant A's context is refused by WITH CHECK.
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT_A])
        .await
        .unwrap();
    let crossed = transaction
        .execute(
            "INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command) \
             VALUES ($1, 'job-x', 'key-x', 'fetch-source', $2)",
            &[&TENANT_B, &common::command(TENANT_B, "job-x", "key-x")],
        )
        .await;
    assert!(crossed.is_err(), "cross-tenant insert refused");
    drop(transaction);

    // The API can neither read nor alter the dispatch table.
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    assert!(
        transaction
            .query("SELECT * FROM p02.job_dispatch", &[])
            .await
            .is_err()
    );
    drop(transaction);

    // Without dropping to its runtime role, the login has no privilege at all.
    assert!(
        api.query("SELECT count(*) FROM p02.jobs", &[])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_command_cannot_claim_another_tenant_or_job() {
    let database = TestDatabase::start().await;
    let api = database.connect(API_LOGIN).await;
    let transaction_sql = "SET LOCAL ROLE p02_api";
    let mut api = api;
    let transaction = api.transaction().await.unwrap();
    transaction.batch_execute(transaction_sql).await.unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT_A])
        .await
        .unwrap();
    // Row says tenant A, command says tenant B: the row/command check refuses.
    let mismatched = transaction
        .execute(
            "INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command) \
             VALUES ($1, 'job-a2', 'key-2', 'fetch-source', $2)",
            &[&TENANT_A, &common::command(TENANT_B, "job-a2", "key-2")],
        )
        .await;
    assert!(mismatched.is_err());
}

#[tokio::test]
async fn the_worker_sees_only_the_tenant_of_its_context() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    enqueue(&mut api, TENANT_A, "job-a1", "key-1")
        .await
        .unwrap();
    enqueue(&mut api, TENANT_B, "job-b1", "key-1")
        .await
        .unwrap();
    let mut worker = database.connect(WORKER_LOGIN).await;
    assert_eq!(
        visible_jobs(&mut worker, "p02_worker", Some(TENANT_A))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        visible_jobs(&mut worker, "p02_worker", None).await.unwrap(),
        0
    );
    // The worker cannot enqueue.
    assert!(
        enqueue(&mut worker, TENANT_A, "job-w", "key-w")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_idempotent_reenqueue_creates_one_job_and_one_dispatch() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    assert!(
        enqueue(&mut api, TENANT_A, "job-a1", "key-1")
            .await
            .unwrap()
    );
    assert!(
        !enqueue(&mut api, TENANT_A, "job-a2", "key-1")
            .await
            .unwrap()
    );
    assert_eq!(
        visible_jobs(&mut api, "p02_api", Some(TENANT_A))
            .await
            .unwrap(),
        1
    );
    let migrator = database.connect(MIGRATOR).await;
    let dispatch: i64 = migrator
        .query_one("SELECT count(*) FROM p02.job_dispatch", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        dispatch, 0,
        "the owner reads no dispatch row either: no policy for it"
    );
    let mut worker = database.connect(WORKER_LOGIN).await;
    let transaction = worker.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_worker")
        .await
        .unwrap();
    let dispatch: i64 = transaction
        .query_one("SELECT count(*) FROM p02.job_dispatch", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(dispatch, 1, "one dispatch row for one job");
}

async fn session_tenant(api: &mut tokio_postgres::Client, hash: &str) -> (Option<String>, i64) {
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute(
            "SELECT set_config('app.session_token_sha256', $1, true)",
            &[&hash],
        )
        .await
        .unwrap();
    let tenant = transaction
        .query_opt(
            "SELECT tenant_id FROM p02.sessions WHERE token_sha256 = $1",
            &[&hash],
        )
        .await
        .unwrap()
        .map(|row| row.get(0));
    let visible: i64 = transaction
        .query_one("SELECT count(*) FROM p02.sessions", &[])
        .await
        .unwrap()
        .get(0);
    (tenant, visible)
}

#[tokio::test]
async fn the_api_resolves_only_the_session_it_was_handed() {
    let database = TestDatabase::start().await;
    let bootstrap = database.connect(p02_store::testing::BOOTSTRAP).await;
    let (live, other, expired, revoked) = (
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
    );
    bootstrap
        .execute(
            "INSERT INTO p02.sessions (token_sha256, tenant_id, expires_at, revoked_at) VALUES \
             ($1, $5, now() + interval '1 hour', NULL), \
             ($2, $6, now() + interval '1 hour', NULL), \
             ($3, $5, now() - interval '1 second', NULL), \
             ($4, $5, now() + interval '1 hour', now())",
            &[&live, &other, &expired, &revoked, &TENANT_A, &TENANT_B],
        )
        .await
        .unwrap_err();
    // Expired rows cannot even be inserted with expires_at <= created_at;
    // insert them in the past instead.
    bootstrap
        .execute(
            "INSERT INTO p02.sessions (token_sha256, tenant_id, created_at, expires_at, revoked_at) VALUES \
             ($1, $5, now(), now() + interval '1 hour', NULL), \
             ($2, $6, now(), now() + interval '1 hour', NULL), \
             ($3, $5, now() - interval '2 hours', now() - interval '1 hour', NULL), \
             ($4, $5, now(), now() + interval '1 hour', now())",
            &[&live, &other, &expired, &revoked, &TENANT_A, &TENANT_B],
        )
        .await
        .unwrap();
    let mut api = database.connect(API_LOGIN).await;
    assert_eq!(
        session_tenant(&mut api, &live).await,
        (Some(TENANT_A.to_owned()), 1)
    );
    assert_eq!(
        session_tenant(&mut api, &other).await,
        (Some(TENANT_B.to_owned()), 1)
    );
    assert_eq!(session_tenant(&mut api, &expired).await, (None, 0));
    assert_eq!(session_tenant(&mut api, &revoked).await, (None, 0));
    assert_eq!(session_tenant(&mut api, &"e".repeat(64)).await, (None, 0));
    // The API cannot mint, alter or revoke a session.
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    assert!(
        transaction
            .execute(
                "INSERT INTO p02.sessions (token_sha256, tenant_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
                &[&"f".repeat(64), &TENANT_A],
            )
            .await
            .is_err()
    );
}
