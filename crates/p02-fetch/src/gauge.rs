//! Count of sockets the fetcher holds open, and its high-water mark.
//!
//! A socket is counted from the moment `connect` returns until the stream is
//! dropped, so the gauge measures the bound the fetcher must hold (G5), at
//! the only place sockets are opened, rather than what a peer observes.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

#[derive(Debug, Default)]
pub(crate) struct ConnectionGauge {
    open: AtomicUsize,
    peak: AtomicUsize,
}

impl ConnectionGauge {
    pub(crate) fn open(&self) -> usize {
        self.open.load(Ordering::SeqCst)
    }

    pub(crate) fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
}

/// A TCP stream that holds one unit of its gauge while it lives.
pub(crate) struct CountedStream {
    stream: TcpStream,
    gauge: Arc<ConnectionGauge>,
}

impl CountedStream {
    pub(crate) fn new(stream: TcpStream, gauge: Arc<ConnectionGauge>) -> Self {
        let now = gauge.open.fetch_add(1, Ordering::SeqCst) + 1;
        gauge.peak.fetch_max(now, Ordering::SeqCst);
        Self { stream, gauge }
    }
}

impl Drop for CountedStream {
    fn drop(&mut self) {
        self.gauge.open.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AsyncRead for CountedStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for CountedStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
}
