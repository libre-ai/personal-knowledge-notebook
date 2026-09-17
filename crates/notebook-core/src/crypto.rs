use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use argon2::{Algorithm, Argon2, Block, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::canonical::serialize_jcs;
use crate::error::ErrorCode;
use crate::model::{ENVELOPE_SCHEMA_VERSION, EnvelopeKdf, KDF_ALGORITHM};
use crate::validate::{GCM_TAG_BYTES, KEY_BYTES};

const AAD_DOMAIN: &[u8] = b"libre-ai.notebook-backup.v2/aad";
const DIGEST_DOMAIN: &[u8] = b"libre-ai.notebook-backup.v2/digest";
const JCS_METADATA_RESERVE: usize = 1024;
const CANONICAL_SUFFIX_CAPACITY: usize = 512;
const BODY_PREFIX: &[u8] = b"{\"cipher\":\"aes-256-gcm\",\"ciphertext\":\"";
const DIGEST_FIELD_PREFIX: &[u8] = b"\",\"digest\":\"";

pub(crate) fn derive_key(
    recovery_secret: &[u8],
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, ErrorCode> {
    let params = Params::new(memory_kib, iterations, parallelism, Some(KEY_BYTES))
        .map_err(|_| ErrorCode::InternalFailure)?;
    let block_count = params.block_count();
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut memory = Zeroizing::new(Vec::<Block>::new());
    memory
        .try_reserve_exact(block_count)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    memory.resize(block_count, Block::default());

    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    argon2
        .hash_password_into_with_memory(recovery_secret, salt, key.as_mut(), memory.as_mut_slice())
        .map_err(|_| ErrorCode::InternalFailure)?;
    Ok(key)
}

pub(crate) fn encrypt_in_place(
    plaintext: &mut Zeroizing<Vec<u8>>,
    key: &[u8; KEY_BYTES],
    nonce: &[u8],
    aad: &[u8],
) -> Result<(), ErrorCode> {
    plaintext
        .try_reserve_exact(GCM_TAG_BYTES)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ErrorCode::InternalFailure)?;
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(nonce), aad, plaintext.as_mut())
        .map_err(|_| ErrorCode::InternalFailure)?;
    plaintext.extend_from_slice(tag.as_slice());
    Ok(())
}

pub(crate) fn decrypt_in_place(
    ciphertext_and_tag: &mut Zeroizing<Vec<u8>>,
    key: &[u8; KEY_BYTES],
    nonce: &[u8],
    aad: &[u8],
) -> bool {
    let encrypted_len = ciphertext_and_tag.len() - GCM_TAG_BYTES;
    let mut tag_bytes = [0u8; GCM_TAG_BYTES];
    tag_bytes.copy_from_slice(&ciphertext_and_tag[encrypted_len..]);
    ciphertext_and_tag.truncate(encrypted_len);

    let Ok(cipher) = Aes256Gcm::new_from_slice(key) else {
        return false;
    };
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(nonce),
            aad,
            ciphertext_and_tag.as_mut(),
            Tag::from_slice(&tag_bytes),
        )
        .is_ok()
}

pub(crate) fn aad_for_metadata<T: Serialize>(metadata: &T) -> Result<Vec<u8>, ErrorCode> {
    let canonical = serialize_jcs(metadata, JCS_METADATA_RESERVE)?;
    domain_preimage(AAD_DOMAIN, &canonical)
}

pub(crate) fn digest_for_body(
    id: &str,
    kdf: &EnvelopeKdf,
    nonce: &str,
    ciphertext: &str,
) -> Result<[u8; 32], ErrorCode> {
    let suffix = canonical_body_suffix(id, kdf, nonce)?;
    Ok(digest_body_parts(ciphertext.as_bytes(), &suffix))
}

