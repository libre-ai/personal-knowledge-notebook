//! Ordered, checksummed migrations.
//!
//! The SQL is compiled into the binary, so the migration a deployment applies
//! is the one its build was tested with. Each migration runs in its own
//! transaction under a session advisory lock; an applied migration whose
//! recorded SHA-256 differs from the embedded one stops everything
//! (`MigrationDrift`), and so does a recorded version this build does not know
//! (`MigrationUnknown`): a binary never runs against a schema it did not ship.

use sha2::{Digest, Sha256};
use tokio_postgres::Client;

use crate::error::StoreError;

/// One embedded migration.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i32,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Every migration of this build, in order.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "roles_and_queue",
    sql: include_str!("../migrations/0001_roles_and_queue.sql"),
}];

/// Lock key shared by every migrating process ("p02mig" in ASCII).
const ADVISORY_LOCK_KEY: i64 = 0x7030_326d_6967;

/// What a migration run did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Migrations already present and verified against their checksum.
    pub verified: usize,
    /// Migrations applied by this run.
    pub applied: usize,
}

pub fn checksum(sql: &str) -> String {
    let digest = Sha256::digest(sql.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Apply every pending migration. `client` must be connected as the P02
/// migration role.
pub async fn migrate(client: &mut Client) -> Result<MigrationReport, StoreError> {
    client
        .execute("SELECT pg_advisory_lock($1)", &[&ADVISORY_LOCK_KEY])
        .await?;
    let outcome = apply_all(client).await;
    // Unlock whatever happened; a failed unlock only matters if the session
    // survives, and then it is a database error worth reporting.
    let unlocked = client
        .execute("SELECT pg_advisory_unlock($1)", &[&ADVISORY_LOCK_KEY])
        .await;
    let report = outcome?;
    unlocked?;
    Ok(report)
}

async fn apply_all(client: &mut Client) -> Result<MigrationReport, StoreError> {
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS public.p02_schema_migrations (\
               version integer PRIMARY KEY,\
               name text NOT NULL,\
               sha256 text NOT NULL,\
               applied_at timestamptz NOT NULL DEFAULT now())",
        )
        .await?;
    let applied = client
        .query(
            "SELECT version, sha256 FROM public.p02_schema_migrations ORDER BY version",
            &[],
        )
        .await?;
    let mut verified = 0;
    for row in &applied {
        let version: i32 = row.get(0);
        let recorded: String = row.get(1);
        let migration = MIGRATIONS
            .iter()
            .find(|migration| migration.version == version)
            .ok_or(StoreError::MigrationUnknown)?;
        if checksum(migration.sql) != recorded {
            return Err(StoreError::MigrationDrift);
        }
        verified += 1;
    }
    let mut newly = 0;
    for migration in MIGRATIONS {
        let already = applied
            .iter()
            .any(|row| row.get::<_, i32>(0) == migration.version);
        if already {
            continue;
        }
        let transaction = client.transaction().await?;
        transaction.batch_execute(migration.sql).await?;
        transaction
            .execute(
                "INSERT INTO public.p02_schema_migrations (version, name, sha256) VALUES ($1, $2, $3)",
                &[&migration.version, &migration.name, &checksum(migration.sql)],
            )
            .await?;
        transaction.commit().await?;
        newly += 1;
    }
    Ok(MigrationReport {
        verified,
        applied: newly,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_numbered_contiguously_from_one() {
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            assert_eq!(migration.version, i32::try_from(index).unwrap() + 1);
        }
    }

    #[test]
    fn checksum_is_lowercase_sha256_hex() {
        assert_eq!(
            checksum(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
