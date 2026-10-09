//! P02 worker (PRD 12 §3.7, owner decisions Y4/Y34/Y35).
//!
//! One job at a time: claim from the dispatch table, read the command in the
//! job's tenant context, validate it against p02-job-v1, fetch through the
//! safe fetcher, and record a p02-job-v1 result. A policy refusal is final; a
//! transient failure goes back to the queue until `max_claims` is reached.
//! The worker never logs a URL, a host, a header or a body (G8).

pub mod config;

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use p02_domain::job::{
    self, BodyDigest, FetchSourceOutcome, FetchSourceType, JobCommand, JobDocument, JobResult,
    ReasonCode, ResultKind, SchemaVersion, Status,
};
use p02_fetch::{FetchError, FetchOutcome, FetchRequest, ResponseMeta, SafeFetcher};
use p02_store::StoreError;
use p02_store::queue::{self, Claim, Terminal};
use serde_json::Value;
use tokio_postgres::Client;

/// Future returned by [`Fetch::fetch`].
pub type FetchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<FetchOutcome, FetchError>> + Send + 'a>>;

/// What the worker fetches with: the safe fetcher in production, a scripted
/// double in tests (SSRF behaviour is proved in `p02-fetch` itself).
pub trait Fetch: Send + Sync {
    fn fetch<'a>(&'a self, request: &'a FetchRequest) -> FetchFuture<'a>;
}

impl Fetch for SafeFetcher {
    fn fetch<'a>(&'a self, request: &'a FetchRequest) -> FetchFuture<'a> {
        Box::pin(SafeFetcher::fetch(self, request))
    }
}

/// Worker tuning.
#[derive(Debug, Clone)]
pub struct WorkerSettings {
    /// Prefix of this worker's lease tokens.
    pub worker_id: String,
    /// Lease per claim; longer than the fetcher's 20 s total bound.
    pub lease: Duration,
    /// Claims after which a transient failure becomes final.
    pub max_claims: i32,
    /// First retry delay, doubled per claim, capped at one hour.
    pub retry_base: Duration,
}

impl Default for WorkerSettings {
    fn default() -> Self {
        Self {
            worker_id: format!("p02-worker-{}", std::process::id()),
            lease: Duration::from_secs(60),
            max_claims: 5,
            retry_base: Duration::from_secs(30),
        }
    }
}

/// What one call to [`process_one`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Processed {
    /// No ready job.
    Idle,
    /// A job reached a final state.
    Completed,
    /// A job went back to the queue after a transient failure.
    Retried,
}

/// Process at most one ready job.
pub async fn process_one(
    client: &mut Client,
    fetcher: &dyn Fetch,
    settings: &WorkerSettings,
) -> Result<Processed, StoreError> {
    let Some(claim) = queue::claim(client, &settings.worker_id, settings.lease).await? else {
        return Ok(Processed::Idle);
    };
    let raw = queue::load_command(client, &claim).await?;
    let Some(command) = command_for(&claim, &raw) else {
        let result = reason_result(&claim, ReasonCode::JobCommandInvalid);
        return finish(client, &claim, &result).await;
    };
    let request = FetchRequest {
        url: command.operation.url.clone(),
        kind: match command.operation.body_kind {
            job::BodyKind::Feed => p02_fetch::BodyKind::Feed,
            job::BodyKind::Page => p02_fetch::BodyKind::Page,
        },
        validators: p02_fetch::Validators {
            etag: command
                .operation
                .validators
                .as_ref()
                .and_then(|v| v.etag.clone()),
            last_modified: command
                .operation
                .validators
                .as_ref()
                .and_then(|v| v.last_modified.clone()),
        },
    };
    match fetcher.fetch(&request).await {
        Ok(outcome) => {
            let result = outcome_result(&claim, &outcome);
            finish(client, &claim, &result).await
        }
        Err(error) => {
            let code = reason_for(error);
            if code.status() == Status::Failed && claim.claims < settings.max_claims {
                let delay = retry_delay(settings.retry_base, claim.claims);
                queue::release_for_retry(client, &claim, delay).await?;
                Ok(Processed::Retried)
            } else {
                finish(client, &claim, &reason_result(&claim, code)).await
            }
        }
    }
}

/// The command, if it is a valid p02-job-v1 command for exactly this claim.
fn command_for(claim: &Claim, raw: &Value) -> Option<JobCommand> {
    let bytes = serde_json::to_vec(raw).ok()?;
    match job::parse_document(&bytes).ok()? {
        JobDocument::Command(command)
            if command.tenant_id == claim.tenant.as_str() && command.job_id == claim.job_id =>
        {
            Some(command)
        }
        _ => None,
    }
}

async fn finish(
    client: &mut Client,
    claim: &Claim,
    result: &JobResult,
) -> Result<Processed, StoreError> {
    // A result that would not pass the contract is not written as is: the
    // job is refused instead, which always validates.
    let result = match result.validate() {
        Ok(()) => result.clone(),
        Err(_) => reason_result(claim, ReasonCode::FetchUrlInvalid),
    };
    let terminal = match result.status {
        Status::Succeeded => Terminal::Succeeded,
        Status::Refused => Terminal::Refused,
        Status::Failed => Terminal::Failed,
    };
    let document = serde_json::to_value(&result).map_err(|_| StoreError::JobMissing)?;
    queue::complete(client, claim, terminal, &document).await?;
    Ok(Processed::Completed)
}

fn base_result(claim: &Claim, status: Status) -> JobResult {
    JobResult {
        schema_version: SchemaVersion::V1,
        kind: ResultKind::Result,
        job_id: claim.job_id.clone(),
        tenant_id: claim.tenant.as_str().to_owned(),
        completed_at: rfc3339_now(),
        status,
        outcome: None,
        reason_code: None,
    }
}

