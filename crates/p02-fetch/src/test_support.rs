//! Fixture HTTP server and scripted resolver for the adversarial tests.
//!
//! The server speaks just enough HTTP/1.1 to stand in for hostile origins: it
//! records every connection it accepts, so a test can prove that a forbidden
//! destination received zero connections, not merely that the fetch failed.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::VecDeque;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::resolver::{ResolveFuture, Resolver};

/// What the fixture sends back for one request.
pub(crate) enum Reply {
    /// Raw bytes, written at once, then the connection is closed.
    Raw(Vec<u8>),
    /// A head, then `chunk` every `every`, `count` times (slow loris body).
    Trickle {
        head: Vec<u8>,
        chunk: Vec<u8>,
        every: Duration,
        count: usize,
    },
    /// Accept, read the request, then hold the connection silently.
    Silent(Duration),
    /// Hold the connection for `delay`, then reply.
    Delayed(Duration, Vec<u8>),
}

pub(crate) fn response(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\n").into_bytes();
    for (name, value) in headers {
        out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    );
    out.extend_from_slice(body);
    out
}

pub(crate) fn ok(body: &[u8]) -> Reply {
    Reply::Raw(response(
        "200 OK",
        &[("Content-Type", "application/rss+xml".to_owned())],
        body,
    ))
}

pub(crate) fn redirect(location: &str) -> Reply {
    Reply::Raw(response(
        "302 Found",
        &[("Location", location.to_owned())],
        b"",
    ))
}

type Responder = dyn Fn(&str) -> Reply + Send + Sync;

