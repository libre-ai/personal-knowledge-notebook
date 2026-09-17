wit_bindgen::generate!({
    world: "notebook-core",
    path: "../../vendored/wit/notebook-core-v2",
});

use self::exports::libre_ai::notebook_core::api as wit_api;
use zeroize::Zeroizing;

use crate::{
    Argon2idParameters as CoreArgon2idParameters, ErrorCode as CoreErrorCode,
    SealBackupRequest as CoreSealBackupRequest, canonicalize_context, open_backup, seal_backup,
};

struct NotebookCoreComponent;

impl wit_api::Guest for NotebookCoreComponent {
    fn canonicalize_context(document: Vec<u8>) -> Result<Vec<u8>, wit_api::ErrorCode> {
        let document = Zeroizing::new(document);
        canonicalize_context(document.as_slice()).map_err(to_wit_error)
    }

    fn seal_backup(
        request: wit_api::SealBackupRequest,
        recovery_secret: Vec<u8>,
    ) -> Result<Vec<u8>, wit_api::ErrorCode> {
        seal_backup(
            CoreSealBackupRequest {
                schema_version: request.schema_version,
                id: request.id,
                cipher: request.cipher,
                kdf: CoreArgon2idParameters {
                    algorithm: request.kdf.algorithm,
                    version: request.kdf.version,
                    memory_kib: request.kdf.memory_kib,
                    iterations: request.kdf.iterations,
                    parallelism: request.kdf.parallelism,
                    output_length_bytes: request.kdf.output_length_bytes,
                    salt: request.kdf.salt,
                },
                nonce: request.nonce,
                plaintext: request.plaintext,
            },
            recovery_secret,
        )
        .map_err(to_wit_error)
    }

    fn open_backup(
        envelope: Vec<u8>,
        recovery_secret: Vec<u8>,
    ) -> Result<wit_api::OpenedBackup, wit_api::ErrorCode> {
        open_backup(&envelope, recovery_secret)
            .map(|mut opened| wit_api::OpenedBackup {
                schema_version: std::mem::take(&mut opened.schema_version),
                id: std::mem::take(&mut opened.id),
                digest: std::mem::take(&mut opened.digest),
                plaintext: std::mem::take(&mut opened.plaintext),
            })
            .map_err(to_wit_error)
    }
}

fn to_wit_error(error: CoreErrorCode) -> wit_api::ErrorCode {
    match error {
        CoreErrorCode::InvalidDocument => wit_api::ErrorCode::InvalidDocument,
        CoreErrorCode::InvalidSealRequest => wit_api::ErrorCode::InvalidSealRequest,
        CoreErrorCode::InvalidEnvelope => wit_api::ErrorCode::InvalidEnvelope,
        CoreErrorCode::UnsupportedVersion => wit_api::ErrorCode::UnsupportedVersion,
        CoreErrorCode::ResourceLimitExceeded => wit_api::ErrorCode::ResourceLimitExceeded,
        CoreErrorCode::AuthenticationFailed => wit_api::ErrorCode::AuthenticationFailed,
        CoreErrorCode::InternalFailure => wit_api::ErrorCode::InternalFailure,
    }
}

export!(NotebookCoreComponent);
