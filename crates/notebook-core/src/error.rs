/// Closed refusal surface shared by the native core and WIT adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCode {
    InvalidDocument,
    InvalidSealRequest,
    InvalidEnvelope,
    UnsupportedVersion,
    ResourceLimitExceeded,
    AuthenticationFailed,
    InternalFailure,
}
