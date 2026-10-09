//! Adversarial corpus of the safe fetcher (AT-34 and AT-37, local part).
//!
//! Each test drives the real fetcher against fixture origins on loopback.
//! The test policy treats 127.0.0.1 and the fixture port as "public" — that
//! is the only widening — so every other address keeps its production
//! classification; in particular `[::1]` stays a forbidden destination and
//! hosts the "secret" origin that must never receive a connection.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use flate2::Compression;
use flate2::write::GzEncoder;

use crate::error::FetchError;
use crate::fetcher::{FetchOutcome, FetchRequest, SafeFetcher, Validators, next_hop};
use crate::limits::{BodyKind, FEED_BODY_CEILING, FetchLimits};
use crate::policy::DestinationPolicy;
use crate::test_support::{
    FixtureServer, Reply, ScriptedResolver, Shared, TestPki, bind_twin, ip, ok, redirect, response,
};

const BENIGN: &[u8] = b"<rss version=\"2.0\"><channel><title>benign</title></channel></rss>";
const SECRET: &[u8] = b"secret internal document";

fn limits() -> FetchLimits {
    FetchLimits::tightened(Duration::from_millis(500), Duration::from_secs(5), 3, None).unwrap()
}

fn fetcher(port: u16, resolver: &Arc<ScriptedResolver>, limits: FetchLimits) -> SafeFetcher {
    let policy = DestinationPolicy::for_tests(vec![ip("127.0.0.1")], port);
    SafeFetcher::for_tests(
        policy,
        Arc::new(Shared(resolver.clone())),
        rustls::RootCertStore::empty(),
        limits,
    )
    .unwrap()
}

fn tls_fetcher(port: u16, resolver: &Arc<ScriptedResolver>, pki: &TestPki) -> SafeFetcher {
    let policy = DestinationPolicy::for_tests(vec![ip("127.0.0.1")], port);
    SafeFetcher::for_tests(
        policy,
        Arc::new(Shared(resolver.clone())),
        pki.roots(),
        limits(),
    )
    .unwrap()
}

fn get(url: String) -> FetchRequest {
    FetchRequest {
        url,
        kind: BodyKind::Feed,
        validators: Validators::default(),
    }
}

async fn twin() -> (FixtureServer, FixtureServer) {
    bind_twin(|_| ok(BENIGN), |_| ok(SECRET)).await
}

fn body_of(outcome: FetchOutcome) -> Vec<u8> {
    match outcome {
        FetchOutcome::Body { body, .. } => body.to_vec(),
        other => panic!("expected a body, got {other:?}"),
    }
}

#[tokio::test]
async fn dns_rebinding_cannot_reach_the_second_answer() {
    // First answer: the allowed origin. Second answer: [::1], where the
    // secret origin listens on the same port. A fetcher that validated the
    // first answer and resolved again to connect would read SECRET.
    let (benign, secret) = twin().await;
    let port = benign.addr().port();
    let resolver = ScriptedResolver::new(vec![vec![ip("127.0.0.1")], vec![ip("::1")]]);
    let fetcher = fetcher(port, &resolver, limits());

    let outcome = fetcher
        .fetch(&get(format!("http://rebind.test:{port}/feed")))
        .await
        .unwrap();
    assert_eq!(body_of(outcome), BENIGN);
    assert_eq!(resolver.calls(), 1, "exactly one resolution per hop");
    assert_eq!(benign.connections(), 1);

    // The next resolution returns the private answer: refused before dialling.
    let refused = fetcher
        .fetch(&get(format!("http://rebind.test:{port}/feed")))
        .await;
    assert_eq!(refused, Err(FetchError::DestinationForbidden));
    assert_eq!(resolver.calls(), 2);
    assert_eq!(
        secret.connections(),
        0,
        "the secret origin was never reached"
    );
}

