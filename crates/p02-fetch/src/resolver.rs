//! DNS resolution, performed once per hop by the fetcher itself.
//!
//! The fetcher never hands a host name to a library that could resolve it
//! again: it asks a [`Resolver`] once, validates the whole answer with the
//! destination policy, and dials the validated addresses. This closes the
//! validate-then-resolve-again window of the historical `feed-radar` fetcher
//! (DNS rebinding, PRD 12 risk R1).

use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;

/// Most addresses kept from one answer. A larger answer is truncated after
/// validation of every address it carried.
pub const MAX_ADDRESSES_PER_ANSWER: usize = 16;

/// Future returned by [`Resolver::resolve`].
pub type ResolveFuture<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>>;

/// A source of DNS answers.
pub trait Resolver: Send + Sync + 'static {
    /// Resolve `host` (a DNS name, never an IP literal) to its addresses.
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a>;
}

/// The operating system resolver (`getaddrinfo` on the blocking pool).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move {
            let answer = tokio::net::lookup_host((host, 0_u16)).await?;
            Ok(answer.map(|socket| socket.ip()).collect())
        })
    }
}

/// Deduplicate an answer while keeping its order.
pub(crate) fn dedupe(addresses: Vec<IpAddr>) -> Vec<IpAddr> {
    let mut unique: Vec<IpAddr> = Vec::with_capacity(addresses.len());
    for address in addresses {
        if !unique.contains(&address) {
            unique.push(address);
        }
    }
    unique
}
