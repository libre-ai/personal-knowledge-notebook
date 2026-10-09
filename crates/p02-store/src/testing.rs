//! Throwaway PostgreSQL clusters for tests (owner-accepted harness, Y35).
//!
//! Each [`TestDatabase`] runs `initdb` into a fresh directory and starts a
//! postmaster that listens on a Unix socket only (`listen_addresses = ''`),
//! then provisions the P02 roles exactly as a deployment would:
//!
//! - `p02_bootstrap`: cluster superuser, provisioning only;
//! - `p02_migrator`: LOGIN, owns the `p02` database, runs the migrations;
//! - `p02_api_login`, `p02_worker_login`: LOGIN, NOINHERIT members of the
//!   NOLOGIN runtime roles the migration creates.
//!
//! The binaries are found through `P02_PG_BINDIR`, then `pg_config --bindir`,
//! then `/usr/lib/postgresql/<major>/bin`. If none is found the harness
//! panics: a database test never passes by skipping.
#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio_postgres::{Client, Config, NoTls};

use crate::migrate::{MigrationReport, migrate};

/// Runtime login roles provisioned by the harness.
pub const API_LOGIN: &str = "p02_api_login";
pub const WORKER_LOGIN: &str = "p02_worker_login";
pub const MIGRATOR: &str = "p02_migrator";
pub const BOOTSTRAP: &str = "p02_bootstrap";
pub const DATABASE: &str = "p02";

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// Locate the PostgreSQL server binaries, or panic.
pub fn postgres_bindir() -> PathBuf {
    if let Some(dir) = std::env::var_os("P02_PG_BINDIR") {
        return PathBuf::from(dir);
    }
    if let Ok(output) = Command::new("pg_config").arg("--bindir").output()
        && output.status.success()
    {
        let dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if dir.join("initdb").exists() {
            return dir;
        }
    }
    if let Ok(entries) = std::fs::read_dir("/usr/lib/postgresql") {
        let mut majors: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("bin"))
            .filter(|bin| bin.join("initdb").exists())
            .collect();
        majors.sort();
        if let Some(bin) = majors.pop() {
            return bin;
        }
    }
    panic!(
        "PostgreSQL server binaries not found (P02_PG_BINDIR, pg_config --bindir, \
         /usr/lib/postgresql/*/bin): database tests refuse to pass without a database"
    );
}

/// A running throwaway cluster with the P02 database migrated.
pub struct TestDatabase {
    root: PathBuf,
    bindir: PathBuf,
    postmaster: Option<Child>,
    pub migration: MigrationReport,
}

fn run(bindir: &Path, program: &str, args: &[&str]) {
    let status = Command::new(bindir.join(program))
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap_or_else(|error| panic!("{program} could not start: {error}"));
    assert!(status.success(), "{program} failed: {status}");
}

impl TestDatabase {
    /// Start a cluster, provision the roles and apply every migration.
    pub async fn start() -> Self {
        let bindir = postgres_bindir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0);
        // Short path: a Unix socket path is limited to about 100 bytes.
        let root = PathBuf::from(format!(
            "/tmp/p02pg-{}-{}-{nanos}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&root).expect("cluster directory");
        let data = root.join("data");
        let data_arg = data.to_str().expect("utf-8 path");
        run(
            &bindir,
            "initdb",
            &[
                "-D",
                data_arg,
                "-U",
                BOOTSTRAP,
                "-A",
                "trust",
                "-E",
                "UTF8",
                "--locale=C",
                "--no-sync",
            ],
        );
        let postmaster = Command::new(bindir.join("postgres"))
            .args(["-D", data_arg, "-k", root.to_str().expect("utf-8 path")])
            .args([
                "-c",
                "listen_addresses=",
                "-c",
                "fsync=off",
                "-c",
                "unix_socket_permissions=0700",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("postgres starts");
        let mut database = Self {
            root,
            bindir,
            postmaster: Some(postmaster),
            migration: MigrationReport {
                verified: 0,
                applied: 0,
            },
        };
        let bootstrap = database.wait_for(BOOTSTRAP, "postgres").await;
        // Separate statements: CREATE DATABASE refuses an implicit transaction.
        for statement in [
            format!("CREATE ROLE {MIGRATOR} LOGIN CREATEROLE"),
            format!("CREATE DATABASE {DATABASE} OWNER {MIGRATOR}"),
            format!("REVOKE ALL ON DATABASE {DATABASE} FROM PUBLIC"),
        ] {
            bootstrap
                .batch_execute(&statement)
                .await
                .expect("migrator provisioned");
        }
        let mut migrator = database.connect(MIGRATOR).await;
        database.migration = migrate(&mut migrator).await.expect("migrations apply");
        let bootstrap = database.connect_to(BOOTSTRAP, DATABASE).await;
        bootstrap
            .batch_execute(&format!(
                "CREATE ROLE {API_LOGIN} LOGIN NOINHERIT IN ROLE p02_api;\
                 CREATE ROLE {WORKER_LOGIN} LOGIN NOINHERIT IN ROLE p02_worker;\
                 GRANT CONNECT ON DATABASE {DATABASE} TO {API_LOGIN}, {WORKER_LOGIN};"
            ))
            .await
            .expect("runtime logins provisioned");
        database
    }

    async fn wait_for(&self, user: &str, dbname: &str) -> Client {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(client) = self.try_connect(user, dbname).await {
                return client;
            }
            assert!(
                Instant::now() < deadline,
                "postgres did not accept connections"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn try_connect(&self, user: &str, dbname: &str) -> Result<Client, tokio_postgres::Error> {
        let mut config = Config::new();
        config.host_path(&self.root).user(user).dbname(dbname);
        let (client, connection) = config.connect(NoTls).await?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(client)
    }

    /// Connect to the P02 database as `user`.
    pub async fn connect(&self, user: &str) -> Client {
        self.connect_to(user, DATABASE).await
    }

    async fn connect_to(&self, user: &str, dbname: &str) -> Client {
        self.try_connect(user, dbname).await.expect("connection")
    }

    /// Socket directory, for clients built outside this harness.
    pub fn socket_dir(&self) -> &Path {
        &self.root
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        if let Some(data) = self.root.join("data").to_str() {
            let _ = Command::new(self.bindir.join("pg_ctl"))
                .args(["stop", "-D", data, "-m", "immediate", "-w"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        if let Some(mut child) = self.postmaster.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
