//! The p02-job-v1 contract (libre-ai/schemas-and-contracts, vendored at the
//! commit pinned in `vendored/contracts/p02-job-v1/provenance.json`).
//!
//! Shape is closed by serde (`deny_unknown_fields`, duplicate fields refused);
//! every pattern, bound and coherence rule of the schema is checked by
//! [`JobCommand::validate`] / [`JobResult::validate`]. The conformance test
//! runs the authority's vectors through [`parse_document`]: both runtimes must
//! give the authority's verdict on every vector.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Exact `schemaVersion` of every v1 document.
pub const SCHEMA_VERSION: &str = "libre-ai.p02-job.v1";
/// Largest decoded body a result may record (the page ceiling).
pub const MAX_BODY_BYTES: u64 = 10 * 1024 * 1024;
/// Largest redirect count a result may record.
pub const MAX_REDIRECTS: u8 = 3;
const MAX_URL_BYTES: usize = 2048;
const MIN_URL_BYTES: usize = 8;
const MAX_HEADER_BYTES: usize = 1024;
const MAX_CONTENT_TYPE_BYTES: usize = 255;

/// Why a document is not a valid p02-job-v1 command or result. Variants
/// carry no document content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ContractError {
    #[error("the document is not a closed p02-job-v1 JSON object")]
    Shape,
    #[error("the schema version is not p02-job-v1")]
    SchemaVersion,
    #[error("an identifier is malformed")]
    Identifier,
    #[error("the tenant identifier is malformed")]
    Tenant,
    #[error("the idempotency key is malformed")]
    IdempotencyKey,
    #[error("a timestamp is not an RFC 3339 date-time")]
    Timestamp,
    #[error("a URL is outside the contract's http(s) shape")]
    Url,
    #[error("a header value is outside printable ASCII bounds")]
    HeaderValue,
    #[error("the outcome is incoherent or out of bounds")]
    Outcome,
    #[error("status, outcome and reason code disagree")]
    Status,
}

/// `schemaVersion`: a single admitted value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SchemaVersion {
    #[serde(rename = "libre-ai.p02-job.v1")]
    V1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandKind {
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultKind {
    Result,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyKind {
    Feed,
    Page,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Validators {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FetchSourceType {
    #[serde(rename = "fetch-source")]
    FetchSource,
}

/// The `fetch-source` operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FetchSource {
    #[serde(rename = "type")]
    pub kind: FetchSourceType,
    pub source_id: String,
    pub url: String,
    pub body_kind: BodyKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validators: Option<Validators>,
}

/// A command the API enqueues for the worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JobCommand {
    pub schema_version: SchemaVersion,
    pub kind: CommandKind,
    pub job_id: String,
    pub tenant_id: String,
    pub idempotency_key: String,
    pub enqueued_at: String,
    pub operation: FetchSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Succeeded,
    Refused,
    Failed,
}

impl Status {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }
}

/// Closed reason codes of refused and failed results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReasonCode {
    #[serde(rename = "fetch.url_invalid")]
    FetchUrlInvalid,
    #[serde(rename = "fetch.scheme_forbidden")]
    FetchSchemeForbidden,
    #[serde(rename = "fetch.credentials_forbidden")]
    FetchCredentialsForbidden,
    #[serde(rename = "fetch.port_forbidden")]
    FetchPortForbidden,
    #[serde(rename = "fetch.destination_forbidden")]
    FetchDestinationForbidden,
    #[serde(rename = "fetch.redirect_invalid")]
    FetchRedirectInvalid,
    #[serde(rename = "fetch.redirect_limit")]
    FetchRedirectLimit,
    #[serde(rename = "fetch.redirect_downgrade")]
    FetchRedirectDowngrade,
    #[serde(rename = "fetch.body_too_large")]
    FetchBodyTooLarge,
    #[serde(rename = "fetch.encoding_unsupported")]
    FetchEncodingUnsupported,
    #[serde(rename = "fetch.validator_invalid")]
    FetchValidatorInvalid,
    #[serde(rename = "job.command_invalid")]
    JobCommandInvalid,
    #[serde(rename = "fetch.dns_no_address")]
    FetchDnsNoAddress,
    #[serde(rename = "fetch.dns_failed")]
    FetchDnsFailed,
    #[serde(rename = "fetch.connect_failed")]
    FetchConnectFailed,
    #[serde(rename = "fetch.connect_timeout")]
    FetchConnectTimeout,
    #[serde(rename = "fetch.tls_failed")]
    FetchTlsFailed,
    #[serde(rename = "fetch.total_timeout")]
    FetchTotalTimeout,
    #[serde(rename = "fetch.http_protocol")]
    FetchHttpProtocol,
    #[serde(rename = "fetch.decoding_failed")]
    FetchDecodingFailed,
    #[serde(rename = "fetch.unavailable")]
    FetchUnavailable,
    #[serde(rename = "job.lease_expired")]
    JobLeaseExpired,
    #[serde(rename = "job.attempts_exhausted")]
    JobAttemptsExhausted,
    #[serde(rename = "job.store_unavailable")]
    JobStoreUnavailable,
}

