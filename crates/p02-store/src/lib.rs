//! P02 PostgreSQL store (PRD 12 §3.7, owner decisions Y34/Y35).
//!
//! - [`migrate`]: ordered, checksummed migrations, run by the P02 migration
//!   role through `p02-worker migrate`, never by a runtime role.
//! - [`TenantId`]: the organization a transaction is scoped to; row-level
//!   security reads it from the transaction-local `app.tenant_id`.
//! - [`queue`]: the worker side of the job queue. The worker claims a job from
//!   the dispatch table (identifiers only), then reads the command and writes
//!   the result inside that job's tenant context only.

mod error;
pub mod migrate;
pub mod queue;
mod tenant;
#[cfg(feature = "testing")]
pub mod testing;

pub use error::StoreError;
pub use tenant::TenantId;
