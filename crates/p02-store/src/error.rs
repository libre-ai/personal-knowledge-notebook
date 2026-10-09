use thiserror::Error;

/// Store failures. Messages carry no tenant data, command or result content.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("the database refused or failed the operation")]
    Database(#[source] tokio_postgres::Error),
    #[error("an applied migration differs from the one this build carries")]
    MigrationDrift,
    #[error("the database carries a migration this build does not know")]
    MigrationUnknown,
    #[error("the tenant identifier is malformed")]
    TenantInvalid,
    #[error("the job lease was lost to another worker")]
    LeaseLost,
    #[error("the job row is missing or unreadable in its tenant context")]
    JobMissing,
}

impl From<tokio_postgres::Error> for StoreError {
    fn from(error: tokio_postgres::Error) -> Self {
        Self::Database(error)
    }
}