impl ReasonCode {
    /// The status this code belongs to: policy refusals are final, the rest
    /// are transient failures.
    pub const fn status(self) -> Status {
        match self {
            Self::FetchUrlInvalid
            | Self::FetchSchemeForbidden
            | Self::FetchCredentialsForbidden
            | Self::FetchPortForbidden
            | Self::FetchDestinationForbidden
            | Self::FetchRedirectInvalid
            | Self::FetchRedirectLimit
            | Self::FetchRedirectDowngrade
            | Self::FetchBodyTooLarge
            | Self::FetchEncodingUnsupported
            | Self::FetchValidatorInvalid
            | Self::JobCommandInvalid => Status::Refused,
            Self::FetchDnsNoAddress
            | Self::FetchDnsFailed
            | Self::FetchConnectFailed
            | Self::FetchConnectTimeout
            | Self::FetchTlsFailed
            | Self::FetchTotalTimeout
            | Self::FetchHttpProtocol
            | Self::FetchDecodingFailed
            | Self::FetchUnavailable
            | Self::JobLeaseExpired
            | Self::JobAttemptsExhausted
            | Self::JobStoreUnavailable => Status::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BodyDigest {
    pub bytes: u64,
    pub blake3: String,
}

/// The final hop of a completed fetch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FetchSourceOutcome {
    #[serde(rename = "type")]
    pub kind: FetchSourceType,
    pub final_url: String,
    pub http_status: u16,
    pub redirects: u8,
    pub not_modified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<BodyDigest>,
}

/// A result the worker records when a job ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JobResult {
    pub schema_version: SchemaVersion,
    pub kind: ResultKind,
    pub job_id: String,
    pub tenant_id: String,
    pub completed_at: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<FetchSourceOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<ReasonCode>,
}

/// A parsed, validated p02-job-v1 document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobDocument {
    Command(JobCommand),
    Result(JobResult),
}

/// Parse and validate a p02-job-v1 document.
pub fn parse_document(bytes: &[u8]) -> Result<JobDocument, ContractError> {
    #[derive(Deserialize)]
    struct Probe {
        kind: Option<String>,
    }
    let probe: Probe = serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
    match probe.kind.as_deref() {
        Some("command") => {
            let command: JobCommand =
                serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
            command.validate()?;
            Ok(JobDocument::Command(command))
        }
        Some("result") => {
            let result: JobResult =
                serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
            result.validate()?;
            Ok(JobDocument::Result(result))
        }
        _ => Err(ContractError::Shape),
    }
}

impl JobCommand {
    pub fn validate(&self) -> Result<(), ContractError> {
        check_identifier(&self.job_id)?;
        check_tenant(&self.tenant_id)?;
        check_idempotency_key(&self.idempotency_key)?;
        check_timestamp(&self.enqueued_at)?;
        check_identifier(&self.operation.source_id)?;
        check_url(&self.operation.url, UrlRole::Request)?;
        if let Some(validators) = &self.operation.validators {
            if validators.etag.is_none() && validators.last_modified.is_none() {
                return Err(ContractError::HeaderValue);
            }
            for value in [&validators.etag, &validators.last_modified]
                .into_iter()
                .flatten()
            {
                check_header(value, MAX_HEADER_BYTES)?;
            }
        }
        Ok(())
    }
}

impl JobResult {
    pub fn validate(&self) -> Result<(), ContractError> {
        check_identifier(&self.job_id)?;
        check_tenant(&self.tenant_id)?;
        check_timestamp(&self.completed_at)?;
        match (self.status, &self.outcome, self.reason_code) {
            (Status::Succeeded, Some(outcome), None) => outcome.validate(),
            (Status::Refused | Status::Failed, None, Some(code))
                if code.status() == self.status =>
            {
                Ok(())
            }
            _ => Err(ContractError::Status),
        }
    }
}

