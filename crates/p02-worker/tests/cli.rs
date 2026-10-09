//! The worker binary: migrate subcommand and connection-string vetting.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Command;

use p02_store::testing::{MIGRATOR, TestDatabase};

const BINARY: &str = env!("CARGO_BIN_EXE_p02-worker");

#[tokio::test]
async fn migrate_verifies_an_already_migrated_database() {
    let database = TestDatabase::start().await;
    let url = format!(
        "host={} dbname=p02 user={MIGRATOR}",
        database.socket_dir().display()
    );
    let output = Command::new(BINARY)
        .arg("migrate")
        .env("P02_DATABASE_URL", &url)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "p02-worker: migrations verified=2 applied=0\n"
    );
}

#[test]
fn a_tcp_database_without_tls_is_refused_and_not_echoed() {
    let output = Command::new(BINARY)
        .arg("run")
        .env(
            "P02_DATABASE_URL",
            "postgresql://user:secret@db.example.org/p02",
        )
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Unix-socket"), "{stderr}");
    assert!(!stderr.contains("secret") && !stderr.contains("db.example.org"));
}

#[test]
fn a_missing_connection_string_is_refused() {
    let output = Command::new(BINARY)
        .arg("run")
        .env_remove("P02_DATABASE_URL")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}
