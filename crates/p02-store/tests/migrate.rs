//! Migration runner: idempotent, checksummed, migration role only.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use p02_store::StoreError;
use p02_store::migrate::{MIGRATIONS, migrate};
use p02_store::testing::{API_LOGIN, MIGRATOR, TestDatabase};

#[tokio::test]
async fn migrations_apply_once_and_then_verify() {
    let database = TestDatabase::start().await;
    assert_eq!(database.migration.applied, MIGRATIONS.len());
    assert_eq!(database.migration.verified, 0);
    let mut migrator = database.connect(MIGRATOR).await;
    let again = migrate(&mut migrator).await.unwrap();
    assert_eq!((again.applied, again.verified), (0, MIGRATIONS.len()));
}

#[tokio::test]
async fn a_drifted_or_unknown_migration_stops_the_run() {
    let database = TestDatabase::start().await;
    let mut migrator = database.connect(MIGRATOR).await;
    migrator
        .execute(
            "UPDATE public.p02_schema_migrations SET sha256 = repeat('0', 64) WHERE version = 1",
            &[],
        )
        .await
        .unwrap();
    assert!(matches!(
        migrate(&mut migrator).await,
        Err(StoreError::MigrationDrift)
    ));
    let fresh = TestDatabase::start().await;
    let mut migrator = fresh.connect(MIGRATOR).await;
    migrator
        .execute(
            "INSERT INTO public.p02_schema_migrations (version, name, sha256) VALUES (999, 'future', repeat('0', 64))",
            &[],
        )
        .await
        .unwrap();
    assert!(matches!(
        migrate(&mut migrator).await,
        Err(StoreError::MigrationUnknown)
    ));
}

#[tokio::test]
async fn a_runtime_role_cannot_migrate() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    assert!(migrate(&mut api).await.is_err());
}
