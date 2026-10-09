//! The safe fetcher: one GET, its redirects, bounded in size, time and
//! concurrency, over connections this module dials itself.
//!
//! Why the connector is ours rather than a full HTTP client's: a client that
//! accepts a host name resolves it when it connects, after any check the
//! caller made, and may also consult proxy settings from the environment.
//! Here the only path to a socket is [`SafeFetcher::dial`], which receives
//! addresses the policy already validated from the single resolution of the
//! hop; nothing else resolves, nothing reads proxy variables, no connection is
//! pooled across hops.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use http::header::{
    ACCEPT, ACCEPT_ENCODING, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, ETAG, HOST,
    IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION, RETRY_AFTER, USER_AGENT,
};
use http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
use http_body_util::Empty;
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio_rustls::TlsConnector;
use url::Url;

use crate::body::{coding_of, read_bounded};
use crate::error::{FetchError, SetupError};
use crate::gauge::{ConnectionGauge, CountedStream};
use crate::limits::{
    BodyKind, FetchLimits, GLOBAL_CONCURRENCY, MAX_RESPONSE_HEAD_BYTES, PER_HOST_CONCURRENCY,
};
use crate::policy::{DestinationPolicy, FetchTarget, Scheme, TargetHost};
use crate::resolver::{MAX_ADDRESSES_PER_ANSWER, Resolver, SystemResolver, dedupe};

/// Longest validator or metadata header value kept.
const MAX_META_HEADER_BYTES: usize = 1024;

/// Accept header sent with every request: feed formats first, HTML for
/// discovery and page capture.
const ACCEPT_VALUE: &str = "application/rss+xml, application/atom+xml, application/feed+json, \
     application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.1";

/// Default product identification; it carries no personal data (G5).
pub const DEFAULT_USER_AGENT: &str = "LibreAI-P02-Worker/0.1";

/// Configuration of a fetcher.
#[derive(Debug, Clone)]
pub struct FetcherConfig {
    pub user_agent: String,
    pub limits: FetchLimits,
}

impl Default for FetcherConfig {
    fn default() -> Self {
        Self {
            user_agent: DEFAULT_USER_AGENT.to_owned(),
            limits: FetchLimits::production(),
        }
    }
}

/// HTTP cache validators from the previous fetch of the same URL.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// One fetch request.
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: String,
    pub kind: BodyKind,
    pub validators: Validators,
}

/// Response metadata kept for provenance (G1) and source health.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseMeta {
    /// URL of the hop that produced the final response.
    pub final_url: Url,
    pub status: u16,
    pub redirects: u8,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub retry_after: Option<String>,
}

/// Result of a completed fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchOutcome {
    /// A 2xx response and its decoded body.
    Body { meta: ResponseMeta, body: Bytes },
    /// 304: the validators still hold.
    NotModified { meta: ResponseMeta },
    /// Any other final status; the body is not read.
    Status { meta: ResponseMeta },
}

/// The safe fetcher. Cheap to share behind an `Arc`.
pub struct SafeFetcher {
    policy: DestinationPolicy,
    resolver: Arc<dyn Resolver>,
    tls: TlsConnector,
    user_agent: HeaderValue,
    limits: FetchLimits,
    global: Arc<Semaphore>,
    hosts: Mutex<HashMap<String, Arc<Semaphore>>>,
    connections: Arc<ConnectionGauge>,
}

