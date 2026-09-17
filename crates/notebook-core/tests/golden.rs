use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use libre_ai_notebook_core::{
    Argon2idParameters, ErrorCode, SealBackupRequest, canonicalize_context, open_backup,
    seal_backup,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    golden: Golden,
    mutations: Vec<Mutation>,
    context_canonicalization: ContextCanonicalization,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    request: VectorRequest,
    recovery_secret: RecoverySecret,
    plaintext: Plaintext,
    envelope: VectorEnvelope,
    canonical_envelope_utf8: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoverySecret {
    hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plaintext {
    base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mutation {
    name: String,
    recovery_secret_hex: String,
    envelope: VectorEnvelope,
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    code: String,
    plaintext_released: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorRequest {
    schema_version: String,
    id: String,
    cipher: String,
    kdf: VectorKdf,
    nonce: String,
    plaintext: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorEnvelope {
    schema_version: String,
    id: String,
    cipher: String,
    kdf: VectorKdf,
    nonce: String,
    ciphertext: String,
    digest: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorKdf {
    algorithm: String,
    version: u32,
    #[serde(rename = "memoryKiB")]
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    output_length_bytes: u32,
    salt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextCanonicalization {
    golden: ContextGolden,
    mutations: Vec<ContextMutation>,
    resource_cases: Vec<ResourceCase>,
    numeric_cases: Vec<NumericCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextGolden {
    input_utf8: String,
    canonical_output_utf8: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextMutation {
    name: String,
    document_utf8: Option<String>,
    document_hex: Option<String>,
    expected: ContextExpected,
}

#[derive(Deserialize)]
struct ContextExpected {
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceCase {
    name: String,
    dimension: String,
    value: usize,
    expected: String,
    fixture_ordinal: usize,
    input_canonical_byte_length: usize,
    input_canonical_sha256: String,
    canonical_output_byte_length: Option<usize>,
    canonical_output_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NumericCase {
    name: String,
    input_utf8: String,
    canonical_utf8: Option<String>,
    expected: String,
}

fn load_vectors() -> Vectors {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../node_modules/@libre-ai/contracts-authority/contracts/fixtures/notebook-core-v2/golden-vectors.v1.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn decode_base64(value: &str) -> Vec<u8> {
    STANDARD.decode(value).unwrap()
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2));
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]))
        .collect()
}

fn hex_nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        _ => panic!("invalid fixture hex"),
    }
}

fn request(value: VectorRequest) -> SealBackupRequest {
    SealBackupRequest {
        schema_version: value.schema_version,
        id: value.id,
        cipher: value.cipher,
        kdf: Argon2idParameters {
            algorithm: value.kdf.algorithm,
            version: value.kdf.version,
            memory_kib: value.kdf.memory_kib,
            iterations: value.kdf.iterations,
            parallelism: value.kdf.parallelism,
            output_length_bytes: value.kdf.output_length_bytes,
            salt: decode_base64(&value.kdf.salt),
        },
        nonce: decode_base64(&value.nonce),
        plaintext: decode_base64(&value.plaintext),
    }
}

fn envelope(value: &VectorEnvelope) -> Vec<u8> {
    serde_jcs::to_vec(value).unwrap()
}

fn error_code(value: &str) -> ErrorCode {
    match value {
        "invalid-envelope" => ErrorCode::InvalidEnvelope,
        "authentication-failed" => ErrorCode::AuthenticationFailed,
        "unsupported-version" => ErrorCode::UnsupportedVersion,
        "invalid-document" => ErrorCode::InvalidDocument,
        other => panic!("unknown fixture error code: {other}"),
    }
}

fn sha256_hex(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn seals_and_opens_the_exact_golden_envelope() {
    let vectors = load_vectors();
    let secret = decode_hex(&vectors.golden.recovery_secret.hex);
    let expected_plaintext = decode_base64(&vectors.golden.plaintext.base64);

    let sealed = seal_backup(request(vectors.golden.request), secret.clone()).unwrap();
    assert_eq!(sealed, vectors.golden.canonical_envelope_utf8.as_bytes());

    let opened = open_backup(&sealed, secret).unwrap();
    assert_eq!(opened.schema_version, "libre-ai.notebook-backup.v2");
    assert_eq!(
        opened.id,
        "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f"
    );
    assert_eq!(
        opened.digest,
        "ddefc877172074fed3709ec46a804a2b76857f37e6eec586ce38a5f0011092ec"
    );
    assert_eq!(opened.plaintext, expected_plaintext);
}

#[test]
fn refuses_every_normative_backup_mutation_without_plaintext() {
    let vectors = load_vectors();
    for mutation in vectors.mutations {
        assert!(!mutation.expected.plaintext_released, "{}", mutation.name);
        assert_eq!(
            open_backup(
                &envelope(&mutation.envelope),
                decode_hex(&mutation.recovery_secret_hex),
            ),
            Err(error_code(&mutation.expected.code)),
            "{}",
            mutation.name
        );
    }
}

#[test]
fn refuses_digest_only_tampering_after_running_authentication() {
    let vectors = load_vectors();
    let mut envelope = vectors.golden.envelope;
    envelope.digest.replace_range(0..1, "0");
    assert_eq!(
        open_backup(
            &self::envelope(&envelope),
            decode_hex(&vectors.golden.recovery_secret.hex),
        ),
        Err(ErrorCode::AuthenticationFailed)
    );
}

#[test]
fn refuses_malformed_duplicate_and_unknown_envelopes() {
    let vectors = load_vectors();
    let secret = decode_hex(&vectors.golden.recovery_secret.hex);
    let canonical = vectors.golden.canonical_envelope_utf8;

    let duplicate =
        canonical.replacen("{\"cipher\":", "{\"cipher\":\"aes-256-gcm\",\"cipher\":", 1);
    assert_eq!(
        open_backup(duplicate.as_bytes(), secret.clone()),
        Err(ErrorCode::InvalidEnvelope)
    );

    let unknown = canonical.replacen('{', "{\"unexpected\":true,", 1);
    assert_eq!(
        open_backup(unknown.as_bytes(), secret.clone()),
        Err(ErrorCode::InvalidEnvelope)
    );
    assert_eq!(
        open_backup(b"not-json", secret),
        Err(ErrorCode::InvalidEnvelope)
    );
}

#[test]
fn rejects_invalid_seal_inputs_before_key_derivation() {
    let vectors = load_vectors();
    let valid_secret = decode_hex(&vectors.golden.recovery_secret.hex);

    assert_eq!(
        seal_backup(request(vectors.golden.request.clone()), vec![0u8; 15]),
        Err(ErrorCode::InvalidSealRequest)
    );
    assert_eq!(
        seal_backup(request(vectors.golden.request.clone()), vec![0u8; 17]),
        Err(ErrorCode::InvalidSealRequest)
    );

    let mut weak = request(vectors.golden.request.clone());
    weak.kdf.memory_kib = 8192;
    assert_eq!(
        seal_backup(weak, valid_secret.clone()),
        Err(ErrorCode::InvalidSealRequest)
    );

    let mut wrong_nonce = request(vectors.golden.request);
    wrong_nonce.nonce.pop();
    assert_eq!(
        seal_backup(wrong_nonce, valid_secret),
        Err(ErrorCode::InvalidSealRequest)
    );
}

#[test]
fn maps_out_of_range_open_secrets_to_authentication_failure() {
    let vectors = load_vectors();
    let envelope = vectors.golden.canonical_envelope_utf8.into_bytes();
    assert_eq!(
        open_backup(&envelope, vec![0u8; 15]),
        Err(ErrorCode::AuthenticationFailed)
    );
    assert_eq!(
        open_backup(&envelope, vec![0u8; 17]),
        Err(ErrorCode::AuthenticationFailed)
    );
}

#[test]
fn rejects_every_truncated_golden_envelope_without_panicking() {
    let vectors = load_vectors();
    let envelope = vectors.golden.canonical_envelope_utf8.into_bytes();
    let secret = decode_hex(&vectors.golden.recovery_secret.hex);
    for length in 0..envelope.len() {
        assert_eq!(
            open_backup(&envelope[..length], secret.clone()),
            Err(ErrorCode::InvalidEnvelope),
            "accepted truncated envelope at byte {length}"
        );
    }
}

#[test]
fn canonicalizes_the_exact_context_golden() {
    let vectors = load_vectors();
    let golden = vectors.context_canonicalization.golden;
    assert_eq!(
        canonicalize_context(golden.input_utf8.as_bytes()).unwrap(),
        golden.canonical_output_utf8.as_bytes()
    );
}

#[test]
fn refuses_every_normative_context_mutation() {
    let vectors = load_vectors();
    for mutation in vectors.context_canonicalization.mutations {
        let input = match (mutation.document_utf8, mutation.document_hex) {
            (Some(utf8), None) => utf8.into_bytes(),
            (None, Some(hex)) => decode_hex(&hex),
            _ => panic!("{}: malformed fixture encoding", mutation.name),
        };
        assert_eq!(
            canonicalize_context(&input),
            Err(error_code(&mutation.expected.code)),
            "{}",
            mutation.name
        );
    }
}

#[test]
fn executes_every_context_resource_boundary() {
    let vectors = load_vectors();
    for resource in vectors.context_canonicalization.resource_cases {
        let input = materialize_resource_case(&resource);
        assert_eq!(
            input.len(),
            resource.input_canonical_byte_length,
            "{}",
            resource.name
        );
        assert_eq!(
            sha256_hex(&input),
            resource.input_canonical_sha256,
            "{} input",
            resource.name
        );
        let result = canonicalize_context(&input);
        if resource.expected == "accepted" {
            let output = result.unwrap();
            assert_eq!(
                output.len(),
                resource.canonical_output_byte_length.unwrap(),
                "{} output length",
                resource.name
            );
            assert_eq!(
                sha256_hex(&output),
                resource.canonical_output_sha256.unwrap(),
                "{} output",
                resource.name
            );
        } else {
            assert_eq!(result, Err(ErrorCode::InvalidDocument), "{}", resource.name);
        }
    }
}

#[test]
fn executes_every_context_numeric_boundary() {
    let vectors = load_vectors();
    for (index, numeric) in vectors
        .context_canonicalization
        .numeric_cases
        .into_iter()
        .enumerate()
    {
        let input = context_with_json_content(index + 32, &numeric.input_utf8);
        let result = canonicalize_context(&input);
        if numeric.expected == "accepted" {
            let output: Value = serde_json::from_slice(&result.unwrap()).unwrap();
            assert_eq!(
                output["blocks"][0]["content"].as_str().unwrap(),
                numeric.canonical_utf8.unwrap(),
                "{}",
                numeric.name
            );
        } else {
            assert_eq!(result, Err(ErrorCode::InvalidDocument), "{}", numeric.name);
        }
    }
}

fn context_with_json_content(ordinal: usize, content: &str) -> Vec<u8> {
    let block_id = "blk_00000000000000000000000000000000";
    serde_jcs::to_vec(&json!({
        "schemaVersion": "libre-ai.context-document.v2",
        "id": format!("urn:libre-ai:context:{ordinal:032x}"),
        "rootBlockIds": [block_id],
        "blocks": [{
            "id": block_id,
            "mediaType": "application/json",
            "content": content,
            "links": []
        }],
        "totalBytes": content.len(),
        "digest": "0".repeat(64)
    }))
    .unwrap()
}

fn materialize_resource_case(resource: &ResourceCase) -> Vec<u8> {
    let block_ids: Vec<String> = (0..1000).map(|index| format!("blk_{index:032x}")).collect();
    let blocks = match resource.dimension.as_str() {
        "jsonDepth" => vec![json!({
            "id": block_ids[0],
            "mediaType": "application/json",
            "content": format!(
                "{}0{}",
                "[".repeat(resource.value - 1),
                "]".repeat(resource.value - 1)
            ),
            "links": []
        })],
        "jsonNodes" => vec![json!({
            "id": block_ids[0],
            "mediaType": "application/json",
            "content": format!("[{}]", vec!["0"; resource.value - 1].join(",")),
            "links": []
        })],
        "totalLinks" => {
            let mut remaining = resource.value;
            block_ids
                .iter()
                .map(|id| {
                    let count = remaining.min(1000);
                    remaining -= count;
                    json!({
                        "id": id,
                        "mediaType": "text/plain",
                        "content": "",
                        "links": &block_ids[..count]
                    })
                })
                .collect()
        }
        other => panic!("unknown resource dimension: {other}"),
    };
    let total_bytes: usize = blocks
        .iter()
        .map(|block| block["content"].as_str().unwrap().len())
        .sum();
    serde_jcs::to_vec(&json!({
        "schemaVersion": "libre-ai.context-document.v2",
        "id": format!("urn:libre-ai:context:{:032x}", resource.fixture_ordinal),
        "rootBlockIds": [&block_ids[0]],
        "blocks": blocks,
        "totalBytes": total_bytes,
        "digest": "0".repeat(64)
    }))
    .unwrap()
}