#[tokio::test]
async fn an_answer_mixing_public_and_private_addresses_is_refused_whole() {
    let (benign, secret) = twin().await;
    let port = benign.addr().port();
    for answer in [
        vec![ip("127.0.0.1"), ip("::1")],
        vec![ip("::1"), ip("127.0.0.1")],
        vec![ip("127.0.0.1"), ip("10.0.0.1")],
        vec![ip("127.0.0.1"), ip("169.254.169.254")],
    ] {
        let resolver = ScriptedResolver::always(answer.clone());
        let result = fetcher(port, &resolver, limits())
            .fetch(&get(format!("http://mixed.test:{port}/")))
            .await;
        assert_eq!(result, Err(FetchError::DestinationForbidden), "{answer:?}");
    }
    assert_eq!(
        benign.connections(),
        0,
        "nothing is dialled from a refused answer"
    );
    assert_eq!(secret.connections(), 0);
}

#[tokio::test]
async fn ipv4_mapped_and_nat64_answers_are_refused() {
    let (benign, secret) = twin().await;
    let port = benign.addr().port();
    // Each of these reaches 127.0.0.1 (or a private v4) through IPv6
    // spelling; the allowance for the plain IPv4 address must not leak.
    for answer in [
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",
        "::127.0.0.1",
    ] {
        let resolver = ScriptedResolver::always(vec![ip(answer)]);
        let result = fetcher(port, &resolver, limits())
            .fetch(&get(format!("http://mapped.test:{port}/")))
            .await;
        assert_eq!(result, Err(FetchError::DestinationForbidden), "{answer}");
    }
    for literal in ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[64:ff9b::7f00:1]"] {
        let resolver = ScriptedResolver::new(vec![]);
        let result = fetcher(port, &resolver, limits())
            .fetch(&get(format!("http://{literal}:{port}/")))
            .await;
        assert_eq!(result, Err(FetchError::DestinationForbidden), "{literal}");
        assert_eq!(resolver.calls(), 0, "an IP literal is never resolved");
    }
    assert_eq!(benign.connections(), 0);
    assert_eq!(secret.connections(), 0);
}

#[tokio::test]
async fn redirects_to_private_or_forbidden_targets_are_refused_before_dialling() {
    for (location, expected, answer) in [
        (
            "http://[::1]:{port}/",
            FetchError::DestinationForbidden,
            None,
        ),
        (
            "http://[::ffff:127.0.0.1]:{port}/",
            FetchError::DestinationForbidden,
            None,
        ),
        (
            "http://169.254.169.254/latest/meta-data",
            FetchError::DestinationForbidden,
            None,
        ),
        (
            "http://10.0.0.1:{port}/",
            FetchError::DestinationForbidden,
            None,
        ),
        (
            "http://internal.test:{port}/",
            FetchError::DestinationForbidden,
            Some("::1"),
        ),
        (
            "http://internal.test:{port}/",
            FetchError::DestinationForbidden,
            Some("192.168.1.1"),
        ),
        ("file:///etc/passwd", FetchError::SchemeForbidden, None),
        (
            "gopher://127.0.0.1:{port}/",
            FetchError::SchemeForbidden,
            None,
        ),
        (
            // Userinfo is refused before the host is looked at; the host is a
            // documentation name so the tree-wide secret gate reads it as an
            // example, which it is.
            "http://user:pw@localhost:{port}/",
            FetchError::CredentialsForbidden,
            None,
        ),
        ("http://127.0.0.1:1/", FetchError::PortForbidden, None),
    ] {
        let (benign, secret) = bind_twin(
            {
                let location = location.to_owned();
                move |head: &str| {
                    if head.starts_with("GET /start ") {
                        let port = head
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("Host: ")
                                    .or_else(|| line.strip_prefix("host: "))
                            })
                            .and_then(|host| host.rsplit(':').next())
                            .unwrap()
                            .to_owned();
                        redirect(&location.replace("{port}", &port))
                    } else {
                        ok(BENIGN)
                    }
                }
            },
            |_| ok(SECRET),
        )
        .await;
        let port = benign.addr().port();
        let resolver = match answer {
            Some(answer) => ScriptedResolver::always(vec![ip(answer)]),
            None => ScriptedResolver::new(vec![]),
        };
        let result = fetcher(port, &resolver, limits())
            .fetch(&get(format!("http://127.0.0.1:{port}/start")))
            .await;
        assert_eq!(result, Err(expected), "{location}");
        assert_eq!(
            benign.connections(),
            1,
            "{location}: only the first hop connected"
        );
        assert_eq!(secret.connections(), 0, "{location}");
    }
}