impl FetchSourceOutcome {
    pub fn validate(&self) -> Result<(), ContractError> {
        check_url(&self.final_url, UrlRole::FinalHop)?;
        let status = self.http_status;
        let coherent = (200..=599).contains(&status)
            && !matches!(status, 301 | 302 | 303 | 307 | 308)
            && self.redirects <= MAX_REDIRECTS
            && (self.not_modified == (status == 304))
            && self.body.as_ref().is_none_or(|body| {
                (200..=299).contains(&status)
                    && body.bytes <= MAX_BODY_BYTES
                    && is_blake3(&body.blake3)
            });
        if !coherent {
            return Err(ContractError::Outcome);
        }
        for value in [&self.etag, &self.last_modified, &self.retry_after]
            .into_iter()
            .flatten()
        {
            check_header(value, MAX_HEADER_BYTES)?;
        }
        if let Some(content_type) = &self.content_type {
            check_header(content_type, MAX_CONTENT_TYPE_BYTES)?;
        }
        Ok(())
    }
}

fn check_identifier(value: &str) -> Result<(), ContractError> {
    // ^[a-z][a-z0-9_-]{2,127}$ (common.v1 identifier)
    let bytes = value.as_bytes();
    let ok = (3..=128).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_lowercase)
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    ok.then_some(()).ok_or(ContractError::Identifier)
}

fn check_tenant(value: &str) -> Result<(), ContractError> {
    // ^ten_[a-z0-9]{16,64}$ (common.v1 tenantId)
    let ok = value.strip_prefix("ten_").is_some_and(|rest| {
        (16..=64).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    });
    ok.then_some(()).ok_or(ContractError::Tenant)
}

fn check_idempotency_key(value: &str) -> Result<(), ContractError> {
    // ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$
    let bytes = value.as_bytes();
    let ok = (1..=128).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    ok.then_some(()).ok_or(ContractError::IdempotencyKey)
}

