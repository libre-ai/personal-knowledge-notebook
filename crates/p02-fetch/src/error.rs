//! Typed refusals and failures of the safe fetcher.
//!
//! Every variant maps to a stable machine code ([`FetchError::code`]) so the
//! worker can record source health without ever logging a URL, a host or a
//! response body (G8). `Display` carries no request data either: an error can
//! be written to a journal as is.

use thiserror::Error;

/// Why a fetch was refused or failed. Variants never embed the URL, the host,
/// a resolved address or any response content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum FetchError {
    #[error("the URL is malformed or too long")]
    UrlInvalid,
    #[error("only http and https URLs may be fetched")]
    SchemeForbidden,
    #[error("credentials in the URL are refused")]
    CredentialsForbidden,
    #[error("only the default http and https ports may be fetched")]
    PortForbidden,
    #[error("the destination is not a public unicast address")]
    DestinationForbidden,
    #[error("the host name resolved to no address")]
    DnsNoAddress,
    #[error("the host name could not be resolved")]
    DnsFailed,
    #[error("the connection could not be established")]
    ConnectFailed,
    #[error("the connection was not established within the connect bound")]
    ConnectTimeout,
    #[error("the TLS handshake failed")]
    TlsFailed,
    #[error("the fetch did not complete within the total time bound")]
    TotalTimeout,
    #[error("the response violated HTTP/1.1")]
    HttpProtocol,
    #[error("a redirect carried no usable Location")]
    RedirectInvalid,
    #[error("the redirect bound was exceeded")]
    RedirectLimit,
    #[error("a redirect from https to http was refused")]
    RedirectDowngrade,
    #[error("the decoded body exceeded the size bound")]
    BodyTooLarge,
    #[error("the response used an unsupported content encoding")]
    EncodingUnsupported,
    #[error("the compressed body could not be decoded")]
    DecodingFailed,
    #[error("a conditional request validator is not a valid header value")]
    ValidatorInvalid,
    #[error("the fetcher is shutting down")]
    Unavailable,
}

impl FetchError {
    /// Stable code recorded in source health and journals.
    pub const fn code(self) -> &'static str {
        match self {
            Self::UrlInvalid => "fetch.url_invalid",
            Self::SchemeForbidden => "fetch.scheme_forbidden",
            Self::CredentialsForbidden => "fetch.credentials_forbidden",
            Self::PortForbidden => "fetch.port_forbidden",
            Self::DestinationForbidden => "fetch.destination_forbidden",
            Self::DnsNoAddress => "fetch.dns_no_address",
            Self::DnsFailed => "fetch.dns_failed",
            Self::ConnectFailed => "fetch.connect_failed",
            Self::ConnectTimeout => "fetch.connect_timeout",
            Self::TlsFailed => "fetch.tls_failed",
            Self::TotalTimeout => "fetch.total_timeout",
            Self::HttpProtocol => "fetch.http_protocol",
            Self::RedirectInvalid => "fetch.redirect_invalid",
            Self::RedirectLimit => "fetch.redirect_limit",
            Self::RedirectDowngrade => "fetch.redirect_downgrade",
            Self::BodyTooLarge => "fetch.body_too_large",
            Self::EncodingUnsupported => "fetch.encoding_unsupported",
            Self::DecodingFailed => "fetch.decoding_failed",
            Self::ValidatorInvalid => "fetch.validator_invalid",
            Self::Unavailable => "fetch.unavailable",
        }
    }
}

/// Failure to build a fetcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SetupError {
    #[error("no trusted root certificate could be loaded from the platform")]
    NoTrustRoots,
    #[error("the TLS configuration could not be built")]
    TlsConfig,
    #[error("the requested limits exceed the G5 ceilings or are zero")]
    LimitsOutOfBounds,
    #[error("the user agent is not a valid header value")]
    UserAgentInvalid,
}
