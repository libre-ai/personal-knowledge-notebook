//! Address classification: is an IP a public unicast destination?
//!
//! Ported from the `feed-radar` destination policy (EUPL-1.2, same project)
//! and tightened for G4: the decision is an allowlist (IPv6 global unicast
//! `2000::/3` only) minus the IANA special-purpose blocks, so an address
//! nobody classified is refused rather than allowed. IPv4-mapped (`::ffff:0:0/96`)
//! and NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) answers are refused outright,
//! even when the embedded IPv4 is public: a DNS answer of that shape is not a
//! destination this worker has any reason to reach, and the embedded address
//! would be reached through a translator the policy cannot see.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// IANA special-purpose IPv4 blocks that are not public unicast, as
/// `(network, prefix length)`.
const IPV4_FORBIDDEN: &[(u32, u32)] = &[
    (0x0000_0000, 8),  // 0.0.0.0/8 this network
    (0x0a00_0000, 8),  // 10.0.0.0/8 private
    (0x6440_0000, 10), // 100.64.0.0/10 shared address space (CGNAT)
    (0x7f00_0000, 8),  // 127.0.0.0/8 loopback
    (0xa9fe_0000, 16), // 169.254.0.0/16 link local, cloud metadata
    (0xac10_0000, 12), // 172.16.0.0/12 private
    (0xc000_0000, 24), // 192.0.0.0/24 IETF protocol assignments
    (0xc000_0200, 24), // 192.0.2.0/24 TEST-NET-1
    (0xc01f_c400, 24), // 192.31.196.0/24 AS112-v4
    (0xc034_c100, 24), // 192.52.193.0/24 AMT
    (0xc058_6300, 24), // 192.88.99.0/24 deprecated 6to4 relay anycast
    (0xc0a8_0000, 16), // 192.168.0.0/16 private
    (0xc0af_3000, 24), // 192.175.48.0/24 direct delegation AS112
    (0xc612_0000, 15), // 198.18.0.0/15 benchmarking
    (0xc633_6400, 24), // 198.51.100.0/24 TEST-NET-2
    (0xcb00_7100, 24), // 203.0.113.0/24 TEST-NET-3
    (0xe000_0000, 4),  // 224.0.0.0/4 multicast
    (0xf000_0000, 4),  // 240.0.0.0/4 reserved, limited broadcast
];

/// Blocks inside `2000::/3` that are still not public unicast destinations.
const IPV6_FORBIDDEN_IN_GLOBAL: &[(u128, u32)] = &[
    (0x2001_0000_0000_0000_0000_0000_0000_0000, 23), // 2001::/23 IETF protocol assignments (Teredo, ORCHID, benchmarking)
    (0x2001_0db8_0000_0000_0000_0000_0000_0000, 32), // 2001:db8::/32 documentation
    (0x2002_0000_0000_0000_0000_0000_0000_0000, 16), // 2002::/16 6to4, embeds an IPv4
    (0x3fff_0000_0000_0000_0000_0000_0000_0000, 20), // 3fff::/20 documentation (RFC 9637)
];

fn in_block(value: u128, network: u128, prefix: u32, width: u32) -> bool {
    if prefix == 0 {
        return true;
    }
    let shift = width - prefix;
    (value >> shift) == (network >> shift)
}

/// True only if `ip` is provably a public unicast IPv4 address.
pub fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let value = u128::from(u32::from(ip));
    !IPV4_FORBIDDEN
        .iter()
        .any(|&(network, prefix)| in_block(value, u128::from(network), prefix, 32))
}

/// True only if `ip` is provably a public unicast IPv6 address.
pub fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let value = u128::from(ip);
    // Allowlist: global unicast 2000::/3. Everything outside it (loopback,
    // unspecified, IPv4-mapped, IPv4-compatible, NAT64, unique local, link
    // local, site local, multicast, discard) is refused by construction.
    if !in_block(value, 0x2000_0000_0000_0000_0000_0000_0000_0000, 3, 128) {
        return false;
    }
    !IPV6_FORBIDDEN_IN_GLOBAL
        .iter()
        .any(|&(network, prefix)| in_block(value, network, prefix, 128))
}

/// True only if `ip` is provably a public unicast address (fail closed).
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_ipv4(v4),
        IpAddr::V6(v6) => is_public_ipv6(v6),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("test literal parses")
    }

    #[test]
    fn refuses_every_special_purpose_ipv4_block() {
        for text in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254",
            "169.254.0.1",
            "172.16.0.0",
            "172.31.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "192.31.196.1",
            "192.52.193.1",
            "192.88.99.1",
            "192.168.1.1",
            "192.175.48.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public(ip(text)), "{text} must be refused");
        }
    }

    #[test]
    fn allows_public_ipv4_including_block_edges() {
        for text in [
            "8.8.8.8",
            "1.1.1.1",
            "11.0.0.1",
            "100.63.255.255",
            "100.128.0.0",
            "126.255.255.255",
            "128.0.0.0",
            "169.253.255.255",
            "172.15.255.255",
            "172.32.0.1",
            "198.17.255.255",
            "198.20.0.0",
            "223.255.255.255",
        ] {
            assert!(is_public(ip(text)), "{text} must be allowed");
        }
    }

    #[test]
    fn refuses_non_global_ipv6() {
        for text in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:8.8.8.8",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::808:808",
            "64:ff9b:1::1",
            "100::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "3fff::1",
        ] {
            assert!(!is_public(ip(text)), "{text} must be refused");
        }
    }

    #[test]
    fn allows_public_ipv6() {
        for text in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4007:80e::200e",
            "2001:200::1",
        ] {
            assert!(is_public(ip(text)), "{text} must be allowed");
        }
    }
}