#[tokio::test]
async fn a_benign_redirect_is_followed_and_reported() {
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |head: &str| {
        if head.starts_with("GET /old ") {
            redirect("/new?x=1")
        } else {
            ok(BENIGN)
        }
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let outcome = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/old")))
        .await
        .unwrap();
    let FetchOutcome::Body { meta, body } = outcome else {
        panic!("expected a body");
    };
    assert_eq!(body.as_ref(), BENIGN);
    assert_eq!(meta.redirects, 1);
    assert_eq!(meta.final_url.path(), "/new");
    assert_eq!(meta.final_url.query(), Some("x=1"));
}

#[tokio::test]
async fn the_redirect_bound_stops_a_redirect_loop() {
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |_| redirect("/again"))
        .await
        .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let result = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/")))
        .await;
    assert_eq!(result, Err(FetchError::RedirectLimit));
    assert_eq!(
        server.connections(),
        4,
        "the first request and three redirects"
    );
}

#[test]
fn an_https_to_http_redirect_is_a_downgrade() {
    let policy = DestinationPolicy::public_internet();
    let current = policy.check_url("https://example.org/feed").unwrap();
    assert_eq!(
        next_hop(&policy, &current, "http://example.org/feed"),
        Err(FetchError::RedirectDowngrade)
    );
    assert!(next_hop(&policy, &current, "https://example.net/feed").is_ok());
    assert_eq!(
        next_hop(&policy, &current, "http://[::1]/"),
        Err(FetchError::DestinationForbidden)
    );
    let plain = policy.check_url("http://example.org/feed").unwrap();
    assert!(next_hop(&policy, &plain, "https://example.org/feed").is_ok());
}

#[tokio::test]
async fn a_body_over_the_feed_ceiling_is_refused() {
    let oversized = vec![b'a'; usize::try_from(FEED_BODY_CEILING).unwrap() + 1024 * 1024];
    let declared = response("200 OK", &[], &oversized);
    let mut chunked =
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
    for piece in oversized.chunks(64 * 1024) {
        chunked.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
        chunked.extend_from_slice(piece);
        chunked.extend_from_slice(b"\r\n");
    }
    chunked.extend_from_slice(b"0\r\n\r\n");
    for reply in [declared, chunked] {
        let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), move |_| {
            Reply::Raw(reply.clone())
        })
        .await
        .unwrap();
        let port = server.addr().port();
        let resolver = ScriptedResolver::new(vec![]);
        let result = fetcher(port, &resolver, limits())
            .fetch(&get(format!("http://127.0.0.1:{port}/big")))
            .await;
        assert_eq!(result, Err(FetchError::BodyTooLarge));
    }
}

