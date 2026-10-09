//! P02 safe fetcher (PRD 12, guarantees G4 and G5).
//!
//! Every network access of the P02 worker goes through [`SafeFetcher`]: the
//! destination is checked before any connection, DNS is resolved exactly once
//! per hop and every resolved address is validated before it is dialled,
//! redirects are followed by hand and re-validated, and the body is bounded in
//! bytes and time while it streams.

pub mod address;
mod body;
pub mod error;
mod fetcher;
mod gauge;
pub mod limits;
pub mod policy;
pub mod resolver;

#[cfg(test)]
mod adversarial_tests;
#[cfg(test)]
mod test_support;

pub use error::{FetchError, SetupError};
pub use fetcher::{
    DEFAULT_USER_AGENT, FetchOutcome, FetchRequest, FetcherConfig, ResponseMeta, SafeFetcher,
    Validators,
};
pub use limits::{BodyKind, FetchLimits};
pub use policy::DestinationPolicy;
