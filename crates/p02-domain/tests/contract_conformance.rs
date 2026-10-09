//! Conformance of the Rust p02-job-v1 implementation with the contract
//! authority, at the commit pinned in vendored/contracts/p02-job-v1.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use p02_domain::job::parse_document;
use serde_json::Value;
use sha2::{Digest, Sha256};

const VENDORED: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../vendored/contracts/p02-job-v1"
);

fn read(name: &str) -> Vec<u8> {
    std::fs::read(format!("{VENDORED}/{name}")).expect("vendored contract file is readable")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn vendored_files_are_the_pinned_authority_bytes() {
    let provenance: Value = serde_json::from_slice(&read("provenance.json")).unwrap();
    assert_eq!(provenance["authority"], "libre-ai/schemas-and-contracts");
    let commit = provenance["commit"].as_str().unwrap();
    assert!(commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()));
    let files = provenance["files"].as_array().unwrap();
    assert_eq!(files.len(), 4, "every vendored file is pinned");
    for file in files {
        let path = file["path"].as_str().unwrap();
        let digest = hex(&Sha256::digest(read(path)));
        assert_eq!(
            digest,
            file["sha256"].as_str().unwrap(),
            "{path} drifted from the pin"
        );
    }
    let mut listed: Vec<_> = files
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_owned())
        .collect();
    listed.push("provenance.json".to_owned());
    listed.sort();
    let mut present: Vec<_> = std::fs::read_dir(VENDORED)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    present.sort();
    assert_eq!(present, listed, "no unpinned file in the vendored contract");
}

#[test]
fn every_authority_vector_gets_the_authority_verdict() {
    let vectors: Value = serde_json::from_slice(&read("vectors.json")).unwrap();
    assert_eq!(vectors["schemaVersion"], "libre-ai.p02-job-vectors.v1");
    let valid = vectors["valid"].as_array().unwrap();
    let invalid = vectors["invalid"].as_array().unwrap();
    assert_eq!(
        (valid.len(), invalid.len()),
        (11, 54),
        "vector inventory of the pin"
    );
    let mut disagreements = Vec::new();
    for vector in valid {
        let bytes = serde_json::to_vec(&vector["document"]).unwrap();
        if let Err(error) = parse_document(&bytes) {
            disagreements.push(format!("refused valid {}: {error}", vector["name"]));
        }
    }
    for vector in invalid {
        let bytes = serde_json::to_vec(&vector["document"]).unwrap();
        if parse_document(&bytes).is_ok() {
            disagreements.push(format!("accepted invalid {}", vector["name"]));
        }
    }
    assert!(disagreements.is_empty(), "{disagreements:#?}");
    println!(
        "p02-job-v1 conformance: {} valid and {} invalid vectors agree",
        valid.len(),
        invalid.len()
    );
}
