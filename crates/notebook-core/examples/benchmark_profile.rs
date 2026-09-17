use std::error::Error;
use std::time::Instant;

use libre_ai_notebook_core::{
    Argon2idParameters, MAX_PLAINTEXT_BYTES, SealBackupRequest, open_backup, seal_backup,
};

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let plaintext_bytes = arguments
        .next()
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(1024 * 1024);
    let memory_kib = arguments
        .next()
        .map(|value| value.parse::<u32>())
        .transpose()?
        .unwrap_or(65_536);
    let iterations = arguments
        .next()
        .map(|value| value.parse::<u32>())
        .transpose()?
        .unwrap_or(3);
    let parallelism = arguments
        .next()
        .map(|value| value.parse::<u32>())
        .transpose()?
        .unwrap_or(1);
    if arguments.next().is_some() {
        return Err(
            "usage: benchmark_profile [plaintext-bytes] [memory-kib] [iterations] [parallelism]"
                .into(),
        );
    }
    if !(1..=MAX_PLAINTEXT_BYTES).contains(&plaintext_bytes) {
        return Err("plaintext byte count is outside the locked v2 bounds".into());
    }

    let plaintext = vec![0x5au8; plaintext_bytes];
    let expected = plaintext.clone();
    let secret = (32u8..48).collect::<Vec<_>>();
    let request = SealBackupRequest {
        schema_version: "libre-ai.notebook-backup-seal-request.v2".to_owned(),
        id: "urn:libre-ai:backup:000102030405060708090a0b0c0d0e0f".to_owned(),
        cipher: "aes-256-gcm".to_owned(),
        kdf: Argon2idParameters {
            algorithm: "argon2id".to_owned(),
            version: 19,
            memory_kib,
            iterations,
            parallelism,
            output_length_bytes: 32,
            salt: (0u8..16).collect(),
        },
        nonce: (16u8..28).collect(),
        plaintext,
    };

    let seal_started = Instant::now();
    let envelope = seal_backup(request, secret.clone()).map_err(|error| format!("{error:?}"))?;
    let seal_elapsed = seal_started.elapsed();

    let open_started = Instant::now();
    let opened = open_backup(&envelope, secret).map_err(|error| format!("{error:?}"))?;
    let open_elapsed = open_started.elapsed();
    if opened.plaintext != expected {
        return Err("benchmark round-trip mismatch".into());
    }

    println!(
        "Notebook Core public benchmark: plaintext={} envelope={} seal_ms={} open_ms={} m={} t={} p={}",
        plaintext_bytes,
        envelope.len(),
        seal_elapsed.as_millis(),
        open_elapsed.as_millis(),
        memory_kib,
        iterations,
        parallelism,
    );
    Ok(())
}