impl SafeFetcher {
    /// Production fetcher: public internet policy, system resolver, platform
    /// trust roots.
    pub fn new(config: FetcherConfig) -> Result<Self, SetupError> {
        let mut roots = RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            // A root the platform ships but rustls cannot parse is skipped:
            // refusing every TLS origin because of one odd root would be worse.
            let _ = roots.add(certificate);
        }
        if roots.is_empty() {
            return Err(SetupError::NoTrustRoots);
        }
        Self::build(
            DestinationPolicy::public_internet(),
            Arc::new(SystemResolver),
            roots,
            config,
        )
    }

    fn build(
        policy: DestinationPolicy,
        resolver: Arc<dyn Resolver>,
        roots: RootCertStore,
        config: FetcherConfig,
    ) -> Result<Self, SetupError> {
        let user_agent =
            HeaderValue::from_str(&config.user_agent).map_err(|_| SetupError::UserAgentInvalid)?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut tls = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|_| SetupError::TlsConfig)?
            .with_root_certificates(roots)
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Self {
            policy,
            resolver,
            tls: TlsConnector::from(Arc::new(tls)),
            user_agent,
            limits: config.limits,
            global: Arc::new(Semaphore::new(GLOBAL_CONCURRENCY)),
            hosts: Mutex::new(HashMap::new()),
            connections: Arc::new(ConnectionGauge::default()),
        })
    }

    /// Test builds only: a fetcher with a widened policy, a scripted resolver
    /// and the test PKI's roots instead of the platform's.
    #[cfg(test)]
    pub(crate) fn for_tests(
        policy: DestinationPolicy,
        resolver: Arc<dyn Resolver>,
        roots: RootCertStore,
        limits: FetchLimits,
    ) -> Result<Self, SetupError> {
        Self::build(
            policy,
            resolver,
            roots,
            FetcherConfig {
                user_agent: DEFAULT_USER_AGENT.to_owned(),
                limits,
            },
        )
    }

    /// Fetch `request.url`, following at most the redirect bound, within the
    /// total time bound.
    ///
    /// Waiting for a concurrency slot counts toward the total bound: a fetch
    /// never occupies the worker longer than that bound, queued or not.
    pub async fn fetch(&self, request: &FetchRequest) -> Result<FetchOutcome, FetchError> {
        match tokio::time::timeout(self.limits.total_timeout(), self.fetch_chain(request)).await {
            Ok(result) => result,
            Err(_) => Err(FetchError::TotalTimeout),
        }
    }

    async fn fetch_chain(&self, request: &FetchRequest) -> Result<FetchOutcome, FetchError> {
        let validators = validator_headers(&request.validators)?;
        let mut target = self.policy.check_url(&request.url)?;
        let mut redirects: u8 = 0;
        loop {
            // Validators belong to the URL they were issued for: only the
            // first hop carries them.
            let hop_validators = if redirects == 0 {
                validators.as_slice()
            } else {
                &[]
            };
            let hop = self.fetch_hop(&target, hop_validators).await?;
            let status = hop.response.status();
            if is_followed_redirect(status) {
                if redirects >= self.limits.max_redirects() {
                    return Err(FetchError::RedirectLimit);
                }
                let location = hop
                    .response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or(FetchError::RedirectInvalid)?;
                target = next_hop(&self.policy, &target, location)?;
                redirects += 1;
                continue;
            }
            let meta = response_meta(&target, status, redirects, hop.response.headers());
            if status == StatusCode::NOT_MODIFIED {
                return Ok(FetchOutcome::NotModified { meta });
            }
            if !status.is_success() {
                return Ok(FetchOutcome::Status { meta });
            }
            let bound = self.limits.body_bound(request.kind);
            let headers = hop.response.headers();
            let coding = coding_of(headers)?;
            if declared_length(headers).is_some_and(|length| length > bound) {
                return Err(FetchError::BodyTooLarge);
            }
            let body = read_bounded(hop.response.into_body(), coding, bound).await?;
            return Ok(FetchOutcome::Body { meta, body });
        }
    }

    async fn fetch_hop(
        &self,
        target: &FetchTarget,
        validators: &[(http::HeaderName, HeaderValue)],
    ) -> Result<Hop, FetchError> {
        let host_key = match target.host() {
            TargetHost::Ip(ip) => ip.to_string(),
            TargetHost::Domain(name) => name.clone(),
        };
        // Host slot first, global slot second: a fetch queued behind a busy
        // host must not hold one of the global slots other hosts could use.
        let host = self.host_permit(&host_key).await?;
        let global = self
            .global
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| FetchError::Unavailable)?;
        // Declared before the stream: on an early return the stream is
        // dropped (socket closed) first, the slots second.
        let slots = Slots {
            _host: host,
            _global: global,
        };
        let addresses = match target.host() {
            TargetHost::Ip(ip) => vec![*ip],
            TargetHost::Domain(name) => {
                let answer = self
                    .resolver
                    .resolve(name)
                    .await
                    .map_err(|_| FetchError::DnsFailed)?;
                let answer = dedupe(answer);
                // The WHOLE answer is validated before anything is dialled.
                self.policy.check_resolved(&answer)?;
                answer.into_iter().take(MAX_ADDRESSES_PER_ANSWER).collect()
            }
        };
        let stream = match tokio::time::timeout(
            self.limits.connect_timeout(),
            self.dial(&addresses, target.port()),
        )
        .await
        {
            Ok(stream) => stream?,
            Err(_) => return Err(FetchError::ConnectTimeout),
        };
        let request = build_request(target, &self.user_agent, validators)?;
        let response = match target.scheme() {
            Scheme::Http => send(TokioIo::new(stream), request, slots).await?,
            Scheme::Https => {
                let server_name = match target.host() {
                    TargetHost::Ip(ip) => ServerName::IpAddress((*ip).into()),
                    TargetHost::Domain(name) => {
                        ServerName::try_from(name.clone()).map_err(|_| FetchError::TlsFailed)?
                    }
                };
                let handshake = self.tls.connect(server_name, stream);
                let tls = match tokio::time::timeout(self.limits.connect_timeout(), handshake).await
                {
                    Ok(Ok(tls)) => tls,
                    Ok(Err(_)) => return Err(FetchError::TlsFailed),
                    Err(_) => return Err(FetchError::ConnectTimeout),
                };
                send(TokioIo::new(tls), request, slots).await?
            }
        };
        Ok(Hop {
            response: response.0,
            _connection: response.1,
        })
    }

    /// The only place a socket is opened. `addresses` were validated by the
    /// policy; the connected peer is checked again before any byte is sent.
    async fn dial(&self, addresses: &[IpAddr], port: u16) -> Result<CountedStream, FetchError> {
        for &address in addresses {
            if !self.policy.allows_address(address) {
                return Err(FetchError::DestinationForbidden);
            }
            let Ok(stream) = TcpStream::connect(SocketAddr::new(address, port)).await else {
                continue;
            };
            let peer = stream.peer_addr().map_err(|_| FetchError::ConnectFailed)?;
            if !self.policy.allows_address(peer.ip()) {
                return Err(FetchError::DestinationForbidden);
            }
            let _ = stream.set_nodelay(true);
            return Ok(CountedStream::new(stream, self.connections.clone()));
        }
        Err(FetchError::ConnectFailed)
    }

    async fn host_permit(&self, key: &str) -> Result<OwnedSemaphorePermit, FetchError> {
        let semaphore = {
            let mut hosts = self.hosts.lock().unwrap_or_else(PoisonError::into_inner);
            // Drop the entries nobody holds or waits on, so the map stays
            // bounded by the hosts in flight. A slot is held by a live
            // connection task, so an entry is idle only once its sockets are
            // closed.
            hosts.retain(|_, semaphore| Arc::strong_count(semaphore) > 1);
            hosts
                .entry(key.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(PER_HOST_CONCURRENCY)))
                .clone()
        };
        semaphore
            .acquire_owned()
            .await
            .map_err(|_| FetchError::Unavailable)
    }

    /// Sockets this fetcher holds open now, and the most it ever held open
    /// at once (counted at the dial, for observability and bound checks).
    pub fn connection_counts(&self) -> (usize, usize) {
        (self.connections.open(), self.connections.peak())
    }
}

