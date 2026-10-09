//! Bounded body reading and decoding (G5).
//!
//! The decoded size is counted while it is produced, so a compression bomb is
//! stopped after at most `bound` bytes of output: the decoder writes into a
//! sink that refuses the first byte past the bound.

use std::io::{self, Write};

use bytes::Bytes;
use flate2::write::{GzDecoder, ZlibDecoder};
use http::HeaderMap;
use http::header::CONTENT_ENCODING;
use http_body_util::BodyExt;

use crate::error::FetchError;

/// Content codings the fetcher accepts. Anything else is refused rather than
/// stored undecoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Coding {
    Identity,
    Gzip,
    Deflate,
}

pub(crate) fn coding_of(headers: &HeaderMap) -> Result<Coding, FetchError> {
    let mut values = headers.get_all(CONTENT_ENCODING).iter();
    let Some(first) = values.next() else {
        return Ok(Coding::Identity);
    };
    if values.next().is_some() {
        return Err(FetchError::EncodingUnsupported);
    }
    let value = first
        .to_str()
        .map_err(|_| FetchError::EncodingUnsupported)?
        .trim()
        .to_ascii_lowercase();
    match value.as_str() {
        "" | "identity" => Ok(Coding::Identity),
        "gzip" | "x-gzip" => Ok(Coding::Gzip),
        "deflate" => Ok(Coding::Deflate),
        _ => Err(FetchError::EncodingUnsupported),
    }
}

/// A sink that accepts at most `bound` bytes.
struct BoundedSink {
    buffer: Vec<u8>,
    bound: u64,
    exceeded: bool,
}

impl BoundedSink {
    fn new(bound: u64) -> Self {
        Self {
            buffer: Vec::new(),
            bound,
            exceeded: false,
        }
    }

    fn remaining(&self) -> u64 {
        self.bound.saturating_sub(self.buffer.len() as u64)
    }
}

impl Write for BoundedSink {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.len() as u64 > self.remaining() {
            self.exceeded = true;
            return Err(io::Error::other("decoded body bound exceeded"));
        }
        self.buffer.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

enum Decoder {
    Identity(BoundedSink),
    Gzip(GzDecoder<BoundedSink>),
    Deflate(ZlibDecoder<BoundedSink>),
}

impl Decoder {
    fn new(coding: Coding, bound: u64) -> Self {
        let sink = BoundedSink::new(bound);
        match coding {
            Coding::Identity => Self::Identity(sink),
            Coding::Gzip => Self::Gzip(GzDecoder::new(sink)),
            Coding::Deflate => Self::Deflate(ZlibDecoder::new(sink)),
        }
    }

    fn sink(&self) -> &BoundedSink {
        match self {
            Self::Identity(sink) => sink,
            Self::Gzip(decoder) => decoder.get_ref(),
            Self::Deflate(decoder) => decoder.get_ref(),
        }
    }

    fn classify(&self) -> FetchError {
        if self.sink().exceeded {
            FetchError::BodyTooLarge
        } else {
            FetchError::DecodingFailed
        }
    }

    fn push(&mut self, data: &[u8]) -> Result<(), FetchError> {
        let written = match self {
            Self::Identity(sink) => sink.write_all(data),
            Self::Gzip(decoder) => decoder.write_all(data),
            Self::Deflate(decoder) => decoder.write_all(data),
        };
        written.map_err(|_| self.classify())
    }