fn reason_result(claim: &Claim, code: ReasonCode) -> JobResult {
    JobResult {
        reason_code: Some(code),
        ..base_result(claim, code.status())
    }
}

fn recordable(value: Option<&String>, max: usize) -> Option<String> {
    value
        .filter(|value| job::is_recordable_header(value, max))
        .cloned()
}

fn outcome_result(claim: &Claim, outcome: &FetchOutcome) -> JobResult {
    let (meta, not_modified, body) = match outcome {
        FetchOutcome::Body { meta, body } => (
            meta,
            false,
            Some(BodyDigest {
                bytes: body.len() as u64,
                blake3: blake3::hash(body).to_hex().to_string(),
            }),
        ),
        FetchOutcome::NotModified { meta } => (meta, true, None),
        FetchOutcome::Status { meta } => (meta, false, None),
    };
    JobResult {
        outcome: Some(fetch_outcome(meta, not_modified, body)),
        ..base_result(claim, Status::Succeeded)
    }
}

fn fetch_outcome(
    meta: &ResponseMeta,
    not_modified: bool,
    body: Option<BodyDigest>,
) -> FetchSourceOutcome {
    FetchSourceOutcome {
        kind: FetchSourceType::FetchSource,
        final_url: meta.final_url.as_str().to_owned(),
        http_status: meta.status,
        redirects: meta.redirects,
        not_modified,
        etag: recordable(meta.etag.as_ref(), 1024),
        last_modified: recordable(meta.last_modified.as_ref(), 1024),
        content_type: recordable(meta.content_type.as_ref(), 255),
        retry_after: recordable(meta.retry_after.as_ref(), 1024),
        body,
    }
}

/// The contract code of a fetch error (same stable code string).
pub fn reason_for(error: FetchError) -> ReasonCode {
    match error {
        FetchError::UrlInvalid => ReasonCode::FetchUrlInvalid,
        FetchError::SchemeForbidden => ReasonCode::FetchSchemeForbidden,
        FetchError::CredentialsForbidden => ReasonCode::FetchCredentialsForbidden,
        FetchError::PortForbidden => ReasonCode::FetchPortForbidden,
        FetchError::DestinationForbidden => ReasonCode::FetchDestinationForbidden,
        FetchError::DnsNoAddress => ReasonCode::FetchDnsNoAddress,
        FetchError::DnsFailed => ReasonCode::FetchDnsFailed,
        FetchError::ConnectFailed => ReasonCode::FetchConnectFailed,
        FetchError::ConnectTimeout => ReasonCode::FetchConnectTimeout,
        FetchError::TlsFailed => ReasonCode::FetchTlsFailed,
        FetchError::TotalTimeout => ReasonCode::FetchTotalTimeout,
        FetchError::HttpProtocol => ReasonCode::FetchHttpProtocol,
        FetchError::RedirectInvalid => ReasonCode::FetchRedirectInvalid,
        FetchError::RedirectLimit => ReasonCode::FetchRedirectLimit,
        FetchError::RedirectDowngrade => ReasonCode::FetchRedirectDowngrade,
        FetchError::BodyTooLarge => ReasonCode::FetchBodyTooLarge,
        FetchError::EncodingUnsupported => ReasonCode::FetchEncodingUnsupported,
        FetchError::DecodingFailed => ReasonCode::FetchDecodingFailed,
        FetchError::ValidatorInvalid => ReasonCode::FetchValidatorInvalid,
        FetchError::Unavailable => ReasonCode::FetchUnavailable,
    }
}

fn retry_delay(base: Duration, claims: i32) -> Duration {
    let exponent = u32::try_from(claims.saturating_sub(1)).unwrap_or(0).min(16);
    base.saturating_mul(1_u32 << exponent)
        .min(Duration::from_secs(3600))
}

/// Current UTC time as an RFC 3339 timestamp with whole seconds.
pub fn rfc3339_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    rfc3339(seconds)
}

fn rfc3339(unix_seconds: u64) -> String {
    let days = unix_seconds / 86_400;
    let rem = unix_seconds % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (H. Hinnant), valid for every u64 day count used here.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_791_532_800), "2026-10-09T08:00:00Z");
    }

    #[test]
    fn every_fetch_error_maps_to_the_code_of_the_same_name() {
        for error in [
            FetchError::UrlInvalid,
            FetchError::SchemeForbidden,
            FetchError::CredentialsForbidden,
            FetchError::PortForbidden,
            FetchError::DestinationForbidden,
            FetchError::DnsNoAddress,
            FetchError::DnsFailed,
            FetchError::ConnectFailed,
            FetchError::ConnectTimeout,
            FetchError::TlsFailed,
            FetchError::TotalTimeout,
            FetchError::HttpProtocol,
            FetchError::RedirectInvalid,
            FetchError::RedirectLimit,
            FetchError::RedirectDowngrade,
            FetchError::BodyTooLarge,
            FetchError::EncodingUnsupported,
            FetchError::DecodingFailed,
            FetchError::ValidatorInvalid,
            FetchError::Unavailable,
        ] {
            let code = serde_json::to_value(reason_for(error)).unwrap();
            assert_eq!(code, error.code(), "{error:?}");
        }
    }

    #[test]
    fn retry_delay_doubles_and_is_capped() {
        let base = Duration::from_secs(30);
        assert_eq!(retry_delay(base, 1), Duration::from_secs(30));
        assert_eq!(retry_delay(base, 2), Duration::from_secs(60));
        assert_eq!(retry_delay(base, 40), Duration::from_secs(3600));
    }
}