/// A fixture origin bound to one socket address.
pub(crate) struct FixtureServer {
    addr: SocketAddr,
    connections: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl FixtureServer {
    pub(crate) async fn bind(
        addr: SocketAddr,
        responder: impl Fn(&str) -> Reply + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        Ok(Self::serve(listener, Arc::new(responder)))
    }

    /// A fixture origin speaking TLS with `config`.
    pub(crate) async fn bind_tls(
        addr: SocketAddr,
        config: rustls::ServerConfig,
        responder: impl Fn(&str) -> Reply + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        Ok(Self::serve_with(
            listener,
            Arc::new(responder),
            Some(tokio_rustls::TlsAcceptor::from(Arc::new(config))),
        ))
    }

    fn serve(listener: TcpListener, responder: Arc<Responder>) -> Self {
        Self::serve_with(listener, responder, None)
    }

    fn serve_with(
        listener: TcpListener,
        responder: Arc<Responder>,
        tls: Option<tokio_rustls::TlsAcceptor>,
    ) -> Self {
        let addr = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let task = {
            let (connections, active, peak, requests) = (
                connections.clone(),
                active.clone(),
                peak.clone(),
                requests.clone(),
            );
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    connections.fetch_add(1, Ordering::SeqCst);
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    let (active, requests, responder, tls) = (
                        active.clone(),
                        requests.clone(),
                        responder.clone(),
                        tls.clone(),
                    );
                    tokio::spawn(async move {
                        match tls {
                            None => {
                                let _ = handle(stream, &*responder, &requests).await;
                            }
                            Some(acceptor) => {
                                if let Ok(stream) = acceptor.accept(stream).await {
                                    let _ = handle(stream, &*responder, &requests).await;
                                }
                            }
                        }
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            })
        };
        Self {
            addr,
            connections,
            active,
            peak,
            requests,
            task,
        }
    }

    pub(crate) fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub(crate) fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    pub(crate) fn peak_concurrency(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }

    pub(crate) fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    #[allow(dead_code)]
    pub(crate) fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    responder: &Responder,
    requests: &Mutex<Vec<String>>,
) -> io::Result<()> {
    let mut head = Vec::new();
    let mut buffer = [0_u8; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || head.len() > 16 * 1024 {
            return Ok(());
        }
        head.extend_from_slice(&buffer[..read]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    requests.lock().unwrap().push(head.clone());
    match responder(&head) {
        Reply::Raw(bytes) => stream.write_all(&bytes).await?,
        Reply::Trickle {
            head,
            chunk,
            every,
            count,
        } => {
            stream.write_all(&head).await?;
            for _ in 0..count {
                tokio::time::sleep(every).await;
                stream.write_all(&chunk).await?;
            }
        }
        Reply::Silent(hold) => tokio::time::sleep(hold).await,
        Reply::Delayed(delay, bytes) => {
            tokio::time::sleep(delay).await;
            stream.write_all(&bytes).await?;
        }
    }
    stream.shutdown().await
}

/// Bind a benign origin on 127.0.0.1 and a "secret" origin on [::1] on the
/// SAME port, so a host name answered first with one and then with the other
/// (DNS rebinding) would reach the secret origin through the same URL.
pub(crate) async fn bind_twin(
    benign: impl Fn(&str) -> Reply + Send + Sync + 'static,
    secret: impl Fn(&str) -> Reply + Send + Sync + 'static,
) -> (FixtureServer, FixtureServer) {
    let benign: Arc<Responder> = Arc::new(benign);
    let secret: Arc<Responder> = Arc::new(secret);
    for _ in 0..50 {
        let v4 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = v4.local_addr().unwrap().port();
        if let Ok(v6) = TcpListener::bind(SocketAddr::new("::1".parse().unwrap(), port)).await {
            return (
                FixtureServer::serve(v4, benign),
                FixtureServer::serve(v6, secret),
            );
        }
    }
    panic!("no port free on both 127.0.0.1 and ::1");
}

/// A resolver that returns scripted answers in order and counts its calls.
pub(crate) struct ScriptedResolver {
    answers: Mutex<VecDeque<Vec<IpAddr>>>,
    calls: AtomicUsize,
}

impl ScriptedResolver {
    pub(crate) fn new(answers: Vec<Vec<IpAddr>>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            calls: AtomicUsize::new(0),
        })
    }

    /// The same answer for every query.
    pub(crate) fn always(answer: Vec<IpAddr>) -> Arc<Self> {
        Self::new(std::iter::repeat_n(answer, 1000).collect())
    }

    pub(crate) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Resolver for ScriptedResolver {
    fn resolve<'a>(&'a self, _host: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.answers
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "script exhausted"))
        })
    }
}

/// Resolver adapter so a test can keep its own handle on the script.
pub(crate) struct Shared(pub(crate) Arc<ScriptedResolver>);

impl Resolver for Shared {
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
        self.0.resolve(host)
    }
}

pub(crate) fn ip(text: &str) -> IpAddr {
    text.parse().unwrap()
}

/// A throwaway PKI for the TLS tests: one CA, and leaf certificates either
/// issued by it or self-signed.
pub(crate) struct TestPki {
    ca: rcgen::Issuer<'static, rcgen::KeyPair>,
    ca_der: CertificateDer<'static>,
}

impl TestPki {
    pub(crate) fn new() -> Self {
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "p02 test root");
        let key = rcgen::KeyPair::generate().unwrap();
        let ca = params.self_signed(&key).unwrap();
        Self {
            ca_der: ca.der().clone(),
            ca: rcgen::Issuer::new(params, key),
        }
    }

    pub(crate) fn roots(&self) -> rustls::RootCertStore {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(self.ca_der.clone()).unwrap();
        roots
    }

    /// A server configuration for `name`, issued by the test CA or self-signed.
    pub(crate) fn server_config(&self, name: &str, issued_by_ca: bool) -> rustls::ServerConfig {
        let params = rcgen::CertificateParams::new(vec![name.to_owned()]).unwrap();
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = if issued_by_ca {
            params.signed_by(&key, &self.ca).unwrap()
        } else {
            params.self_signed(&key).unwrap()
        };
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
        rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], key_der)
        .unwrap()
    }
}
