#![deny(unsafe_code)]

use std::borrow::Cow;

mod canonical;
#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
mod component;
mod crypto;
mod error;
mod model;
#[cfg(all(feature = "qualification-faults", target_arch = "wasm32"))]
#[allow(unsafe_code)]
mod qualification_allocator;
#[cfg(feature = "qualification-faults")]
mod qualification_faults;
mod validate;

use zeroize::Zeroizing;

use crate::canonical::canonicalize_context_document;
use crate::crypto::{
    aad_for_metadata, canonical_base64_decoded_len, decode_canonical_base64, decrypt_in_place,
    derive_key, digest_for_body, digest_matches, encode_base64, encode_sealed_envelope,
    encrypt_in_place,
};
use crate::model::{
    CIPHER, ENVELOPE_SCHEMA_VERSION, Envelope, EnvelopeKdf, EnvelopeMetadataRef, KDF_ALGORITHM,
};
use crate::validate::{
    MAX_ENVELOPE_BYTES, valid_secret_length, validate_envelope_before_decode,
    validate_envelope_decoded_lengths,
};

pub use crate::error::ErrorCode;
pub use crate::model::{Argon2idParameters, OpenedBackup, SealBackupRequest};
pub use crate::validate::{
    KEY_BYTES, MAX_CIPHERTEXT_BYTES, MAX_CONTEXT_CONTENT_BYTES, MAX_CONTEXT_DOCUMENT_BYTES,
    MAX_PLAINTEXT_BYTES, MAX_RECOVERY_SECRET_BYTES, MIN_CIPHERTEXT_BYTES, MIN_PLAINTEXT_BYTES,
    MIN_RECOVERY_SECRET_BYTES, NONCE_BYTES, SALT_BYTES,
};

const INVALID_SECRET: [u8; MIN_RECOVERY_SECRET_BYTES] = [0u8; MIN_RECOVERY_SECRET_BYTES];

pub fn canonicalize_context(document: &[u8]) -> Result<Vec<u8>, ErrorCode> {
    canonicalize_context_document(document)
}

pub fn seal_backup(
    mut request: SealBackupRequest,
    recovery_secret: Vec<u8>,
) -> Result<Vec<u8>, ErrorCode> {
    let recovery_secret = Zeroizing::new(recovery_secret);
    let mut ciphertext_and_tag = Zeroizing::new(std::mem::take(&mut request.plaintext));
    validate::validate_seal_request(
        &request,
        ciphertext_and_tag.len(),
        recovery_secret.as_slice(),
    )?;
    #[cfg(feature = "qualification-faults")]
    qualification_faults::trigger(&request.id);

    let encoded_salt = encode_base64(&request.kdf.salt)?;
    let encoded_nonce = encode_base64(&request.nonce)?;
    let envelope_kdf = EnvelopeKdf {
        algorithm: Cow::Borrowed(KDF_ALGORITHM),
        version: request.kdf.version,
        memory_kib: request.kdf.memory_kib,
        iterations: request.kdf.iterations,
        parallelism: request.kdf.parallelism,
        output_length_bytes: request.kdf.output_length_bytes,
        salt: Cow::Owned(encoded_salt),
    };
    let metadata = EnvelopeMetadataRef {
        schema_version: ENVELOPE_SCHEMA_VERSION,
        id: &request.id,
        cipher: CIPHER,
        kdf: &envelope_kdf,
        nonce: &encoded_nonce,
    };
    #[cfg(feature = "qualification-faults")]
    qualification_faults::arm_jcs_allocation(&request.id);
    let aad = aad_for_metadata(&metadata)?;
    #[cfg(feature = "qualification-faults")]
    qualification_faults::arm_argon2_allocation(&request.id);
    let key = derive_key(
        recovery_secret.as_slice(),
        &request.kdf.salt,
        request.kdf.memory_kib,
        request.kdf.iterations,
        request.kdf.parallelism,
    )?;

    encrypt_in_place(&mut ciphertext_and_tag, &key, &request.nonce, &aad)?;
    encode_sealed_envelope(
        &request.id,
        &envelope_kdf,
        &encoded_nonce,
        ciphertext_and_tag.as_slice(),
    )
}

pub fn open_backup(
    envelope_bytes: &[u8],
    recovery_secret: Vec<u8>,
) -> Result<OpenedBackup, ErrorCode> {
    let recovery_secret = Zeroizing::new(recovery_secret);
    if envelope_bytes.is_empty() || envelope_bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(ErrorCode::InvalidEnvelope);
    }
    #[cfg(feature = "qualification-faults")]
    qualification_faults::arm_serde_allocation(envelope_bytes);
    let envelope: Envelope =
        serde_json::from_slice(envelope_bytes).map_err(|_| ErrorCode::InvalidEnvelope)?;
    validate_envelope_before_decode(&envelope)?;
    #[cfg(feature = "qualification-faults")]
    qualification_faults::trigger(&envelope.id);
    let salt_len =
        canonical_base64_decoded_len(&envelope.kdf.salt).ok_or(ErrorCode::InvalidEnvelope)?;
    let nonce_len =
        canonical_base64_decoded_len(&envelope.nonce).ok_or(ErrorCode::InvalidEnvelope)?;
    let ciphertext_len =
        canonical_base64_decoded_len(&envelope.ciphertext).ok_or(ErrorCode::InvalidEnvelope)?;
    validate_envelope_decoded_lengths(salt_len, nonce_len, ciphertext_len)?;
    let salt = decode_canonical_base64(&envelope.kdf.salt)?;
    let nonce = decode_canonical_base64(&envelope.nonce)?;

    #[cfg(feature = "qualification-faults")]
    qualification_faults::arm_jcs_allocation(&envelope.id);
    let expected_digest = digest_for_body(
        &envelope.id,
        &envelope.kdf,
        &envelope.nonce,
        &envelope.ciphertext,
    )?;
    let digest_valid = digest_matches(&envelope.digest, &expected_digest);
    let aad = aad_for_metadata(&envelope.metadata())?;

    let invalid_secret = Zeroizing::new(INVALID_SECRET);
    let secret_valid = valid_secret_length(recovery_secret.len());
    let secret_for_kdf = if secret_valid {
        recovery_secret.as_slice()
    } else {
        invalid_secret.as_slice()
    };
    #[cfg(feature = "qualification-faults")]
    qualification_faults::arm_argon2_allocation(&envelope.id);
    let key = derive_key(
        secret_for_kdf,
        &salt,
        envelope.kdf.memory_kib,
        envelope.kdf.iterations,
        envelope.kdf.parallelism,
    )?;

    let ciphertext = decode_canonical_base64(&envelope.ciphertext)?;
    validate_envelope_decoded_lengths(salt.len(), nonce.len(), ciphertext.len())?;
    let mut plaintext = Zeroizing::new(ciphertext);
    let tag_valid = decrypt_in_place(&mut plaintext, &key, &nonce, &aad);
    if !(digest_valid & tag_valid & secret_valid) {
        return Err(ErrorCode::AuthenticationFailed);
    }

    // This is the only deliberate escape from a Zeroizing buffer: both the
    // digest and GCM tag are valid, and plaintext is the WIT success payload.
    Ok(OpenedBackup {
        schema_version: envelope.schema_version.into_owned(),
        id: envelope.id.into_owned(),
        digest: envelope.digest.into_owned(),
        plaintext: std::mem::take(&mut *plaintext),
    })
}