/// The host and global concurrency slots of one connection.
struct Slots {
    _host: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

/// A connection in use: its response and the task driving it.
struct Hop {
    response: http::Response<Incoming>,
    _connection: ConnectionTask,
}

/// Aborts the connection driver when the hop is dropped, so a refused or
/// timed-out fetch never leaves a socket behind.
struct ConnectionTask(JoinHandle<()>);

impl Drop for ConnectionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What the connection task owns. Fields drop in declaration order: the
/// connection (and with it the socket) first, the concurrency slots after.
/// A slot is therefore free only once its socket is closed, whether the
/// connection ended on its own or its task was aborted: the per-host and
/// global bounds count sockets, not requests in flight.
struct Driver<C> {
    connection: Pin<Box<C>>,
    _slots: Slots,
}

async fn send<I>(
    io: TokioIo<I>,
    request: Request<Empty<Bytes>>,
    slots: Slots,
) -> Result<(http::Response<Incoming>, ConnectionTask), FetchError>
where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(MAX_RESPONSE_HEAD_BYTES)
        .handshake(io)
        .await
        .map_err(|_| FetchError::HttpProtocol)?;
    let driver = Driver {
        connection: Box::pin(connection),
        _slots: slots,
    };
    let task = ConnectionTask(tokio::spawn(async move {
        // Bind the whole driver: an async block that only named
        // `driver.connection` would capture that field alone (disjoint
        // capture) and leave the slots to drop when `send` returns, before
        // the socket closes.
        let mut driver = driver;
        let _ = driver.connection.as_mut().await;
        // `driver` drops here, or wherever the task is cancelled: connection
        // first, slots second.
    }));
    let response = sender
        .send_request(request)
        .await
        .map_err(|_| FetchError::HttpProtocol)?;
    Ok((response, task))
}