#[tokio::test]
async fn a_gzip_bomb_is_refused_at_the_decoded_bound() {
    // 200 MiB of zeros, about 200 KiB on the wire.
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    let zeros = vec![0_u8; 1024 * 1024];
    for _ in 0..200 {
        encoder.write_all(&zeros).unwrap();
    }
    let bomb = encoder.finish().unwrap();
    assert!(bomb.len() < 512 * 1024);
    let reply = response("200 OK", &[("Content-Encoding", "gzip".to_owned())], &bomb);
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), move |_| {
        Reply::Raw(reply.clone())
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let started = Instant::now();
    let result = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/bomb")))
        .await;
    assert_eq!(result, Err(FetchError::BodyTooLarge));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn a_slow_loris_body_hits_the_total_bound() {
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |_| Reply::Trickle {
        head: b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n".to_vec(),
        chunk: b"x".to_vec(),
        every: Duration::from_millis(20),
        count: 100_000,
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let limits = FetchLimits::tightened(
        Duration::from_millis(200),
        Duration::from_millis(400),
        3,
        None,
    )
    .unwrap();
    let started = Instant::now();
    let result = fetcher(port, &resolver, limits)
        .fetch(&get(format!("http://127.0.0.1:{port}/slow")))
        .await;
    assert_eq!(result, Err(FetchError::TotalTimeout));
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(400) && elapsed < Duration::from_secs(2),
        "{elapsed:?}"
    );
}

#[tokio::test]
async fn a_silent_origin_hits_the_total_bound() {
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |_| {
        Reply::Silent(Duration::from_secs(30))
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let limits = FetchLimits::tightened(
        Duration::from_millis(200),
        Duration::from_millis(300),
        3,
        None,
    )
    .unwrap();
    let result = fetcher(port, &resolver, limits)
        .fetch(&get(format!("http://127.0.0.1:{port}/")))
        .await;
    assert_eq!(result, Err(FetchError::TotalTimeout));
}

#[tokio::test]
async fn an_oversized_response_head_is_a_protocol_failure() {
    let mut head = b"HTTP/1.1 200 OK\r\n".to_vec();
    for index in 0..2000 {
        head.extend_from_slice(format!("X-Pad-{index}: {}\r\n", "p".repeat(64)).as_bytes());
    }
    head.extend_from_slice(b"Content-Length: 0\r\n\r\n");
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), move |_| {
        Reply::Raw(head.clone())
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let result = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/")))
        .await;
    assert_eq!(result, Err(FetchError::HttpProtocol));
}

#[tokio::test]
async fn an_unsupported_content_encoding_is_refused() {
    let reply = response(
        "200 OK",
        &[("Content-Encoding", "br".to_owned())],
        b"\x0b\x02\x80hello\x03",
    );
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), move |_| {
        Reply::Raw(reply.clone())
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let result = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/")))
        .await;
    assert_eq!(result, Err(FetchError::EncodingUnsupported));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn at_most_two_connections_per_host_are_open_at_once() {
    let reply = response("200 OK", &[], BENIGN);
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), move |_| {
        Reply::Delayed(Duration::from_millis(150), reply.clone())
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::always(vec![ip("127.0.0.1")]);
    let fetcher = Arc::new(fetcher(port, &resolver, limits()));
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let fetcher = fetcher.clone();
        tasks.push(tokio::spawn(async move {
            fetcher
                .fetch(&get(format!("http://one-host.test:{port}/")))
                .await
        }));
    }
    for task in tasks {
        assert!(task.await.unwrap().is_ok());
    }
    assert_eq!(server.connections(), 6);
    assert_eq!(server.peak_concurrency(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn at_most_sixteen_fetches_run_at_once_across_hosts() {
    let reply = response("200 OK", &[], BENIGN);
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), move |_| {
        Reply::Delayed(Duration::from_millis(200), reply.clone())
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::always(vec![ip("127.0.0.1")]);
    let fetcher = Arc::new(fetcher(port, &resolver, limits()));
    let mut tasks = Vec::new();
    for host in 0..24 {
        let fetcher = fetcher.clone();
        tasks.push(tokio::spawn(async move {
            fetcher
                .fetch(&get(format!("http://host-{host}.test:{port}/")))
                .await
        }));
    }
    for task in tasks {
        assert!(task.await.unwrap().is_ok());
    }
    assert_eq!(server.connections(), 24);
    assert_eq!(server.peak_concurrency(), 16);
}

#[tokio::test]
async fn validators_are_sent_and_a_304_is_reported_as_not_modified() {
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |head: &str| {
        if head.contains("If-None-Match: \"v1\"") || head.contains("if-none-match: \"v1\"") {
            Reply::Raw(
                b"HTTP/1.1 304 Not Modified\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n".to_vec(),
            )
        } else {
            Reply::Raw(response("200 OK", &[("ETag", "\"v1\"".to_owned())], BENIGN))
        }
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let fetcher = fetcher(port, &resolver, limits());
    let first = fetcher
        .fetch(&get(format!("http://127.0.0.1:{port}/")))
        .await
        .unwrap();
    let FetchOutcome::Body { meta, .. } = first else {
        panic!("expected a body");
    };
    assert_eq!(meta.etag.as_deref(), Some("\"v1\""));
    let second = fetcher
        .fetch(&FetchRequest {
            url: format!("http://127.0.0.1:{port}/"),
            kind: BodyKind::Feed,
            validators: Validators {
                etag: meta.etag,
                last_modified: None,
            },
        })
        .await
        .unwrap();
    assert!(
        matches!(second, FetchOutcome::NotModified { .. }),
        "{second:?}"
    );
    let invalid = fetcher
        .fetch(&FetchRequest {
            url: format!("http://127.0.0.1:{port}/"),
            kind: BodyKind::Feed,
            validators: Validators {
                etag: Some("\"v1\"\r\nX-Injected: 1".to_owned()),
                last_modified: None,
            },
        })
        .await;
    assert_eq!(invalid, Err(FetchError::ValidatorInvalid));
}

#[tokio::test]
async fn the_request_carries_no_personal_data_and_no_proxy_is_consulted() {
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |_| ok(BENIGN))
        .await
        .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let outcome = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/feed?q=1#fragment")))
        .await
        .unwrap();
    assert_eq!(body_of(outcome), BENIGN);
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let head = requests[0].to_ascii_lowercase();
    assert!(head.starts_with("get /feed?q=1 http/1.1\r\n"), "{head}");
    assert!(
        head.contains("user-agent: libreai-p02-worker/0.1\r\n"),
        "{head}"
    );
    assert!(!head.contains("fragment"));
    assert!(!head.contains("cookie"));
    assert!(!head.contains("authorization"));
    assert!(!head.contains("referer"));
}

#[tokio::test]
async fn a_non_success_status_is_reported_without_reading_the_body() {
    let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |_| {
        Reply::Raw(response(
            "429 Too Many Requests",
            &[("Retry-After", "120".to_owned())],
            b"slow down",
        ))
    })
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::new(vec![]);
    let outcome = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/")))
        .await
        .unwrap();
    let FetchOutcome::Status { meta } = outcome else {
        panic!("expected a status outcome");
    };
    assert_eq!(meta.status, 429);
    assert_eq!(meta.retry_after.as_deref(), Some("120"));
}

#[test]
fn error_messages_and_codes_never_carry_request_data() {
    for error in [
        FetchError::UrlInvalid,
        FetchError::DestinationForbidden,
        FetchError::RedirectLimit,
        FetchError::BodyTooLarge,
        FetchError::TotalTimeout,
        FetchError::HttpProtocol,
    ] {
        let text = format!("{error} {error:?} {}", error.code());
        assert!(
            !text.contains("http://") && !text.contains("127.0.0.1"),
            "{text}"
        );
        assert!(error.code().starts_with("fetch."));
    }
}

#[test]
fn the_production_fetcher_loads_platform_roots() {
    assert!(SafeFetcher::new(crate::fetcher::FetcherConfig::default()).is_ok());
}

#[tokio::test]
async fn tls_to_a_certificate_issued_by_a_trusted_root_succeeds() {
    let pki = TestPki::new();
    let server = FixtureServer::bind_tls(
        "127.0.0.1:0".parse().unwrap(),
        pki.server_config("feeds.test", true),
        |_| ok(BENIGN),
    )
    .await
    .unwrap();
    let port = server.addr().port();
    let resolver = ScriptedResolver::always(vec![ip("127.0.0.1")]);
    let outcome = tls_fetcher(port, &resolver, &pki)
        .fetch(&get(format!("https://feeds.test:{port}/feed")))
        .await
        .unwrap();
    assert_eq!(body_of(outcome), BENIGN);
}

#[tokio::test]
async fn tls_with_a_self_signed_or_misnamed_certificate_is_refused() {
    let pki = TestPki::new();
    for (config, name) in [
        (pki.server_config("feeds.test", false), "self-signed"),
        (pki.server_config("other.test", true), "wrong name"),
    ] {
        let server =
            FixtureServer::bind_tls("127.0.0.1:0".parse().unwrap(), config, |_| ok(SECRET))
                .await
                .unwrap();
        let port = server.addr().port();
        let resolver = ScriptedResolver::always(vec![ip("127.0.0.1")]);
        let result = tls_fetcher(port, &resolver, &pki)
            .fetch(&get(format!("https://feeds.test:{port}/feed")))
            .await;
        assert_eq!(result, Err(FetchError::TlsFailed), "{name}");
        assert!(server.requests().is_empty(), "{name}: no request was sent");
    }
}

#[tokio::test]
async fn an_https_origin_redirecting_to_http_is_refused_as_a_downgrade() {
    let pki = TestPki::new();
    let plain = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), |_| ok(SECRET))
        .await
        .unwrap();
    let port = plain.addr().port();
    // Both fixture ports are allowed, so the only reason left to refuse the
    // second hop is the https -> http downgrade itself.
    let target = format!("http://feeds.test:{port}/plain");
    let tls = FixtureServer::bind_tls(
        "127.0.0.1:0".parse().unwrap(),
        pki.server_config("feeds.test", true),
        move |_| redirect(&target),
    )
    .await
    .unwrap();
    let tls_port = tls.addr().port();
    let resolver = ScriptedResolver::always(vec![ip("127.0.0.1")]);
    let policy =
        DestinationPolicy::for_tests_with_ports(vec![ip("127.0.0.1")], vec![tls_port, port]);
    let fetcher = SafeFetcher::for_tests(
        policy,
        Arc::new(Shared(resolver.clone())),
        pki.roots(),
        limits(),
    )
    .unwrap();
    let result = fetcher
        .fetch(&get(format!("https://feeds.test:{tls_port}/")))
        .await;
    assert_eq!(result, Err(FetchError::RedirectDowngrade));
    assert_eq!(tls.connections(), 1);
    // Control: the same plain origin is reachable when nothing downgrades.
    let direct = fetcher
        .fetch(&get(format!("http://feeds.test:{port}/plain")))
        .await;
    assert_eq!(body_of(direct.unwrap()), SECRET);
    assert_eq!(
        plain.connections(),
        1,
        "the plain-text origin was reached only by the direct control fetch"
    );
}

#[tokio::test]
async fn statuses_without_a_single_safe_target_are_not_followed() {
    for status in ["300 Multiple Choices", "305 Use Proxy"] {
        let reply = response(status, &[("Location", "http://[::1]/".to_owned())], b"");
        let server = FixtureServer::bind("127.0.0.1:0".parse().unwrap(), move |_| {
            Reply::Raw(reply.clone())
        })
        .await
        .unwrap();
        let port = server.addr().port();
        let resolver = ScriptedResolver::new(vec![]);
        let outcome = fetcher(port, &resolver, limits())
            .fetch(&get(format!("http://127.0.0.1:{port}/")))
            .await
            .unwrap();
        assert!(
            matches!(outcome, FetchOutcome::Status { .. }),
            "{status}: {outcome:?}"
        );
        assert_eq!(server.connections(), 1);
    }
}

#[tokio::test]
async fn a_closed_port_is_a_connect_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let resolver = ScriptedResolver::new(vec![]);
    let result = fetcher(port, &resolver, limits())
        .fetch(&get(format!("http://127.0.0.1:{port}/")))
        .await;
    assert_eq!(result, Err(FetchError::ConnectFailed));
}
