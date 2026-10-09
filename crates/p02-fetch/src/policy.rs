//! Destination policy (G4): which URLs and which resolved addresses the
//! worker may connect to.
//!
//! The policy is checked twice per hop, on two different inputs: the URL
//! before any I/O ([`DestinationPolicy::check_url`]) and the complete answer
//! of the single DNS resolution ([`DestinationPolicy::check_resolved`]). The
//! fetcher then dials only addresses that passed the second check, so there is
//! no second resolution an attacker could answer differently.

use std::net::IpAddr;

use url::{Host, Url};

use crate::address::is_public;
use crate::error::FetchError;

/// Longest URL accepted, in bytes. Feed URLs are short; a multi-kilobyte URL
/// is a smuggling vector, not a subscription.
pub const MAX_URL_BYTES: usize = 2048;

/// Scheme of a validated target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

/// Host of a validated target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetHost {
    /// An IP literal, already classified public by the policy.
    Ip(IpAddr),
    /// A DNS name, lower-cased by URL parsing, still to be resolved once.
    Domain(String),
}

/// A URL the policy accepted before any network access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchTarget {
    url: Url,
    scheme: Scheme,
    host: TargetHost,
    port: u16,
}

impl FetchTarget {
    pub fn url(&self) -> &Url {
        &self.url
    }

    pub fn scheme(&self) -> Scheme {
        self.scheme
    }