pub(crate) fn encode_sealed_envelope(
    id: &str,
    kdf: &EnvelopeKdf,
    nonce: &str,
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, ErrorCode> {
    let suffix = canonical_body_suffix(id, kdf, nonce)?;
    let encoded_len = base64::encoded_len(ciphertext_and_tag.len(), true)
        .ok_or(ErrorCode::ResourceLimitExceeded)?;
    let suffix_tail_len = suffix
        .len()
        .checked_sub(1)
        .ok_or(ErrorCode::InternalFailure)?;
    let capacity = BODY_PREFIX
        .len()
        .checked_add(encoded_len)
        .and_then(|length| length.checked_add(DIGEST_FIELD_PREFIX.len()))
        .and_then(|length| length.checked_add(64 + 1))
        .and_then(|length| length.checked_add(suffix_tail_len))
        .ok_or(ErrorCode::ResourceLimitExceeded)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(capacity)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    output.extend_from_slice(BODY_PREFIX);
    let encoded_start = output.len();
    output.resize(encoded_start + encoded_len, 0);
    let written = STANDARD
        .encode_slice(ciphertext_and_tag, &mut output[encoded_start..])
        .map_err(|_| ErrorCode::InternalFailure)?;
    if written != encoded_len {
        return Err(ErrorCode::InternalFailure);
    }

    let digest = digest_body_parts(&output[encoded_start..], &suffix);
    output.extend_from_slice(DIGEST_FIELD_PREFIX);
    append_sha256_hex(&mut output, &digest);
    output.push(b'"');
    output.extend_from_slice(&suffix[1..]);
    Ok(output)
}

pub(crate) fn digest_matches(actual_hex: &str, expected: &[u8; 32]) -> bool {
    parse_sha256_hex(actual_hex)
        .map(|actual| bool::from(actual.ct_eq(expected)))
        .unwrap_or(false)
}

pub(crate) fn sha256_hex(value: &[u8; 32]) -> Result<String, ErrorCode> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::new();
    output
        .try_reserve_exact(64)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    for byte in value {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(output)
}

pub(crate) fn encode_base64(value: &[u8]) -> Result<String, ErrorCode> {
    let length = base64::encoded_len(value.len(), true).ok_or(ErrorCode::ResourceLimitExceeded)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(length)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    output.resize(length, 0);
    let written = STANDARD
        .encode_slice(value, &mut output)
        .map_err(|_| ErrorCode::InternalFailure)?;
    output.truncate(written);
    String::from_utf8(output).map_err(|_| ErrorCode::InternalFailure)
}

pub(crate) fn canonical_base64_decoded_len(value: &str) -> Option<usize> {
    if value.is_empty() || !value.len().is_multiple_of(4) {
        return None;
    }
    let bytes = value.as_bytes();
    let padding = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };
    let data_len = bytes.len().checked_sub(padding)?;
    if data_len == 0
        || bytes[..data_len]
            .iter()
            .any(|byte| base64_value(*byte).is_none())
        || bytes[data_len..].iter().any(|byte| *byte != b'=')
        || (padding == 2 && base64_value(bytes[data_len - 1])? & 0x0f != 0)
        || (padding == 1 && base64_value(bytes[data_len - 1])? & 0x03 != 0)
    {
        return None;
    }
    bytes
        .len()
        .checked_div(4)?
        .checked_mul(3)?
        .checked_sub(padding)
}

pub(crate) fn decode_canonical_base64(value: &str) -> Result<Vec<u8>, ErrorCode> {
    let estimated = base64::decoded_len_estimate(value.len());
    let mut decoded = Vec::new();
    decoded
        .try_reserve_exact(estimated)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    decoded.resize(estimated, 0);
    let written = STANDARD
        .decode_slice(value.as_bytes(), &mut decoded)
        .map_err(|_| ErrorCode::InvalidEnvelope)?;
    decoded.truncate(written);
    // STANDARD requires canonical padding and rejects non-zero trailing bits,
    // making successful decoding equivalent to the contract's decode/re-encode check.
    Ok(decoded)
}

fn domain_preimage(domain: &[u8], canonical: &[u8]) -> Result<Vec<u8>, ErrorCode> {
    let length = domain
        .len()
        .checked_add(1)
        .and_then(|length| length.checked_add(canonical.len()))
        .ok_or(ErrorCode::ResourceLimitExceeded)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(length)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    output.extend_from_slice(domain);
    output.push(0);
    output.extend_from_slice(canonical);
    Ok(output)
}

fn canonical_body_suffix(id: &str, kdf: &EnvelopeKdf, nonce: &str) -> Result<Vec<u8>, ErrorCode> {
    // Every variable string has already passed a closed alphabet validator:
    // opaque lowercase-hex URN, fixed algorithm names, or canonical Base64.
    // The exact JCS order therefore needs no escaping.
    let mut suffix = Vec::new();
    suffix
        .try_reserve_exact(CANONICAL_SUFFIX_CAPACITY)
        .map_err(|_| ErrorCode::ResourceLimitExceeded)?;
    suffix.extend_from_slice(b"\",\"id\":\"");
    suffix.extend_from_slice(id.as_bytes());
    suffix.extend_from_slice(b"\",\"kdf\":{\"algorithm\":\"");
    suffix.extend_from_slice(KDF_ALGORITHM.as_bytes());
    suffix.extend_from_slice(b"\",\"iterations\":");
    push_u32(&mut suffix, kdf.iterations);
    suffix.extend_from_slice(b",\"memoryKiB\":");
    push_u32(&mut suffix, kdf.memory_kib);
    suffix.extend_from_slice(b",\"outputLengthBytes\":");
    push_u32(&mut suffix, kdf.output_length_bytes);
    suffix.extend_from_slice(b",\"parallelism\":");
    push_u32(&mut suffix, kdf.parallelism);
    suffix.extend_from_slice(b",\"salt\":\"");
    suffix.extend_from_slice(kdf.salt.as_bytes());
    suffix.extend_from_slice(b"\",\"version\":");
    push_u32(&mut suffix, kdf.version);
    suffix.extend_from_slice(b"},\"nonce\":\"");
    suffix.extend_from_slice(nonce.as_bytes());
    suffix.extend_from_slice(b"\",\"schemaVersion\":\"");
    suffix.extend_from_slice(ENVELOPE_SCHEMA_VERSION.as_bytes());
    suffix.extend_from_slice(b"\"}");
    Ok(suffix)
}