    fn finish(self) -> Result<Vec<u8>, FetchError> {
        match self {
            Self::Identity(sink) => Ok(sink.buffer),
            Self::Gzip(mut decoder) => match decoder.try_finish() {
                Ok(()) => decoder
                    .finish()
                    .map(|sink| sink.buffer)
                    .map_err(|_| FetchError::DecodingFailed),
                Err(_) => Err(Self::Gzip(decoder).classify()),
            },
            Self::Deflate(mut decoder) => match decoder.try_finish() {
                Ok(()) => decoder
                    .finish()
                    .map(|sink| sink.buffer)
                    .map_err(|_| FetchError::DecodingFailed),
                Err(_) => Err(Self::Deflate(decoder).classify()),
            },
        }
    }
}

/// Read `body` to its end, decoding `coding`, refusing as soon as either the
/// transferred or the decoded size passes `bound`.
pub(crate) async fn read_bounded<B>(
    mut body: B,
    coding: Coding,
    bound: u64,
) -> Result<Bytes, FetchError>
where
    B: http_body::Body<Data = Bytes> + Unpin,
{
    let mut decoder = Decoder::new(coding, bound);
    let mut transferred: u64 = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| FetchError::HttpProtocol)?;
        let Ok(data) = frame.into_data() else {
            // Trailers carry nothing the worker uses.
            continue;
        };
        transferred = transferred.saturating_add(data.len() as u64);
        if transferred > bound {
            return Err(FetchError::BodyTooLarge);
        }
        decoder.push(&data)?;
    }
    decoder.finish().map(Bytes::from)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::{GzEncoder, ZlibEncoder};
    use http::HeaderValue;
    use http_body_util::Full;

    use super::*;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    #[tokio::test]
    async fn decodes_identity_gzip_and_deflate_within_the_bound() {
        let plain = b"<rss><channel><title>t</title></channel></rss>".repeat(100);
        let got = read_bounded(
            Full::new(Bytes::from(plain.clone())),
            Coding::Identity,
            1 << 20,
        )
        .await
        .unwrap();
        assert_eq!(got.as_ref(), plain.as_slice());

        let got = read_bounded(Full::new(Bytes::from(gzip(&plain))), Coding::Gzip, 1 << 20)
            .await
            .unwrap();
        assert_eq!(got.as_ref(), plain.as_slice());

        let mut zlib = ZlibEncoder::new(Vec::new(), Compression::best());
        zlib.write_all(&plain).unwrap();
        let got = read_bounded(
            Full::new(Bytes::from(zlib.finish().unwrap())),
            Coding::Deflate,
            1 << 20,
        )
        .await
        .unwrap();
        assert_eq!(got.as_ref(), plain.as_slice());
    }

    #[tokio::test]
    async fn a_compression_bomb_is_stopped_at_the_decoded_bound() {
        // 64 MiB of zeros compresses to about 64 KiB.
        let bomb = gzip(&vec![0_u8; 64 * 1024 * 1024]);
        assert!(bomb.len() < 128 * 1024);
        let result = read_bounded(Full::new(Bytes::from(bomb)), Coding::Gzip, 1024 * 1024).await;
        assert_eq!(result, Err(FetchError::BodyTooLarge));
    }

    #[tokio::test]
    async fn a_body_exactly_at_the_bound_is_accepted_and_one_byte_more_is_refused() {
        let at = vec![b'x'; 4096];
        assert!(
            read_bounded(Full::new(Bytes::from(at.clone())), Coding::Identity, 4096)
                .await
                .is_ok()
        );
        assert!(
            read_bounded(Full::new(Bytes::from(gzip(&at))), Coding::Gzip, 4096)
                .await
                .is_ok()
        );
        let over = vec![b'x'; 4097];
        assert_eq!(
            read_bounded(Full::new(Bytes::from(over.clone())), Coding::Identity, 4096).await,
            Err(FetchError::BodyTooLarge)
        );
        assert_eq!(
            read_bounded(Full::new(Bytes::from(gzip(&over))), Coding::Gzip, 4096).await,
            Err(FetchError::BodyTooLarge)
        );
    }

    #[tokio::test]
    async fn corrupt_compressed_data_is_a_decoding_failure() {
        let result = read_bounded(
            Full::new(Bytes::from_static(b"not gzip at all")),
            Coding::Gzip,
            1024,
        )
        .await;
        assert_eq!(result, Err(FetchError::DecodingFailed));
        let mut truncated = gzip(b"hello world hello world");
        truncated.truncate(truncated.len() - 6);
        let result = read_bounded(Full::new(Bytes::from(truncated)), Coding::Gzip, 1024).await;
        assert_eq!(result, Err(FetchError::DecodingFailed));
    }

    #[test]
    fn only_identity_gzip_and_deflate_are_accepted() {
        let mut headers = HeaderMap::new();
        assert_eq!(coding_of(&headers), Ok(Coding::Identity));
        for (value, expected) in [
            ("gzip", Ok(Coding::Gzip)),
            ("X-GZIP", Ok(Coding::Gzip)),
            ("deflate", Ok(Coding::Deflate)),
            ("identity", Ok(Coding::Identity)),
            ("br", Err(FetchError::EncodingUnsupported)),
            ("zstd", Err(FetchError::EncodingUnsupported)),
            ("gzip, gzip", Err(FetchError::EncodingUnsupported)),
        ] {
            headers.insert(CONTENT_ENCODING, HeaderValue::from_static(value));
            assert_eq!(coding_of(&headers), expected, "{value}");
        }
        headers.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        headers.append(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        assert_eq!(coding_of(&headers), Err(FetchError::EncodingUnsupported));
    }
}