    pub fn host(&self) -> &TargetHost {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

/// The destination policy. Production code can only build the public
/// internet policy; the loopback allowance used by the adversarial tests is
/// compiled into test builds only.
#[derive(Debug, Clone)]
pub struct DestinationPolicy {
    #[cfg(test)]
    test_allowance: Option<TestAllowance>,
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct TestAllowance {
    addresses: Vec<IpAddr>,
    port: u16,
}

impl DestinationPolicy {
    /// Public unicast destinations on ports 80 and 443 only.
    pub fn public_internet() -> Self {
        Self {
            #[cfg(test)]
            test_allowance: None,
        }
    }

    /// Test builds only: treat `addresses` as public and accept `port`, so a
    /// local fixture server can stand in for a public origin. Every other
    /// address keeps the production classification.
    #[cfg(test)]
    pub(crate) fn for_tests(addresses: Vec<IpAddr>, port: u16) -> Self {
        Self {
            test_allowance: Some(TestAllowance { addresses, port }),
        }
    }

    /// True if `ip` may be dialled.
    pub fn allows_address(&self, ip: IpAddr) -> bool {
        #[cfg(test)]
        if let Some(allowance) = &self.test_allowance
            && allowance.addresses.contains(&ip)
        {
            return true;
        }
        is_public(ip)
    }

    fn allows_port(&self, scheme: Scheme, port: u16) -> bool {
        #[cfg(test)]
        if let Some(allowance) = &self.test_allowance
            && allowance.port == port
        {
            return true;
        }
        matches!((scheme, port), (Scheme::Http, 80) | (Scheme::Https, 443))
    }

    /// Validate a URL before any network access.
    pub fn check_url(&self, raw: &str) -> Result<FetchTarget, FetchError> {
        if raw.len() > MAX_URL_BYTES {
            return Err(FetchError::UrlInvalid);
        }
        let url = Url::parse(raw).map_err(|_| FetchError::UrlInvalid)?;
        self.check_parsed(url)
    }

    /// Validate an already parsed URL (a redirect `Location` joined to the
    /// current URL goes through here).
    pub fn check_parsed(&self, mut url: Url) -> Result<FetchTarget, FetchError> {
        if url.as_str().len() > MAX_URL_BYTES {
            return Err(FetchError::UrlInvalid);
        }
        let scheme = match url.scheme() {
            "http" => Scheme::Http,
            "https" => Scheme::Https,
            _ => return Err(FetchError::SchemeForbidden),
        };
        // Userinfo is refused before the host is inspected: it enables
        // credential smuggling and host confusion (`a@b` reaches `b`).
        if !url.username().is_empty() || url.password().is_some() {
            return Err(FetchError::CredentialsForbidden);
        }
        // WHATWG parsing already normalised every IPv4 spelling (hex, octal,
        // integer, shortened) into `Host::Ipv4`, so classification sees the
        // address the socket layer would dial.
        let host = match url.host() {
            Some(Host::Ipv4(ip)) => TargetHost::Ip(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) => TargetHost::Ip(IpAddr::V6(ip)),
            Some(Host::Domain(name)) if !name.is_empty() => TargetHost::Domain(name.to_owned()),
            _ => return Err(FetchError::UrlInvalid),
        };
        if let TargetHost::Ip(ip) = host
            && !self.allows_address(ip)
        {
            return Err(FetchError::DestinationForbidden);
        }
        let port = url.port_or_known_default().ok_or(FetchError::UrlInvalid)?;
        if !self.allows_port(scheme, port) {
            return Err(FetchError::PortForbidden);
        }
        // The fragment never leaves the client.
        url.set_fragment(None);
        Ok(FetchTarget {
            url,
            scheme,
            host,
            port,
        })
    }

    /// Validate the complete answer of the single resolution of a host: the
    /// fetch is refused if the answer is empty or if ANY address is not
    /// allowed, so a mixed answer cannot be used to reach a private address.
    pub fn check_resolved(&self, addresses: &[IpAddr]) -> Result<(), FetchError> {
        if addresses.is_empty() {
            return Err(FetchError::DnsNoAddress);
        }
        if addresses.iter().all(|&ip| self.allows_address(ip)) {
            Ok(())
        } else {
            Err(FetchError::DestinationForbidden)
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn policy() -> DestinationPolicy {
        DestinationPolicy::public_internet()
    }

    #[test]
    fn accepts_public_http_and_https_urls() {
        let target = policy()
            .check_url("https://example.org/feed.xml?x=1#frag")
            .expect("public https URL is accepted");
        assert_eq!(target.scheme(), Scheme::Https);
        assert_eq!(target.port(), 443);
        assert_eq!(target.host(), &TargetHost::Domain("example.org".to_owned()));

        let target = policy()
            .check_url("http://EXAMPLE.org:80/feed")
            .expect("explicit default port is accepted");
        assert_eq!(target.port(), 80);
        assert_eq!(target.host(), &TargetHost::Domain("example.org".to_owned()));

        let target = policy()
            .check_url("https://8.8.8.8/feed")
            .expect("public IP literal is accepted");
        assert_eq!(target.host(), &TargetHost::Ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn refuses_schemes_other_than_http_and_https() {
        for url in [
            "ftp://example.org/x",
            "file:///etc/passwd",
            "data:text/plain,hi",
            "gopher://example.org/",
            "javascript:alert(1)",
            "ws://example.org/",
        ] {
            assert_eq!(
                policy().check_url(url),
                Err(FetchError::SchemeForbidden),
                "{url}"
            );
        }
    }

    #[test]
    fn refuses_credentials_in_the_url() {
        for url in [
            "https://user:pass@example.org/",
            "https://user@example.org/",
            "https://:pass@example.org/",
        ] {
            assert_eq!(
                policy().check_url(url),
                Err(FetchError::CredentialsForbidden),
                "{url}"
            );
        }
    }

    #[test]
    fn refuses_non_default_ports() {
        for url in [
            "http://example.org:8080/",
            "https://example.org:8443/",
            "http://example.org:443/",
            "https://example.org:80/",
            "http://example.org:22/",
        ] {
            assert_eq!(
                policy().check_url(url),
                Err(FetchError::PortForbidden),
                "{url}"
            );
        }
    }

    #[test]
    fn refuses_private_ip_literals_in_every_spelling() {
        for url in [
            "http://127.0.0.1/",
            "http://localhost.127.0.0.1.nip.invalid@127.0.0.1/",
            "http://0x7f.0.0.1/",
            "http://2130706433/",
            "http://0177.0.0.1/",
            "http://127.1/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:7f00:1]/",
            "http://[64:ff9b::a00:1]/",
            "http://169.254.169.254/latest/meta-data",
            "http://[fe80::1]/",
            "http://0.0.0.0/",
        ] {
            let result = policy().check_url(url);
            assert!(
                matches!(
                    result,
                    Err(FetchError::DestinationForbidden) | Err(FetchError::CredentialsForbidden)
                ),
                "{url} gave {result:?}"
            );
        }
        // The userinfo spelling is refused before the host is even looked at.
        assert_eq!(
            policy().check_url("http://localhost.127.0.0.1.nip.invalid@127.0.0.1/"),
            Err(FetchError::CredentialsForbidden)
        );
    }

    #[test]
    fn refuses_malformed_and_oversized_urls() {
        for url in [
            "",
            "not a url",
            "https://",
            "http://[::1",
            "http://exa mple.org/",
        ] {
            let result = policy().check_url(url);
            assert!(
                matches!(result, Err(FetchError::UrlInvalid)),
                "{url:?} gave {result:?}"
            );
        }
        let long = format!("https://example.org/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(policy().check_url(&long), Err(FetchError::UrlInvalid));
    }

    #[test]
    fn resolved_answer_is_refused_if_empty_or_if_any_address_is_private() {
        let public: IpAddr = "93.184.216.34".parse().unwrap();
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let mapped: IpAddr = "::ffff:10.0.0.1".parse().unwrap();
        assert_eq!(policy().check_resolved(&[public]), Ok(()));
        assert_eq!(policy().check_resolved(&[]), Err(FetchError::DnsNoAddress));
        assert_eq!(
            policy().check_resolved(&[public, loopback]),
            Err(FetchError::DestinationForbidden)
        );
        assert_eq!(
            policy().check_resolved(&[mapped, public]),
            Err(FetchError::DestinationForbidden)
        );
    }

    #[test]
    fn test_allowance_widens_only_the_listed_address_and_port() {
        let allowed: IpAddr = "127.0.0.1".parse().unwrap();
        let policy = DestinationPolicy::for_tests(vec![allowed], 4242);
        assert!(policy.check_url("http://127.0.0.1:4242/").is_ok());
        assert_eq!(
            policy.check_url("http://127.0.0.2:4242/"),
            Err(FetchError::DestinationForbidden)
        );
        assert_eq!(
            policy.check_url("http://127.0.0.1:4243/"),
            Err(FetchError::PortForbidden)
        );
        assert_eq!(
            policy.check_resolved(&["::1".parse().unwrap()]),
            Err(FetchError::DestinationForbidden)
        );
    }
}