fn digest_body_parts(ciphertext_base64: &[u8], suffix: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DIGEST_DOMAIN);
    hasher.update([0]);
    hasher.update(BODY_PREFIX);
    hasher.update(ciphertext_base64);
    hasher.update(suffix);
    hasher.finalize().into()
}

fn append_sha256_hex(output: &mut Vec<u8>, value: &[u8; 32]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in value {
        output.push(HEX[usize::from(byte >> 4)]);
        output.push(HEX[usize::from(byte & 0x0f)]);
    }
}

fn push_u32(output: &mut Vec<u8>, mut value: u32) {
    let mut digits = [0u8; 10];
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    output.extend_from_slice(&digits[start..]);
}

const fn base64_value(value: u8) -> Option<u8> {
    match value {
        b'A'..=b'Z' => Some(value - b'A'),
        b'a'..=b'z' => Some(value - b'a' + 26),
        b'0'..=b'9' => Some(value - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn parse_sha256_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut output = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Some(output)
}

const fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;

    use super::{
        canonical_base64_decoded_len, decode_canonical_base64, digest_for_body, digest_matches,
        encode_base64, encode_sealed_envelope, sha256_hex,
    };
    use crate::ErrorCode;
    use crate::model::{ENVELOPE_SCHEMA_VERSION, EnvelopeKdf, KDF_ALGORITHM};

    #[test]
    fn accepts_only_canonical_padded_base64() {
        let value = b"canonical bytes!";
        let encoded = encode_base64(value).unwrap();
        assert_eq!(decode_canonical_base64(&encoded).unwrap(), value);
        assert_eq!(
            decode_canonical_base64(encoded.trim_end_matches('=')),
            Err(ErrorCode::InvalidEnvelope)
        );
        assert_eq!(
            decode_canonical_base64("Y2Fub25pY2FsIGJ5dGVz\n"),
            Err(ErrorCode::InvalidEnvelope)
        );
        assert_eq!(
            decode_canonical_base64("Zh=="),
            Err(ErrorCode::InvalidEnvelope)
        );
        assert_eq!(
            canonical_base64_decoded_len("Y2Fub25pY2FsIGJ5dGVzIQ=="),
            Some(16)
        );
        assert_eq!(
            canonical_base64_decoded_len("Y2Fub25pY2FsIGJ5dGVzIQ="),
            None
        );
        assert_eq!(canonical_base64_decoded_len("Zh=="), None);
        assert_eq!(canonical_base64_decoded_len("Zg=="), Some(1));
        assert_eq!(canonical_base64_decoded_len("Zm8="), Some(2));
        assert_eq!(canonical_base64_decoded_len("Zm9v"), Some(3));
    }

    #[test]
    fn manual_envelope_emission_matches_generic_jcs_at_kdf_boundaries() {
        for (memory_kib, iterations, parallelism, fill, ciphertext_len) in
            [(65_536, 3, 1, 0x11, 17), (131_072, 4, 4, 0xee, 4_097)]
        {
            let id = format!("urn:libre-ai:backup:{}", format!("{fill:02x}").repeat(16));
            let salt = STANDARD.encode([fill; 16]);
            let nonce = STANDARD.encode([fill.wrapping_add(1); 12]);
            let ciphertext = vec![fill; ciphertext_len];
            let ciphertext_base64 = STANDARD.encode(&ciphertext);
            let kdf = EnvelopeKdf {
                algorithm: Cow::Borrowed(KDF_ALGORITHM),
                version: 19,
                memory_kib,
                iterations,
                parallelism,
                output_length_bytes: 32,
                salt: Cow::Borrowed(&salt),
            };
            let digest =
                sha256_hex(&digest_for_body(&id, &kdf, &nonce, &ciphertext_base64).unwrap())
                    .unwrap();
            let generic = serde_jcs::to_vec(&json!({
                "schemaVersion": ENVELOPE_SCHEMA_VERSION,
                "id": id.clone(),
                "cipher": "aes-256-gcm",
                "kdf": {
                    "algorithm": KDF_ALGORITHM,
                    "version": 19,
                    "memoryKiB": memory_kib,
                    "iterations": iterations,
                    "parallelism": parallelism,
                    "outputLengthBytes": 32,
                    "salt": salt.clone(),
                },
                "nonce": nonce.clone(),
                "ciphertext": ciphertext_base64.clone(),
                "digest": digest,
            }))
            .unwrap();
            assert_eq!(
                encode_sealed_envelope(&id, &kdf, &nonce, &ciphertext).unwrap(),
                generic
            );
        }
    }

    #[test]
    fn formats_and_compares_lowercase_sha256() {
        let digest = [0xabu8; 32];
        let encoded = sha256_hex(&digest).unwrap();
        assert_eq!(encoded, "ab".repeat(32));
        assert!(digest_matches(&encoded, &digest));
        assert!(!digest_matches(&"AB".repeat(32), &digest));
    }
}
