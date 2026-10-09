//! Fetch bounds (G5). The production presets are the G5 values; callers may
//! only tighten them, never loosen them.

use std::time::Duration;

use crate::error::SetupError;

/// G5 connect bound.
pub const CONNECT_TIMEOUT_CEILING: Duration = Duration::from_secs(5);
/// G5 total bound, from the first DNS query to the last body byte of the last hop.
pub const TOTAL_TIMEOUT_CEILING: Duration = Duration::from_secs(20);
/// G5 decoded body bound for a feed.
pub const FEED_BODY_CEILING: u64 = 5 * 1024 * 1024;
/// G5 decoded body bound for a page.
pub const PAGE_BODY_CEILING: u64 = 10 * 1024 * 1024;
/// G4 redirect bound.
pub const REDIRECT_CEILING: u8 = 3;
/// G5 concurrency bound per host.
pub const PER_HOST_CONCURRENCY: usize = 2;
/// G5 concurrency bound for the whole worker.
pub const GLOBAL_CONCURRENCY: usize = 16;
/// Largest response head accepted; feeds and pages have no reason to send more.
pub const MAX_RESPONSE_HEAD_BYTES: usize = 64 * 1024;

/// What is being fetched; it selects the body ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    Feed,
    Page,
}

impl BodyKind {
    pub const fn ceiling(self) -> u64 {
        match self {
            Self::Feed => FEED_BODY_CEILING,
            Self::Page => PAGE_BODY_CEILING,
        }
    }
}

/// Validated bounds of one fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchLimits {
    connect_timeout: Duration,
    total_timeout: Duration,
    max_redirects: u8,
    /// Optional tighter body bound; the kind's ceiling applies otherwise.
    max_body_bytes: Option<u64>,
}

impl FetchLimits {
    /// The G5 values.
    pub const fn production() -> Self {
        Self {
            connect_timeout: CONNECT_TIMEOUT_CEILING,
            total_timeout: TOTAL_TIMEOUT_CEILING,
            max_redirects: REDIRECT_CEILING,
            max_body_bytes: None,
        }
    }

    /// Tighter bounds; any value above its G5 ceiling, or a zero duration or
    /// body bound, is refused.
    pub fn tightened(
        connect_timeout: Duration,
        total_timeout: Duration,
        max_redirects: u8,
        max_body_bytes: Option<u64>,
    ) -> Result<Self, SetupError> {
        let durations_ok = !connect_timeout.is_zero()
            && !total_timeout.is_zero()
            && connect_timeout <= CONNECT_TIMEOUT_CEILING
            && total_timeout <= TOTAL_TIMEOUT_CEILING;
        let body_ok = max_body_bytes.is_none_or(|bytes| bytes > 0 && bytes <= PAGE_BODY_CEILING);
        if !durations_ok || !body_ok || max_redirects > REDIRECT_CEILING {
            return Err(SetupError::LimitsOutOfBounds);
        }
        Ok(Self {
            connect_timeout,
            total_timeout,
            max_redirects,
            max_body_bytes,
        })
    }

    pub const fn connect_timeout(&self) -> Duration {
        self.connect_timeout
    }

    pub const fn total_timeout(&self) -> Duration {
        self.total_timeout
    }

    pub const fn max_redirects(&self) -> u8 {
        self.max_redirects
    }

    /// Effective decoded body bound for `kind`.
    pub fn body_bound(&self, kind: BodyKind) -> u64 {
        match self.max_body_bytes {
            Some(bytes) => bytes.min(kind.ceiling()),
            None => kind.ceiling(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn production_limits_are_the_g5_values() {
        let limits = FetchLimits::production();
        assert_eq!(limits.connect_timeout(), Duration::from_secs(5));
        assert_eq!(limits.total_timeout(), Duration::from_secs(20));
        assert_eq!(limits.max_redirects(), 3);
        assert_eq!(limits.body_bound(BodyKind::Feed), 5 * 1024 * 1024);
        assert_eq!(limits.body_bound(BodyKind::Page), 10 * 1024 * 1024);
        assert_eq!(PER_HOST_CONCURRENCY, 2);
        assert_eq!(GLOBAL_CONCURRENCY, 16);
    }

    #[test]
    fn limits_can_be_tightened_but_never_loosened() {
        let tight = FetchLimits::tightened(
            Duration::from_millis(100),
            Duration::from_millis(500),
            1,
            Some(1024),
        )
        .expect("tighter limits are accepted");
        assert_eq!(tight.body_bound(BodyKind::Page), 1024);

        let ms = Duration::from_millis;
        for (connect, total, redirects, body) in [
            (Duration::from_secs(6), ms(500), 1, None),
            (ms(100), Duration::from_secs(21), 1, None),
            (ms(100), ms(500), 4, None),
            (ms(100), ms(500), 1, Some(PAGE_BODY_CEILING + 1)),
            (Duration::ZERO, ms(500), 1, None),
            (ms(100), Duration::ZERO, 1, None),
            (ms(100), ms(500), 1, Some(0)),
        ] {
            assert_eq!(
                FetchLimits::tightened(connect, total, redirects, body),
                Err(SetupError::LimitsOutOfBounds)
            );
        }
    }

    #[test]
    fn a_tight_body_bound_never_raises_the_feed_ceiling() {
        let limits = FetchLimits::tightened(
            Duration::from_secs(1),
            Duration::from_secs(1),
            0,
            Some(PAGE_BODY_CEILING),
        )
        .expect("page ceiling is a valid bound");
        assert_eq!(limits.body_bound(BodyKind::Feed), FEED_BODY_CEILING);
    }
}
