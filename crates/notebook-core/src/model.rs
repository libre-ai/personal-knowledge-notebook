use std::borrow::Cow;
use std::fmt;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const SEAL_REQUEST_SCHEMA_VERSION: &str = "libre-ai.notebook-backup-seal-request.v2";
pub const ENVELOPE_SCHEMA_VERSION: &str = "libre-ai.notebook-backup.v2";
pub const CIPHER: &str = "aes-256-gcm";
pub const KDF_ALGORITHM: &str = "argon2id";

#[derive(Clone, Debug, Eq, PartialEq, Zeroize)]
pub struct Argon2idParameters {
    pub algorithm: String,
    pub version: u32,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub output_length_bytes: u32,
    pub salt: Vec<u8>,
}

#[derive(Eq, PartialEq, Zeroize, ZeroizeOnDrop)]
pub struct SealBackupRequest {
    pub schema_version: String,
    pub id: String,
    pub cipher: String,
    pub kdf: Argon2idParameters,
    pub nonce: Vec<u8>,
    pub plaintext: Vec<u8>,
}

#[derive(Eq, PartialEq, Zeroize, ZeroizeOnDrop)]
pub struct OpenedBackup {
    pub schema_version: String,
    pub id: String,
    pub digest: String,
    pub plaintext: Vec<u8>,
}

impl fmt::Debug for OpenedBackup {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenedBackup")
            .field("schema_version", &self.schema_version)
            .field("id", &self.id)
            .field("digest", &self.digest)
            .field("plaintext_bytes", &self.plaintext.len())
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnvelopeKdf<'a> {
    #[serde(borrow)]
    pub algorithm: Cow<'a, str>,
    pub version: u32,
    #[serde(rename = "memoryKiB")]
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub output_length_bytes: u32,
    #[serde(borrow)]
    pub salt: Cow<'a, str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvelopeMetadataRef<'a> {
    pub schema_version: &'a str,
    pub id: &'a str,
    pub cipher: &'a str,
    pub kdf: &'a EnvelopeKdf<'a>,
    pub nonce: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Envelope<'a> {
    #[serde(borrow)]
    pub schema_version: Cow<'a, str>,
    #[serde(borrow)]
    pub id: Cow<'a, str>,
    #[serde(borrow)]
    pub cipher: Cow<'a, str>,
    #[serde(borrow)]
    pub kdf: EnvelopeKdf<'a>,
    #[serde(borrow)]
    pub nonce: Cow<'a, str>,
    #[serde(borrow)]
    pub ciphertext: Cow<'a, str>,
    #[serde(borrow)]
    pub digest: Cow<'a, str>,
}

impl Envelope<'_> {
    pub(crate) fn metadata(&self) -> EnvelopeMetadataRef<'_> {
        EnvelopeMetadataRef {
            schema_version: &self.schema_version,
            id: &self.id,
            cipher: &self.cipher,
            kdf: &self.kdf,
            nonce: &self.nonce,
        }
    }
}