fn is_blake3(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Printable ASCII, no leading or trailing space:
/// `^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$`.
/// True if `value` may be recorded as a validator or outcome header value
/// (`max` is 1024, or 255 for a content type).
pub fn is_recordable_header(value: &str, max: usize) -> bool {
    check_header(value, max).is_ok()
}

fn check_header(value: &str, max: usize) -> Result<(), ContractError> {
    let bytes = value.as_bytes();
    let visible = |b: &u8| (0x21..=0x7e).contains(b);
    let ok = (1..=max).contains(&bytes.len())
        && bytes.first().is_some_and(visible)
        && bytes.last().is_some_and(visible)
        && bytes.iter().all(|b| (0x20..=0x7e).contains(b));
    ok.then_some(()).ok_or(ContractError::HeaderValue)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UrlRole {
    /// `operation.url`: a fragment is allowed (the worker never sends it).
    Request,
    /// `outcome.finalUrl`: no fragment.
    FinalHop,
}

/// The contract's URL shape:
/// `^https?://AUTHORITY(?::(?:80|443))?(?:[/?#]REST)?$`, where AUTHORITY is a
/// bracketed `[0-9A-Fa-f:.]+` literal or reg-name characters excluding
/// `# / : @ [ \ ]`, and REST is printable ASCII (without `#` for a final hop,
/// whose rest starts with `/` or `?`).
fn check_url(value: &str, role: UrlRole) -> Result<(), ContractError> {
    let bytes = value.as_bytes();
    if !(MIN_URL_BYTES..=MAX_URL_BYTES).contains(&bytes.len()) {
        return Err(ContractError::Url);
    }
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .ok_or(ContractError::Url)?
        .as_bytes();
    // Authority.
    let mut index = 0;
    if rest.first() == Some(&b'[') {
        let close = rest
            .iter()
            .position(|&b| b == b']')
            .ok_or(ContractError::Url)?;
        let literal = rest.get(1..close).ok_or(ContractError::Url)?;
        if literal.is_empty()
            || !literal
                .iter()
                .all(|&b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        {
            return Err(ContractError::Url);
        }
        index = close + 1;
    } else {
        let reg_name = |b: u8| matches!(b, 0x21 | 0x22 | 0x24..=0x2e | 0x30..=0x39 | 0x3b..=0x3e | 0x41..=0x5a | 0x5e..=0x7e);
        while rest.get(index).is_some_and(|&b| reg_name(b)) {
            index += 1;
        }
        if index == 0 {
            return Err(ContractError::Url);
        }
    }
    let after = rest.get(index..).ok_or(ContractError::Url)?;
    let after = if let Some(port_and_rest) = after.strip_prefix(b":") {
        if let Some(remaining) = port_and_rest.strip_prefix(b"443") {
            remaining
        } else if let Some(remaining) = port_and_rest.strip_prefix(b"80") {
            remaining
        } else {
            return Err(ContractError::Url);
        }
    } else {
        after
    };
    let Some((&first, tail)) = after.split_first() else {
        return Ok(());
    };
    let ok = match role {
        UrlRole::Request => {
            matches!(first, b'/' | b'?' | b'#') && tail.iter().all(|b| (0x21..=0x7e).contains(b))
        }
        UrlRole::FinalHop => {
            matches!(first, b'/' | b'?')
                && tail
                    .iter()
                    .all(|&b| (0x21..=0x7e).contains(&b) && b != b'#')
        }
    };
    ok.then_some(()).ok_or(ContractError::Url)
}

/// RFC 3339 `date-time` (the JSON Schema format), leap seconds excluded.
fn check_timestamp(value: &str) -> Result<(), ContractError> {
    parse_timestamp(value.as_bytes()).ok_or(ContractError::Timestamp)
}

fn parse_timestamp(bytes: &[u8]) -> Option<()> {
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let slice = bytes.get(range)?;
        if slice.is_empty() || !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        slice.iter().try_fold(0_u32, |acc, &b| {
            acc.checked_mul(10)?.checked_add(u32::from(b - b'0'))
        })
    };
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b't'))
    {
        return None;
    }
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let second = digits(17..19)?;
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
    }
    match bytes.get(index)? {
        b'Z' | b'z' => (index + 1 == bytes.len()).then_some(()),
        b'+' | b'-' => {
            let offset_hour = digits(index + 1..index + 3)?;
            let offset_minute = digits(index + 4..index + 6)?;
            let well_formed = bytes.get(index + 3) == Some(&b':')
                && index + 6 == bytes.len()
                && offset_hour <= 23
                && offset_minute <= 59;
            well_formed.then_some(())
        }
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_follow_rfc3339() {
        for good in [
            "2026-10-09T08:00:00Z",
            "2026-10-09T08:00:00.123Z",
            "2026-10-09t08:00:00z",
            "2026-10-09T08:00:00+02:00",
            "2024-02-29T00:00:00Z",
        ] {
            assert!(check_timestamp(good).is_ok(), "{good}");
        }
        for bad in [
            "yesterday",
            "2026-10-09",
            "2026-13-09T08:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-10-09T24:00:00Z",
            "2026-10-09T08:00:00",
            "2026-10-09T08:00:00.Z",
            "2026-10-09T08:00:00+2:00",
            "2026-10-09T08:00:00Z ",
        ] {
            assert!(check_timestamp(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn urls_follow_the_contract_shape() {
        for good in [
            "https://feeds.example.org/atom.xml",
            "http://www.example.org/post/1?ref=a@b",
            "https://[2001:4860:4860::8888]:443/feed?x=1#top",
            "http://example.org:80",
        ] {
            assert!(check_url(good, UrlRole::Request).is_ok(), "{good}");
        }
        for bad in [
            "https://user@example.org/feed",
            "http://feeds.example.org:8080/",
            "http://evil.example\\@feeds.example.org/",
            "https://example.org/a b",
            "ftp://example.org/x",
            "http://[zz]/",
            "http:///path",
        ] {
            assert!(check_url(bad, UrlRole::Request).is_err(), "{bad}");
        }
        assert!(check_url("https://example.org/a#top", UrlRole::FinalHop).is_err());
        assert!(check_url("https://example.org/a?b", UrlRole::FinalHop).is_ok());
    }

    #[test]
    fn every_reason_code_maps_to_one_status() {
        let refused =
            serde_json::from_str::<ReasonCode>("\"fetch.destination_forbidden\"").unwrap();
        assert_eq!(refused.status(), Status::Refused);
        let failed = serde_json::from_str::<ReasonCode>("\"fetch.total_timeout\"").unwrap();
        assert_eq!(failed.status(), Status::Failed);
        assert!(serde_json::from_str::<ReasonCode>("\"fetch.attacker_example_com\"").is_err());
    }
}