fn build_request(
    target: &FetchTarget,
    user_agent: &HeaderValue,
    validators: &[(http::HeaderName, HeaderValue)],
) -> Result<Request<Empty<Bytes>>, FetchError> {
    let url = target.url();
    let mut path_and_query = url.path().to_owned();
    if let Some(query) = url.query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    let host = url.host_str().ok_or(FetchError::UrlInvalid)?;
    let host_header = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let mut builder = Request::builder()
        .method(Method::GET)
        .uri(path_and_query)
        .header(HOST, host_header)
        .header(USER_AGENT, user_agent.clone())
        .header(ACCEPT, ACCEPT_VALUE)
        .header(ACCEPT_ENCODING, "gzip, deflate")
        .header(CONNECTION, "close");
    for (name, value) in validators {
        builder = builder.header(name, value.clone());
    }
    builder
        .body(Empty::new())
        .map_err(|_| FetchError::UrlInvalid)
}

fn validator_headers(
    validators: &Validators,
) -> Result<Vec<(http::HeaderName, HeaderValue)>, FetchError> {
    let mut headers = Vec::new();
    for (name, value) in [
        (IF_NONE_MATCH, &validators.etag),
        (IF_MODIFIED_SINCE, &validators.last_modified),
    ] {
        if let Some(value) = value {
            if value.len() > MAX_META_HEADER_BYTES
                || !value.bytes().all(|byte| (0x20..0x7f).contains(&byte))
            {
                return Err(FetchError::ValidatorInvalid);
            }
            let value = HeaderValue::from_str(value).map_err(|_| FetchError::ValidatorInvalid)?;
            headers.push((name, value));
        }
    }
    Ok(headers)
}

/// Resolve and validate a redirect `Location` against the current hop.
pub(crate) fn next_hop(
    policy: &DestinationPolicy,
    current: &FetchTarget,
    location: &str,
) -> Result<FetchTarget, FetchError> {
    let joined = current
        .url()
        .join(location)
        .map_err(|_| FetchError::RedirectInvalid)?;
    let next = policy.check_parsed(joined)?;
    if current.scheme() == Scheme::Https && next.scheme() == Scheme::Http {
        return Err(FetchError::RedirectDowngrade);
    }
    Ok(next)
}

/// The redirect statuses that carry a target to follow. 300, 305 and 306 are
/// reported as a final status instead: none names a single safe target.
fn is_followed_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn meta_header(headers: &HeaderMap, name: http::HeaderName) -> Option<String> {
    let value = headers.get(name)?.to_str().ok()?;
    (value.len() <= MAX_META_HEADER_BYTES).then(|| value.to_owned())
}

fn response_meta(
    target: &FetchTarget,
    status: StatusCode,
    redirects: u8,
    headers: &HeaderMap,
) -> ResponseMeta {
    ResponseMeta {
        final_url: target.url().clone(),
        status: status.as_u16(),
        redirects,
        etag: meta_header(headers, ETAG),
        last_modified: meta_header(headers, LAST_MODIFIED),
        content_type: meta_header(headers, CONTENT_TYPE),
        retry_after: meta_header(headers, RETRY_AFTER),
    }
}
