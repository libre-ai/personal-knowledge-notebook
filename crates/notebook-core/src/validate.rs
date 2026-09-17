use crate::error::ErrorCode;
use crate::model::{
    CIPHER, ENVELOPE_SCHEMA_VERSION, Envelope, KDF_ALGORITHM, SEAL_REQUEST_SCHEMA_VERSION,
    SealBackupRequest,
};

pub const MIN_RECOVERY_SECRET_BYTES: usize = 16;
pub const MAX_RECOVERY_SECRET_BYTES: usize = 16;
pub const MIN_PLAINTEXT_BYTES: usize = 1;
pub const MAX_PLAINTEXT_BYTES: usize = 16_777_216;
pub const GCM_TAG_BYTES: usize = 16;
pub const MIN_CIPHERTEXT_BYTES: usize = MIN_PLAINTEXT_BYTES + GCM_TAG_BYTES;
pub const MAX_CIPHERTEXT_BYTES: usize = MAX_PLAINTEXT_BYTES + GCM_TAG_BYTES;
pub const SALT_BYTES: usize = 16;
pub const NONCE_BYTES: usize = 12;
pub const KEY_BYTES: usize = 32;
pub const MIN_CIPHERTEXT_BASE64_BYTES: usize = 24;
pub const MAX_CIPHERTEXT_BASE64_BYTES: usize = 22_369_644;
pub const MAX_ENVELOPE_BYTES: usize = 22_370_044;
pub const MAX_CONTEXT_DOCUMENT_BYTES: usize = 22_370_044;
pub const MAX_CONTEXT_CONTENT_BYTES: usize = 16_777_216;
pub const MAX_CONTEXT_BLOCKS: usize = 1_000;
pub const MAX_CONTEXT_LINKS_PER_BLOCK: usize = 1_000;
pub const MAX_CONTEXT_TOTAL_LINKS: usize = 16_384;
pub const MAX_CONTEXT_JSON_DEPTH: usize = 64;
pub const MAX_CONTEXT_JSON_NODES: usize = 100_000;
pub const MAX_CONTEXT_NUMBER_MAGNITUDE: f64 = 9_007_199_254_740_991.0;

pub(crate) fn validate_seal_request(
    request: &SealBackupRequest,
    plaintext_len: usize,
    recovery_secret: &[u8],
) -> Result<(), ErrorCode> {
    if request.schema_version != SEAL_REQUEST_SCHEMA_VERSION
        || request.cipher != CIPHER
        || !valid_backup_id(&request.id)
        || !valid_kdf(
            &request.kdf.algorithm,
            request.kdf.version,
            request.kdf.memory_kib,
            request.kdf.iterations,
            request.kdf.parallelism,
            request.kdf.output_length_bytes,
            request.kdf.salt.len(),
        )
        || request.nonce.len() != NONCE_BYTES
        || !(MIN_PLAINTEXT_BYTES..=MAX_PLAINTEXT_BYTES).contains(&plaintext_len)
        || !valid_secret_length(recovery_secret.len())
    {
        return Err(ErrorCode::InvalidSealRequest);
    }
    Ok(())
}

pub(crate) fn validate_envelope_before_decode(envelope: &Envelope) -> Result<(), ErrorCode> {
    if envelope.schema_version != ENVELOPE_SCHEMA_VERSION {
        return Err(ErrorCode::UnsupportedVersion);
    }
    if envelope.cipher != CIPHER
        || !valid_backup_id(&envelope.id)
        || !valid_kdf(
            &envelope.kdf.algorithm,
            envelope.kdf.version,
            envelope.kdf.memory_kib,
            envelope.kdf.iterations,
            envelope.kdf.parallelism,
            envelope.kdf.output_length_bytes,
            SALT_BYTES,
        )
        || envelope.kdf.salt.len() != 24
        || envelope.nonce.len() != 16
        || !(MIN_CIPHERTEXT_BASE64_BYTES..=MAX_CIPHERTEXT_BASE64_BYTES)
            .contains(&envelope.ciphertext.len())
        || !envelope.ciphertext.len().is_multiple_of(4)
        || !valid_digest(&envelope.digest)
    {
        return Err(ErrorCode::InvalidEnvelope);
    }
    Ok(())
}

pub(crate) fn validate_envelope_decoded_lengths(
    salt_len: usize,
    nonce_len: usize,
    ciphertext_len: usize,
) -> Result<(), ErrorCode> {
    if salt_len != SALT_BYTES
        || nonce_len != NONCE_BYTES
        || !(MIN_CIPHERTEXT_BYTES..=MAX_CIPHERTEXT_BYTES).contains(&ciphertext_len)
    {
        return Err(ErrorCode::InvalidEnvelope);
    }
    Ok(())
}

pub(crate) const fn valid_secret_length(length: usize) -> bool {
    length == MIN_RECOVERY_SECRET_BYTES
}

fn valid_kdf(
    algorithm: &str,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    output_length_bytes: u32,
    salt_len: usize,
) -> bool {
    algorithm == KDF_ALGORITHM
        && version == 19
        && (65_536..=131_072).contains(&memory_kib)
        && memory_kib.is_multiple_of(1024)
        && matches!(iterations, 3 | 4)
        && matches!(parallelism, 1 | 2 | 4)
        && output_length_bytes == KEY_BYTES as u32
        && salt_len == SALT_BYTES
}

fn valid_backup_id(value: &str) -> bool {
    valid_prefixed_hex(value, "urn:libre-ai:backup:")
}

pub(crate) fn valid_context_id(value: &str) -> bool {
    valid_prefixed_hex(value, "urn:libre-ai:context:")
}

pub(crate) fn valid_block_id(value: &str) -> bool {
    valid_prefixed_hex(value, "blk_")
}

fn valid_prefixed_hex(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
}

const fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (byte >= b'a' && byte <= b'f')
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(is_lower_hex)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_CIPHERTEXT_BASE64_BYTES, MAX_ENVELOPE_BYTES, MAX_PLAINTEXT_BYTES,
        MAX_RECOVERY_SECRET_BYTES, MIN_PLAINTEXT_BYTES, MIN_RECOVERY_SECRET_BYTES, valid_backup_id,
        valid_block_id, valid_context_id, validate_seal_request,
    };
    use crate::model::{Envelope, EnvelopeKdf};
    use crate::{Argon2idParameters, ErrorCode, SealBackupRequest};

    fn valid_request() -> SealBackupRequest {
        SealBackupRequest {
            schema_version: "libre-ai.notebook-backup-seal-request.v2".to_owned(),
            id: "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f".to_owned(),
            cipher: "aes-256-gcm".to_owned(),
            kdf: Argon2idParameters {
                algorithm: "argon2id".to_owned(),
                version: 19,
                memory_kib: 65_536,
                iterations: 3,
                parallelism: 1,
                output_length_bytes: 32,
                salt: vec![0; 16],
            },
            nonce: vec![0; 12],
            plaintext: Vec::new(),
        }
    }

    #[test]
    fn validates_only_opaque_fixed_width_ids() {
        assert!(valid_backup_id(
            "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f"
        ));
        assert!(valid_context_id(
            "urn:libre-ai:context:101112131415161718191a1b1c1d1e1f"
        ));
        assert!(valid_block_id("blk_000102030405060708090a0b0c0d0e0f"));
        assert!(!valid_backup_id("urn:libre-ai:backup:semantic"));
        assert!(!valid_backup_id(
            "urn:libre-ai:backup:000102030405060708090A0B0C0D0E0F"
        ));
        assert!(!valid_block_id("block_000102030405060708090a0b0c0d0e0f"));
    }

    #[test]
    fn enforces_every_kdf_boundary_without_adjustment() {
        let secret = [0u8; MIN_RECOVERY_SECRET_BYTES];
        for (memory_kib, iterations, parallelism) in [
            (65_536, 3, 1),
            (65_536, 4, 2),
            (131_072, 3, 4),
            (131_072, 4, 1),
        ] {
            let mut request = valid_request();
            request.kdf.memory_kib = memory_kib;
            request.kdf.iterations = iterations;
            request.kdf.parallelism = parallelism;
            assert_eq!(
                validate_seal_request(&request, MIN_PLAINTEXT_BYTES, &secret),
                Ok(())
            );
        }

        for (memory_kib, iterations, parallelism) in [
            (64_512, 3, 1),
            (65_537, 3, 1),
            (132_096, 3, 1),
            (65_536, 2, 1),
            (65_536, 5, 1),
            (65_536, 3, 3),
        ] {
            let mut request = valid_request();
            request.kdf.memory_kib = memory_kib;
            request.kdf.iterations = iterations;
            request.kdf.parallelism = parallelism;
            assert_eq!(
                validate_seal_request(&request, MIN_PLAINTEXT_BYTES, &secret),
                Err(ErrorCode::InvalidSealRequest)
            );
        }
    }

    #[test]
    fn maximum_envelope_bound_matches_the_canonical_shape() {
        let envelope = Envelope {
            schema_version: "libre-ai.notebook-backup.v2".into(),
            id: format!("urn:libre-ai:backup:{}", "a".repeat(32)).into(),
            cipher: "aes-256-gcm".into(),
            kdf: EnvelopeKdf {
                algorithm: "argon2id".into(),
                version: 19,
                memory_kib: 131_072,
                iterations: 4,
                parallelism: 4,
                output_length_bytes: 32,
                salt: format!("{}==", "A".repeat(22)).into(),
            },
            nonce: "A".repeat(16).into(),
            ciphertext: String::new().into(),
            digest: "a".repeat(64).into(),
        };
        let empty_ciphertext_envelope = serde_jcs::to_vec(&envelope).unwrap();
        assert_eq!(
            empty_ciphertext_envelope.len() + MAX_CIPHERTEXT_BASE64_BYTES,
            MAX_ENVELOPE_BYTES
        );
    }

    #[test]
    fn enforces_fixed_secret_and_plaintext_bounds() {
        let request = valid_request();
        let valid_secret = [0u8; MIN_RECOVERY_SECRET_BYTES];
        let short_secret = [0u8; MIN_RECOVERY_SECRET_BYTES - 1];
        let long_secret = [0u8; MAX_RECOVERY_SECRET_BYTES + 1];
        assert_eq!(
            validate_seal_request(&request, MAX_PLAINTEXT_BYTES, &valid_secret),
            Ok(())
        );
        assert_eq!(
            validate_seal_request(&request, 0, &valid_secret),
            Err(ErrorCode::InvalidSealRequest)
        );
        assert_eq!(
            validate_seal_request(&request, MAX_PLAINTEXT_BYTES + 1, &valid_secret),
            Err(ErrorCode::InvalidSealRequest)
        );
        assert_eq!(
            validate_seal_request(&request, MIN_PLAINTEXT_BYTES, &short_secret),
            Err(ErrorCode::InvalidSealRequest)
        );
        assert_eq!(
            validate_seal_request(&request, MIN_PLAINTEXT_BYTES, &long_secret),
            Err(ErrorCode::InvalidSealRequest)
        );
    }
}
